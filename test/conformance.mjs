// Runs the official MCP conformance suite's SEP-2640 (Skills extension) server scenarios against this
// server over Streamable HTTP, at protocol 2026-07-28 and at 2025-11-25, and fails on any FAILURE.
//
// No npm release of the suite contains the skills scenarios yet, so it is fetched at a pinned commit
// and built once into ~/.cache/skills-mcp (override with SKILLS_CONFORMANCE_DIR to use a checkout).
//
// Usage: npm run build && node test/conformance.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUITE_REPO = "https://github.com/modelcontextprotocol/conformance.git";
const SUITE_SHA = "7169291ec0b68eb370fddcd9947313ab0d5e4156"; // 2026-09-11, adds the SEP-2640 scenarios
const SCENARIOS = ["sep-2640-skills-enumeration", "sep-2640-skills-manifest", "sep-2640-skills-directory"];
// libB: its first listed skill has a subfolder, which the directory scenario needs to exercise.
const REVISIONS = [
  { label: "2026-07-28", args: [] },
  { label: "2025-11-25", args: ["--spec-version", "2025-11-25", "--force"] },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test", "fixtures", "libB");
const port = 39000 + Math.floor(Math.random() * 1000);
const url = `http://127.0.0.1:${port}/mcp`;

function suiteDir() {
  const dir = process.env.SKILLS_CONFORMANCE_DIR
    ?? path.join(process.env.SKILLS_CACHE_DIR ?? path.join(os.homedir(), ".cache", "skills-mcp"), `conformance-${SUITE_SHA.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, "dist", "index.js"))) return dir;
  if (process.env.SKILLS_CONFORMANCE_DIR) throw new Error(`${dir} has no dist/index.js; build the suite there first`);
  console.error(`fetching conformance suite ${SUITE_SHA.slice(0, 12)} into ${dir} (once)`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("remote", "add", "origin", SUITE_REPO);
  git("fetch", "-q", "--depth", "1", "origin", SUITE_SHA); git("checkout", "-q", "FETCH_HEAD");
  execFileSync("npm", ["ci", "--silent"], { cwd: dir, stdio: "ignore" }); // prepare builds dist/
  return dir;
}

async function waitFor(u, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(u, { method: "GET" }); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`server did not come up at ${u}`);
}

function run(dir, scenario, extra) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, "dist", "index.js"), "server", "--url", url, "--scenario", scenario, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.replace(/\x1b\[[0-9;]*m/g, "")));
  });
}

const dir = suiteDir();
const server = spawn(process.execPath, [path.join(root, "dist", "index.js"), "--root", fixture, "--http", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
let serverLog = ""; server.stderr.on("data", (d) => (serverLog += d));
let failed = 0;
try {
  await waitFor(url);
  for (const rev of REVISIONS) {
    for (const sc of SCENARIOS) {
      const out = await run(dir, sc, rev.args);
      const m = /Passed:\s*(\d+)\/(\d+),\s*(\d+) failed,\s*(\d+) warnings?/.exec(out);
      const bad = out.split("\n").filter((l) => / FAILURE /.test(l));
      const warn = out.split("\n").filter((l) => / WARNING /.test(l));
      if (!m || Number(m[3]) > 0) {
        failed++;
        console.log(`✗ ${rev.label} ${sc}: ${m ? `${m[1]}/${m[2]}` : "no result"}`);
        for (const l of (bad.length ? bad : out.split("\n").slice(-15))) console.log(`    ${l.trim()}`);
      } else {
        console.log(`✓ ${rev.label} ${sc}: ${m[1]}/${m[2]}${warn.length ? ` (${warn.length} warning${warn.length > 1 ? "s" : ""})` : ""}`);
        for (const l of warn) console.log(`    ${l.trim()}`);
      }
    }
  }
} catch (e) {
  failed++;
  console.error(`✗ ${e.message}\n${serverLog}`);
} finally {
  server.kill();
}
console.log(failed ? `CONFORMANCE FAILED (${failed})` : "CONFORMANCE OK");
process.exit(failed ? 1 : 0);
