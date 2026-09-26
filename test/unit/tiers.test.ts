import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { catalogFor, connected, cfgFor, libA } from "./helpers.js";
import { loadConfig, reloadConfigFile } from "../../src/config.js";

const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n# ${name}\n`;

test("files that are not served are reported per skill: over SKILLS_MAX_FILE_BYTES, symlink, dotfile", async () => {
  const lib = await fs.mkdtemp(path.join(os.tmpdir(), "skips-"));
  const dir = path.join(lib, "s");
  await fs.mkdir(path.join(dir, "refs", ".hidden-dir"), { recursive: true });
  await fs.mkdir(path.join(dir, "__pycache__"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), md("s"));
  await fs.writeFile(path.join(dir, "refs", "big.bin"), Buffer.alloc(2048));
  await fs.writeFile(path.join(dir, "refs", "ok.md"), "fine\n");
  await fs.writeFile(path.join(dir, ".env"), "X=1\n");
  await fs.writeFile(path.join(dir, "refs", ".hidden-dir", "x.md"), "x\n");
  await fs.writeFile(path.join(dir, "__pycache__", "m.cpython-312.pyc"), "x");
  await fs.symlink(path.join(dir, "refs", "ok.md"), path.join(dir, "refs", "link.md"));
  await fs.mkdir(path.join(lib, "clean"));
  await fs.writeFile(path.join(lib, "clean", "SKILL.md"), md("clean"));
  process.env.SKILLS_MAX_FILE_BYTES = "1024";
  try {
    const { cat } = await catalogFor(["--root", lib]);
    assert.deepEqual(cat.get("s")!.files.map((f) => f.rel), ["SKILL.md", "refs/ok.md"]);
    const w = cat.getStats().warnings.filter((x) => /skipped/.test(x));
    assert.deepEqual(w, ["s: 4 file(s) skipped (1 over SKILLS_MAX_FILE_BYTES: refs/big.bin; 1 symlink: refs/link.md; 2 dotfile: .env, refs/.hidden-dir/)"]);
    assert.ok(!w.some((x) => x.startsWith("clean")), "a clean skill gets no warning");
  } finally { delete process.env.SKILLS_MAX_FILE_BYTES; }
});

/** A vault with a playbook-runner, one public and one private skill, and a public and an internal playbook. */
async function tieredVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tiers-"));
  const skills = path.join(root, "00-CORE", "Agents", "skills");
  for (const [name, tier] of [["playbook-runner", "starter"], ["pub", "starter"], ["priv", "private"], ["intern", "Internal"]]) {
    await fs.mkdir(path.join(skills, name), { recursive: true });
    await fs.writeFile(path.join(skills, name, "SKILL.md"), md(name, `pricing-tier: ${tier}\n`));
  }
  const pb = path.join(root, "00-CORE", "Playbooks");
  await fs.mkdir(pb, { recursive: true });
  const note = (title: string, tier: string) => `---\ntype: playbook\ntitle: ${title}\nstatus: active\npricing-tier: ${tier}\n---\n## Steps\n1. pub → do it (AGENT)\n`;
  await fs.writeFile(path.join(pb, "Public flow.md"), note("Public flow", "starter"));
  await fs.writeFile(path.join(pb, "Internal flow.md"), note("Internal flow", "internal"));
  return root;
}

test("--exclude-tiers hides skills and playbooks by pricing-tier (case-insensitive), counted as hidden; default serves all", async () => {
  const root = await tieredVault();
  const all = await catalogFor(["--lib", `v=${root}`]);
  assert.deepEqual(all.cat.all().map((s) => s.name), ["intern", "playbook-runner", "priv", "pub"]);
  assert.equal(all.cat.allPlaybooks().length, 2);
  assert.equal(all.cat.getStats().tierExcluded, undefined, "no tiers excluded by default");

  const { cat } = await catalogFor(["--lib", `v=${root}`, "--exclude-tiers", "internal, PRIVATE"]);
  assert.deepEqual(cat.all().map((s) => s.name), ["playbook-runner", "pub"]);
  assert.equal(cat.getAny("priv"), undefined, "excluded skills are not served at all, not even to skills/get");
  assert.deepEqual(cat.allPlaybooks().map((p) => p.name), ["Public flow"]);
  const st = cat.getStats();
  assert.deepEqual(st.tierExcluded, { tiers: ["internal", "private"], skills: 2, playbooks: 1 });
  assert.equal(st.hidden, 2);
  assert.deepEqual(st.libraries.map((l) => [l.skills, l.hidden, l.playbooks, l.playbooksHidden]), [[2, 2, 1, 1]]);

  const { client, close } = await connected(["--lib", `v=${root}`, "--exclude-tiers", "private,internal", "--name", "t"]);
  try {
    await assert.rejects(client.request({ method: "skills/get", params: { uri: "skill://v/priv/SKILL.md" } }, z.any()), { code: -32602 });
    const status = (await client.callTool({ name: "t_catalog_status", arguments: {} })).structuredContent as any;
    assert.deepEqual(status.tierExcluded, { tiers: ["private", "internal"], skills: 2, playbooks: 1 });
  } finally { await close(); }
});

test("exclude tiers from env and config file; a config-file change is picked up on reload", async () => {
  process.env.SKILLS_EXCLUDE_TIERS = "private";
  try { assert.deepEqual([...cfgFor(["--root", libA]).excludeTiers], ["private"]); } finally { delete process.env.SKILLS_EXCLUDE_TIERS; }
  assert.equal(cfgFor(["--root", libA]).excludeTiers.size, 0);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const file = path.join(tmp, "skills.json");
  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "a", root: libA }], excludeTiers: ["internal"] }));
  const cfg = loadConfig(["--config", file]);
  assert.deepEqual([...cfg.excludeTiers], ["internal"]);
  assert.equal(reloadConfigFile(cfg, []), false);
  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "a", root: libA }], excludeTiers: "internal,private" }));
  assert.equal(reloadConfigFile(cfg, []), true, "tier change is a change");
  assert.deepEqual([...cfg.excludeTiers], ["internal", "private"]);
});
