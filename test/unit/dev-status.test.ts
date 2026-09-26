import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { catalogFor, connected, cfgFor, libA } from "./helpers.js";
import { loadConfig, reloadConfigFile } from "../../src/config.js";

const md = (name: string, extra = "", body = "") => `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n# ${name}\n${body}`;

/**
 * A vault with:
 *   playbook-runner, ready   dev-status integrated
 *   wip                      dev-status dev
 *   beta                     dev-status Beta (case-insensitive match)
 *   loose                    no dev-status (untracked)
 *   secret                   dev-status integrated, pricing-tier private
 *   draft-secret             dev-status dev, pricing-tier private (withheld by both)
 *   needs-wip                integrated, runtime dependency on wip
 * and one playbook (playbooks carry no dev-status and are not filtered).
 */
async function devVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devstatus-"));
  const skills = path.join(root, "00-CORE", "Agents", "skills");
  const defs: [string, string, string?][] = [
    ["playbook-runner", "dev-status: integrated\n"],
    ["ready", "dev-status: integrated\n"],
    ["wip", "dev-status: dev\n"],
    ["beta", "dev-status: Beta\n"],
    ["loose", ""],
    ["secret", "dev-status: integrated\npricing-tier: private\n"],
    ["draft-secret", "dev-status: dev\npricing-tier: private\n"],
    ["needs-wip", "dev-status: integrated\n", "\n- [[wip/SKILL.md|wip]] — **runtime dependency.** Imports it.\n"],
  ];
  for (const [name, extra, body] of defs) {
    await fs.mkdir(path.join(skills, name), { recursive: true });
    await fs.writeFile(path.join(skills, name, "SKILL.md"), md(name, extra, body));
  }
  const pb = path.join(root, "00-CORE", "Playbooks");
  await fs.mkdir(pb, { recursive: true });
  await fs.writeFile(path.join(pb, "Flow.md"), `---\ntype: playbook\ntitle: Flow\nstatus: active\n---\n## Steps\n1. ready → do it (AGENT)\n`);
  return root;
}

const ALL = ["beta", "draft-secret", "loose", "needs-wip", "playbook-runner", "ready", "secret", "wip"];

test("--dev-status: default serves all and reports nothing", async () => {
  const root = await devVault();
  const { cat } = await catalogFor(["--lib", `v=${root}`]);
  assert.deepEqual(cat.all().map((s) => s.name), ALL);
  assert.equal(cat.getStats().devStatusExcluded, undefined, "no dev-status filter by default");
  assert.ok(!cat.getStats().warnings.some((w) => /runtime dependency/.test(w)), "wip is served, so needs-wip is complete");
});

test("--dev-status withholds skills whose dev-status is set and not listed; untracked skills are served and counted", async () => {
  const root = await devVault();
  const { cat } = await catalogFor(["--lib", `v=${root}`, "--dev-status", "Integrated, beta"]);
  assert.deepEqual(cat.all().map((s) => s.name), ["beta", "loose", "needs-wip", "playbook-runner", "ready", "secret"]);
  assert.equal(cat.getAny("wip"), undefined, "withheld skills are not served at all, not even to skills/get");
  assert.equal(cat.getAny("draft-secret"), undefined);
  assert.ok(cat.get("loose"), "a skill without dev-status is served");
  assert.deepEqual(cat.allPlaybooks().map((p) => p.name), ["Flow"], "playbooks are not filtered by dev-status");
  const st = cat.getStats();
  assert.deepEqual(st.devStatusExcluded, { statuses: ["integrated", "beta"], skills: 2, untracked: 1 });
  assert.equal(st.tierExcluded, undefined);
  assert.equal(st.skills, 6);
  assert.equal(st.hidden, 2);
  assert.deepEqual(st.libraries.map((l) => [l.skills, l.hidden]), [[6, 2]]);
});

test("--dev-status with --exclude-tiers: a skill withheld by both counts once, under tierExcluded", async () => {
  const root = await devVault();
  const { cat } = await catalogFor(["--lib", `v=${root}`, "--exclude-tiers", "internal,private", "--dev-status", "integrated"]);
  assert.deepEqual(cat.all().map((s) => s.name), ["loose", "needs-wip", "playbook-runner", "ready"]);
  const st = cat.getStats();
  assert.deepEqual(st.tierExcluded, { tiers: ["internal", "private"], skills: 2, playbooks: 0 });
  assert.deepEqual(st.devStatusExcluded, { statuses: ["integrated"], skills: 2, untracked: 1 }, "wip and beta; draft-secret is counted as a tier exclusion");
  assert.equal(st.hidden, 4);
  assert.equal(st.skills + st.hidden, ALL.length, "every skill is either served or counted as hidden exactly once");
  assert.deepEqual(st.libraries.map((l) => [l.skills, l.hidden]), [[4, 4]]);
});

test("--dev-status: a dependency withheld by the filter is reported missing, with the reason", async () => {
  const root = await devVault();
  const { cat } = await catalogFor(["--lib", `v=${root}`, "--dev-status", "integrated"]);
  assert.deepEqual(cat.dependencyClosure(cat.get("needs-wip")!), { skills: [], missing: ["wip"] });
  const w = cat.getStats().warnings.filter((x) => /runtime dependenc/.test(x));
  assert.deepEqual(w, ["v/needs-wip: runtime dependency 'wip' (withheld: dev-status dev) not served in library 'v'; pull --with-deps cannot complete its closure"]);

  const tiers = await catalogFor(["--lib", `v=${root}`, "--exclude-tiers", "private"]);
  assert.ok(!tiers.cat.getStats().warnings.some((x) => /runtime dependenc/.test(x)), "wip is served when only tiers are excluded");

  const { client, close } = await connected(["--lib", `v=${root}`, "--dev-status", "integrated", "--name", "d"]);
  try {
    const got = (await client.callTool({ name: "d_get_skill", arguments: { name: "needs-wip" } })).structuredContent as any;
    assert.deepEqual(got.missingDependencies, ["wip"]);
    assert.deepEqual(got.dependencyClosure, []);
  } finally { await close(); }
});

test("--dev-status over MCP: skills/get refuses a withheld skill, skills/list omits it, catalog_status reports the block", async () => {
  const root = await devVault();
  const { client, close } = await connected(["--lib", `v=${root}`, "--exclude-tiers", "private", "--dev-status", "integrated", "--name", "t"]);
  try {
    await assert.rejects(client.request({ method: "skills/get", params: { uri: "skill://v/wip/SKILL.md" } }, z.any()), { code: -32602 });
    const got = await client.request({ method: "skills/get", params: { uri: "skill://v/loose/SKILL.md" } }, z.any());
    assert.equal(got.skill.uri, "skill://v/loose/SKILL.md", "untracked skills are served");
    const list = await client.request({ method: "skills/list", params: {} }, z.any());
    const uris = list.skills.map((s: any) => s.uri);
    assert.ok(!uris.includes("skill://v/wip/SKILL.md") && !uris.includes("skill://v/beta/SKILL.md"));
    const status = (await client.callTool({ name: "t_catalog_status", arguments: {} })).structuredContent as any;
    assert.deepEqual(status.devStatusExcluded, { statuses: ["integrated"], skills: 2, untracked: 1 });
    assert.deepEqual(status.tierExcluded, { tiers: ["private"], skills: 2, playbooks: 0 });
  } finally { await close(); }
});

test("dev-status from env and config file; a config-file change is picked up on reload and rescan", async () => {
  process.env.SKILLS_DEV_STATUS = "Integrated,beta";
  try { assert.deepEqual([...cfgFor(["--root", libA]).devStatus], ["integrated", "beta"]); } finally { delete process.env.SKILLS_DEV_STATUS; }
  assert.equal(cfgFor(["--root", libA]).devStatus.size, 0, "off by default");
  process.env.SKILLS_DEV_STATUS = "dev";
  try { assert.deepEqual([...cfgFor(["--root", libA, "--dev-status", "integrated"]).devStatus], ["integrated"], "the flag overrides the env"); } finally { delete process.env.SKILLS_DEV_STATUS; }

  const root = await devVault();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const file = path.join(tmp, "skills.json");
  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "v", root }], devStatus: ["integrated"] }));
  const cfg = loadConfig(["--config", file, "--dev-status", "dev"]);
  assert.deepEqual([...cfg.devStatus], ["integrated"], "the config file value replaces the flag");
  assert.equal(reloadConfigFile(cfg, []), false);

  const { Catalog } = await import("../../src/catalog.js");
  const cat = new Catalog(cfg);
  await cat.scan();
  assert.deepEqual(cat.getStats().devStatusExcluded, { statuses: ["integrated"], skills: 3, untracked: 1 });
  assert.equal(cat.get("wip"), undefined);

  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "v", root }], devStatus: "integrated,DEV" }));
  assert.equal(reloadConfigFile(cfg, []), true, "a dev-status change is a change");
  assert.deepEqual([...cfg.devStatus], ["integrated", "dev"]);
  await cat.scan();
  assert.ok(cat.get("wip"), "wip is served after the reload");
  assert.deepEqual(cat.getStats().devStatusExcluded, { statuses: ["integrated", "dev"], skills: 1, untracked: 1 });

  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "v", root }], devStatus: [] }));
  assert.equal(reloadConfigFile(cfg, []), true, "clearing the list turns the filter off");
  await cat.scan();
  assert.equal(cat.getStats().devStatusExcluded, undefined);
  assert.equal(cat.all().length, ALL.length);
});
