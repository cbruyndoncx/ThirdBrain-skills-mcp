import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FIX, catalogFor } from "./helpers.js";
// Archive libraries extract into a shared cache that each scan prunes; parallel test processes must not share it.
process.env.SKILLS_CACHE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "skills-cache-"));
import { pack, parsePackArgs } from "../../src/pack.js";
import { extractZip, DEFAULT_LIMITS } from "../../src/archive.js";

const vault = path.join(FIX, "vault");
const quiet = () => {};

test("pack: builds the public subset, served counts match the vault, sidecar written, deterministic", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-pack-"));
  const out = path.join(dir, "bob.zip");
  const r = await pack({ ...parsePackArgs(["--vault", vault, "--out", out]), log: quiet });
  assert.equal(r.skills, 3); assert.equal(r.playbooks, 3); assert.equal(r.chainFile, "20-COMPANY/03-PROCESSES/value-chains.md");
  assert.match(await fs.readFile(out + ".sha256", "utf8"), new RegExp(`^${r.sha256}  bob\\.zip\\n$`));
  const dest = path.join(dir, "x");
  await extractZip(out, dest, DEFAULT_LIMITS);
  const names: string[] = [];
  const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) await walk(a); else names.push(path.relative(dest, a).split(path.sep).join("/")); } };
  await walk(dest); names.sort();
  assert.deepEqual(names, [
    "00-CORE/Agents/skills/ab-test-setup/SKILL.md", "00-CORE/Agents/skills/cro/SKILL.md", "00-CORE/Agents/skills/playbook-runner/SKILL.md",
    "00-CORE/Playbooks/CRO improvement loop.md", "00-CORE/Playbooks/Monthly Close.md", "00-CORE/Playbooks/cro-loop-sequence.png", "00-CORE/Playbooks/drafts/Misplaced.md",
    "20-COMPANY/03-PROCESSES/value-chains.md", "pack.json",
  ], "no drafts, no _archive, no AGENTS.md, no private folders");
  const manifest = JSON.parse(await fs.readFile(path.join(dest, "pack.json"), "utf8"));
  assert.equal(manifest.skills, 3); assert.equal(manifest.playbooks, 3);
  // The pack served from the zip gives the same catalog as the vault folder.
  const { cat: fromZip } = await catalogFor(["--lib", `bob=${out}`]);
  const { cat: fromDir } = await catalogFor(["--lib", `bob=${vault}`]);
  const view = (c: typeof fromZip) => ({ skills: c.all().map((s) => s.skillPath), playbooks: c.allPlaybooks().map((p) => p.playbookPath), chains: c.allValueChains().map((v) => [v.id, v.source, v.stages]) });
  assert.deepEqual(view(fromZip), view(fromDir));
  assert.equal(fromZip.getStats().libraries[0].playbooksHidden, 0);
  assert.doesNotMatch(fromZip.getStats().warnings.join("\n"), /private playbooks/);
  // Identical inputs give byte-identical archives, including pack.json.
  const again = await pack({ ...parsePackArgs(["--vault", vault, "--out", path.join(dir, "bob2.zip")]), log: quiet });
  assert.equal(again.sha256, r.sha256);
  const dest2 = path.join(dir, "y");
  await extractZip(again.out, dest2, DEFAULT_LIMITS);
  for (const n of names) assert.ok((await fs.readFile(path.join(dest, n))).equals(await fs.readFile(path.join(dest2, n))), n);
});

test("pack: --all-statuses includes drafts; --wrapper nests; --dry-run writes nothing; bad vault refused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-pack-"));
  const out = path.join(dir, "all.zip");
  const r = await pack({ ...parsePackArgs(["--vault", vault, "--out", out, "--all-statuses", "--wrapper", "release-1.0"]), log: quiet });
  assert.equal(r.playbooks, 4);
  const { cat } = await catalogFor(["--lib", `bob=${out}`, "--show-disabled"]);
  assert.equal(cat.getStats().libraries[0].playbooks, 4, "wrapper folder is recognised");
  assert.deepEqual(cat.all().map((s) => s.skillPath), ["bob/ab-test-setup", "bob/cro", "bob/playbook-runner"]);
  const dry = await pack({ ...parsePackArgs(["--vault", vault, "--out", path.join(dir, "dry.zip"), "--dry-run"]), log: quiet });
  assert.equal(dry.files, 9);
  await assert.rejects(fs.stat(path.join(dir, "dry.zip")));
  await assert.rejects(pack({ ...parsePackArgs(["--vault", path.join(FIX, "libA"), "--out", path.join(dir, "no.zip")]), log: quiet }), /not a vault/);
  assert.throws(() => parsePackArgs([]), /--vault DIR is required/);
});
