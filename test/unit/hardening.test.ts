import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { catalogFor, connected, libA, libB, FIX } from "./helpers.js";
import { loadConfig, reloadConfigFile } from "../../src/config.js";
import { Catalog } from "../../src/catalog.js";
import { lintFiles } from "../../src/lint.js";
import { mimeFor } from "../../src/catalog.js";

const libC = path.join(FIX, "libC");

test("linter flags the risky fixture and not the clean one", async () => {
  const { cat } = await catalogFor(["--root", libC]);
  const risky = cat.get("risky")!;
  const rules = new Set(risky.riskFlags.map((r) => r.rule));
  for (const r of ["pipe-to-shell", "world-writable", "sensitive-path", "prompt-injection"]) assert.ok(rules.has(r), `expected ${r} in ${[...rules]}`);
  assert.equal(cat.get("clean")!.riskFlags.length, 0);
  assert.equal(cat.getStats().flaggedSkills, 1);
  assert.ok(cat.getStats().warnings.some((w) => w.startsWith("risky: risk flags")));
});
test("linter unit: skips binaries, one finding per rule per file, comment-suppression", async () => {
  const f = (rel: string, abs: string, size: number) => ({ rel, abs, size, mtimeMs: 0, mimeType: mimeFor(rel) });
  const sh = path.join(libC, "risky", "scripts", "install.sh");
  const r = await lintFiles([f("scripts/install.sh", sh, 200)]);
  assert.equal(r.filter((x) => x.rule === "pipe-to-shell").length, 1);
  const png = await lintFiles([f("x.png", path.join(FIX, "libB", "beta", "refs", "pic.png"), 20)]);
  assert.equal(png.length, 0);
});
test("--no-lint disables flags", async () => {
  const { cat } = await catalogFor(["--root", libC, "--no-lint"]);
  assert.equal(cat.get("risky")!.riskFlags.length, 0);
});
test("--no-scripts withholds executables globally; per-library via config file", async () => {
  const { cat } = await catalogFor(["--root", libC, "--no-scripts"]);
  const r = cat.get("risky")!;
  assert.deepEqual(r.files.map((f) => f.rel), ["SKILL.md"]);
  assert.equal(r.scriptsWithheld, 2);
  assert.equal(cat.resolveUri("skill://risky/scripts/install.sh")!.file, undefined, "withheld file is not readable");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const cfgPath = path.join(tmp, "skills.json");
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [{ namespace: "c", root: libC, noScripts: true }, { namespace: "b", root: libB }] }));
  const { cat: cat2 } = await catalogFor(["--config", cfgPath]);
  assert.equal(cat2.get("c/risky")!.scriptsWithheld, 2);
  assert.equal(cat2.get("b/beta")!.files.length, 3, "other library keeps its files");
  assert.deepEqual(cat2.getStats().libraries.map((l) => [l.namespace, l.noScripts]), [["c", true], ["b", false]]);
});
test("trust fields and risk flags reach _meta, search results and get_skill", async () => {
  const { client, close } = await connected(["--lib", `c=${libC}`, "--lib", `a=${libA}`, "--name", "t"]);
  try {
    const res = await client.listResources();
    const risky = res.resources.find((r) => r.uri === "skill://c/risky/SKILL.md") as any;
    assert.equal(risky._meta["io.modelcontextprotocol.skills/origin"], "reference");
    assert.equal(risky._meta["io.modelcontextprotocol.skills/risk"], "high");
    assert.equal(risky._meta["io.modelcontextprotocol.skills/gate_required"], true);
    assert.ok(risky._meta["io.modelcontextprotocol.skills/risk-flags"].includes("pipe-to-shell"));
    const clean = res.resources.find((r) => r.uri === "skill://c/clean/SKILL.md") as any;
    assert.deepEqual(clean._meta["io.modelcontextprotocol.skills/risk-flags"], []);
    const s = await client.callTool({ name: "t_search_skills", arguments: { query: "dangerous install" } });
    const top = (s.structuredContent as any).results[0];
    assert.equal(top.path, "c/risky");
    assert.equal(top.trust.origin, "reference");
    assert.ok(top.riskFlags.includes("prompt-injection"));
    const g = await client.callTool({ name: "t_get_skill", arguments: { name: "risky" } });
    const sc = g.structuredContent as any;
    assert.ok(sc.riskFlags.some((f: any) => f.file === "scripts/install.sh" && f.rule === "pipe-to-shell" && f.line === 3));
    assert.match((g.content as any)[0].text, /⚠ Risk flags/);
    assert.match((g.content as any)[0].text, /Provenance: .*risk=high/);
    // skills/list frontmatter stays verbatim (spec) — trust is additive elsewhere
    const l = await client.request({ method: "skills/list", params: {} }, z.any());
    const e = l.skills.find((x: any) => x.uri === "skill://c/risky/SKILL.md");
    assert.equal(e.frontmatter.risk, "high");
    assert.equal(e.resources.length, 3);
  } finally { await close(); }
});
test("config file: load, reload adds/removes libraries, keeps CLI libs, tolerates a bad edit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const cfgPath = path.join(tmp, "skills.json");
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [{ namespace: "a", root: libA }] }));
  const cfg = loadConfig(["--lib", `b=${libB}`, "--config", cfgPath]);
  assert.deepEqual(cfg.libraries.map((l) => l.namespace), ["b", "a"]);
  const cliLibs = cfg.libraries.filter((l) => l.namespace === "b");
  const cat = new Catalog(cfg);
  await cat.scan();
  assert.equal(cat.all().length, 4);
  let fired = 0; cat.onChange(() => fired++);
  // unchanged file → no change
  assert.equal(reloadConfigFile(cfg, cliLibs), false);
  // add libC with no-scripts, relative root resolved against the config file's directory
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [{ namespace: "a", root: libA }, { namespace: "c", root: path.relative(tmp, libC), noScripts: true }] }));
  assert.equal(reloadConfigFile(cfg, cliLibs), true);
  await cat.scan();
  assert.deepEqual(cat.all().map((s) => s.skillPath), ["a/alpha", "a/shared", "b/beta", "b/shared", "c/clean", "c/risky"]);
  assert.equal(cat.get("c/risky")!.scriptsWithheld, 2);
  assert.equal(fired, 1);
  // remove a → gone; CLI lib b stays
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [{ namespace: "c", root: libC }] }));
  assert.equal(reloadConfigFile(cfg, cliLibs), true);
  await cat.scan();
  assert.deepEqual(cat.all().map((s) => s.library), ["b", "b", "c", "c"]);
  assert.equal(cat.get("c/risky")!.scriptsWithheld, 0, "noScripts lifted");
  // broken JSON → throws, previous libraries kept
  await fs.writeFile(cfgPath, "{ not json");
  assert.throws(() => reloadConfigFile(cfg, cliLibs), /cannot read config/);
  assert.deepEqual(cfg.libraries.map((l) => l.namespace), ["b", "c"]);
  // duplicate with CLI namespace → rejected
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [{ namespace: "b", root: libA }] }));
  assert.throws(() => reloadConfigFile(cfg, cliLibs), /duplicate library namespace/);
});
