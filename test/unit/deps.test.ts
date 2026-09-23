import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseDependencies, interpreterFor } from "../../src/catalog.js";
import { parsePullArgs, pull } from "../../src/pull.js";
import { catalogFor, connected } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "..", "src", "index.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const PEP723 = `# /// script\n# requires-python = ">=3.11"\n# dependencies = ["pyyaml>=6.0"]\n# ///\nimport argparse\nap = argparse.ArgumentParser()\nap.add_argument("--vault")\n`;

/**
 * app → core (required) → util (required) → core (cycle); core → app (cycle back to the root);
 * app → extra (optional, never pulled); lonely → ghost (not served).
 */
async function makeLibrary(dir: string): Promise<void> {
  const skill = async (name: string, body: string, files: Record<string, string> = {}) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\nrequires: [uv]\n---\n# ${name}\n\n${body}\n`);
    for (const [rel, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, name, rel), text);
    }
  };
  await skill("app", [
    "## Related",
    "- [[core/SKILL.md|core]] — **runtime dependency.** Imports its library.",
    "- [[extra/SKILL.md]] — **optional runtime dependency.** Used when present.",
    "- [[app/SKILL.md|app]] — **runtime dependency.** (self-reference, ignored)",
    "- [[notes/SKILL.md|notes]] — see also (not a dependency)",
  ].join("\n"), { "scripts/app.py": PEP723, "tests/test_app.py": "def test_x(): pass\n" });
  await skill("core", "- [[util/SKILL.md]] — **runtime dependency.** Helper.\n- [[app/SKILL.md|app]] — **runtime dependency.** Cycle.", { "scripts/core_lib.py": "X = 1\n" });
  await skill("util", "- [[core/SKILL.md|core]] — **runtime dependency.** Cycle back.");
  await skill("extra", "Nothing.");
  await skill("lonely", "- [[ghost/SKILL.md|ghost]] — **runtime dependency.** Not served.");
  await skill("plain", "Run `python scripts/run.py`.", { "scripts/run.py": "print('hi')\n" });
}

async function tmpLibrary(vaultShaped = false): Promise<{ root: string; skills: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deps-"));
  const skills = vaultShaped ? path.join(root, "00-CORE", "Agents", "skills") : root;
  await makeLibrary(skills);
  return { root, skills };
}

test("dependency markers: required, optional, both link forms, self-reference, both ways counts as required", () => {
  const d = parseDependencies([
    "- [[context-pack/SKILL.md|context-pack]] — **runtime dependency.** x",
    "- [[tasknotes/SKILL.md]] — **runtime dependency.** y",
    "- [[skillsmith/SKILL.md|skillsmith]] — **optional runtime dependency.** z",
    "- [[bob-install/SKILL.md]] — **optional runtime dependency.**",
    "- [[tasknotes/SKILL.md|tasknotes]] — **optional runtime dependency.** marked both ways",
    "- [[me/SKILL.md|me]] — **runtime dependency.** self",
    "- [[drawio]] — **runtime dependency.** (no /SKILL.md: not the canonical form)",
    "- [[ai-image-gen/SKILL.md|ai-image-gen]] — runtime dependency for images (not canonical)",
  ].join("\n"), "me");
  assert.deepEqual(d, { required: ["context-pack", "tasknotes"], optional: ["skillsmith", "bob-install"] });
  assert.deepEqual(parseDependencies("no markers"), { required: [], optional: [] });
});

test("closure: transitive, cycles followed once, missing reported, same library only", async () => {
  const { skills } = await tmpLibrary();
  const { cat } = await catalogFor(["--lib", `x=${skills}`]);
  const app = cat.get("app")!;
  assert.deepEqual(app.dependencies, { required: ["core"], optional: ["extra"] });
  const c = cat.dependencyClosure(app);
  assert.deepEqual(c.skills.map((s) => s.skillPath), ["x/core", "x/util"], "app itself is not in its closure");
  assert.deepEqual(c.missing, []);
  assert.deepEqual(cat.dependencyClosure(cat.get("util")!).skills.map((s) => s.skillPath), ["x/core", "x/app"]);
  assert.deepEqual(cat.dependencyClosure(cat.get("lonely")!), { skills: [], missing: ["ghost"] });
  assert.ok(cat.getStats().warnings.some((w) => /^x\/lonely: runtime dependency 'ghost' not served in library 'x'/.test(w)), cat.getStats().warnings.join("\n"));
  // a same-named skill in another library does not satisfy the dependency
  const other = await tmpLibrary();
  await fs.rm(path.join(other.skills, "core"), { recursive: true });
  const two = await catalogFor(["--lib", `x=${skills}`, "--lib", `y=${other.skills}`]);
  assert.deepEqual(two.cat.dependencyClosure(two.cat.get("y/app")!).missing, ["core"]);
});

test("_meta dependencies in skills/list, skills/get and resources/list; get_skill output (structured + text)", async () => {
  const { skills } = await tmpLibrary();
  const { client, close } = await connected(["--lib", `x=${skills}`, "--name", "dep"]);
  try {
    const list = await client.request({ method: "skills/list", params: {} }, z.any());
    const app = list.skills.find((s: any) => s.uri === "skill://x/app/SKILL.md");
    assert.deepEqual(app._meta["io.modelcontextprotocol.skills/dependencies"], { required: ["core"], optional: ["extra"] });
    assert.equal(app._meta["io.modelcontextprotocol.skills/library"], "x");
    const got = await client.request({ method: "skills/get", params: { uri: "skill://x/core/SKILL.md" } }, z.any());
    assert.deepEqual(got._meta["io.modelcontextprotocol.skills/dependencies"], { required: ["util", "app"], optional: [] });
    const res = await client.listResources();
    const r = res.resources.find((x) => x.uri === "skill://x/app/SKILL.md") as any;
    assert.deepEqual(r._meta["io.modelcontextprotocol.skills/dependencies"], { required: ["core"], optional: ["extra"] });
    assert.deepEqual(r._meta["io.modelcontextprotocol.skills/requires"], ["uv"], "_meta key name kept for compatibility");

    const g = await client.callTool({ name: "dep_get_skill", arguments: { name: "app" } });
    const sc = g.structuredContent as any;
    assert.deepEqual(sc.dependencies, { required: ["core"], optional: ["extra"] });
    assert.deepEqual(sc.dependencyClosure, ["x/core", "x/util"]);
    assert.deepEqual(sc.setup, ["uv"]);
    assert.equal(sc.missingDependencies, undefined);
    const py = sc.files.find((f: any) => f.path === "scripts/app.py");
    assert.equal(py.pep723, true);
    assert.equal(py.interpreter, "uv run");
    const text = (g.content as any)[0].text as string;
    assert.match(text, /Runtime dependencies \(other skills whose code this one runs\): required core \(closure: x\/core, x\/util\); optional extra \(used when present, not pulled\)/);
    assert.match(text, /Setup \(frontmatter requires: external tools and keys, not skills\): uv/);
    assert.doesNotMatch(text, /Requires:/);
    assert.match(text, /pull --sync --keep-path --with-deps --to ~\/\.cache\/skills-mcp-client\/dep x\/app/);
    assert.match(text, /The approval covers this skill and its dependency closure, whose code runs too: x\/app, x\/core, x\/util\./);
    assert.match(text, /- scripts\/app\.py \(\d+ B, sha256:[0-9a-f]{64}, run with: uv run \(PEP 723\)\)/);

    const lonely = (await client.callTool({ name: "dep_get_skill", arguments: { name: "lonely" } })).structuredContent as any;
    assert.deepEqual(lonely.missingDependencies, ["ghost"]);

    const f = await client.callTool({ name: "dep_read_skill_file", arguments: { name: "app", path: "scripts/app.py" } });
    const fc = f.structuredContent as any;
    assert.equal(fc.pep723, true);
    assert.equal(fc.interpreter, "uv run");
    assert.match(fc.note, /pull --sync --with-deps/);
    assert.match(fc.note, /`uv run scripts\/app\.py`/);
  } finally { await close(); }
});

test("script guidance: PEP 723 script in a vault library gets uv run, SKILLS_ROOT, VAULT_PATH and --vault", async () => {
  const { root } = await tmpLibrary(true);
  const { client, close } = await connected(["--lib", `bob=${root}`, "--name", "vlt"]);
  try {
    const libs = (await client.callTool({ name: "vlt_list_libraries", arguments: {} })).structuredContent as any;
    assert.equal(libs.libraries[0].vault, true, "vault-shaped library");
    const text = ((await client.callTool({ name: "vlt_get_skill", arguments: { name: "app" } })).content as any)[0].text as string;
    const cache = "~/.cache/skills-mcp-client/vlt";
    assert.ok(text.includes(`   cd ${cache}/bob/app && SKILLS_ROOT=${cache}/bob VAULT_PATH=<workspace> uv run scripts/app.py … --vault <workspace>`), text);
    assert.doesNotMatch(text, /tests\/test_app\.py …/, "test files are not offered as commands");
    assert.match(text, /<workspace> is the user's vault or workspace folder, never the cache folder/);
    assert.match(text, /`uv run` installs the dependencies a script declares in its PEP 723/);
    assert.ok(text.includes(`runs as \`${cache}/bob/<other>/scripts/x.py\``), "cross-skill commands resolve under SKILLS_ROOT");
    // a plain script in a vault library: python, VAULT_PATH set, no --vault flag (the script does not take one)
    const plain = ((await client.callTool({ name: "vlt_get_skill", arguments: { name: "plain" } })).content as any)[0].text as string;
    assert.ok(plain.endsWith(`   cd ${cache}/bob/plain && SKILLS_ROOT=${cache}/bob VAULT_PATH=<workspace> python scripts/run.py …`), plain);
  } finally { await close(); }
});

test("script guidance: plain script in a non-vault library gets python and SKILLS_ROOT only", async () => {
  const { skills } = await tmpLibrary();
  const { client, close } = await connected(["--root", skills, "--name", "flat"]);
  try {
    const text = ((await client.callTool({ name: "flat_get_skill", arguments: { name: "plain" } })).content as any)[0].text as string;
    const cache = "~/.cache/skills-mcp-client/flat";
    assert.ok(text.includes(`   cd ${cache}/plain && SKILLS_ROOT=${cache} python scripts/run.py …`), text);
    assert.doesNotMatch(text, /VAULT_PATH|--vault|<workspace>|PEP 723/);
    assert.match(text, /2\. Show the user what will run and get their approval\.\n/, "no closure line without dependencies");
    const p = await client.getPrompt({ name: "use-skill", arguments: { skill: "plain" } });
    assert.ok((p.messages[0].content as any).text.includes(`SKILLS_ROOT=${cache} python scripts/run.py …`));
  } finally { await close(); }
});

test("interpreterFor maps extensions; PEP 723 only switches Python to uv run", () => {
  assert.equal(interpreterFor("scripts/a.py", { pep723: true }), "uv run");
  assert.equal(interpreterFor("scripts/a.py", { pep723: false }), "python");
  assert.equal(interpreterFor("scripts/a.sh"), "bash");
  assert.equal(interpreterFor("scripts/a.mjs"), "node");
  assert.equal(interpreterFor("scripts/a.ps1"), "pwsh -File");
});

test("pull --with-deps: transitive required closure as siblings, optional and unrelated skills left out", async () => {
  const { skills } = await tmpLibrary();
  const to = await fs.mkdtemp(path.join(os.tmpdir(), "pull-deps-"));
  const logs: string[] = [];
  assert.equal(parsePullArgs(["app", "--with-deps"]).withDeps, true);
  const base = { command: [tsx, entry, "--lib", `x=${skills}`], all: false, list: false, keepPath: true, withDeps: true, force: false, sync: true, dryRun: false, to, log: (m: string) => logs.push(m) };
  const r = await pull({ ...base, skills: ["app"] });
  assert.deepEqual(r.skills, ["x/app", "x/core", "x/util"]);
  assert.deepEqual((await fs.readdir(path.join(to, "x"))).sort(), ["app", "core", "util"]);
  assert.ok(await fs.stat(path.join(to, "x", "core", "scripts", "core_lib.py")));
  assert.ok(logs.includes("deps  x/app → x/core") && logs.includes("deps  x/core → x/util"), logs.join("\n"));
  // without the flag only the named skill is pulled
  const alone = await fs.mkdtemp(path.join(os.tmpdir(), "pull-deps-"));
  const one = await pull({ ...base, withDeps: false, to: alone, skills: ["app"] });
  assert.deepEqual(one.skills, ["x/app"]);
  // an unresolvable dependency is an error, not a silent partial pull
  await assert.rejects(pull({ ...base, skills: ["lonely"] }), /declares runtime dependency 'ghost'/);
});
