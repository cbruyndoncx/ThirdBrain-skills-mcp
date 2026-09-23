import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { cfgFor, libA, libB } from "./helpers.js";
import { loadConfig, reloadConfigFile } from "../../src/config.js";

test("single --root → one un-namespaced library, default name/prefix", () => {
  const c = cfgFor(["--root", libA]);
  assert.equal(c.libraries.length, 1);
  assert.equal(c.libraries[0].namespace, "");
  assert.equal(c.serverName, "skills");
  assert.equal(c.toolPrefix, "skills");
});
test("--lib NS=DIR twice → two namespaces; single --lib names the server after it", () => {
  const c = cfgFor(["--lib", `a=${libA}`, "--lib", `b=${libB}`]);
  assert.deepEqual(c.libraries.map((l) => l.namespace), ["a", "b"]);
  assert.equal(c.serverName, "skills");
  const one = cfgFor(["--lib", `bob=${libA}`]);
  assert.equal(one.serverName, "bob");
  assert.equal(one.toolPrefix, "bob");
});
test("--name with dashes → prefix with underscores", () => {
  assert.equal(cfgFor(["--root", libA, "--name", "my-skills"]).toolPrefix, "my_skills");
});
test("rejects: no root, duplicate namespace, root+lib mix, bad namespace", () => {
  assert.throws(() => cfgFor([]), /--root DIR, --lib NS=DIR/);
  assert.throws(() => cfgFor(["--lib", `a=${libA}`, "--lib", `a=${libB}`]), /duplicate library namespace/);
  assert.throws(() => cfgFor(["--root", libA, "--lib", `b=${libB}`]), /cannot be combined/);
  assert.throws(() => cfgFor(["--lib", `bad ns=${libA}`]), /must match/);
  assert.throws(() => cfgFor(["--root", libA, "--bogus"]), /Unknown argument/);
});
test("SKILLS_LIBS env is honoured", () => {
  process.env.SKILLS_LIBS = `x=${libA}, y=${libB}`;
  try {
    const c = cfgFor([]);
    assert.deepEqual(c.libraries.map((l) => l.namespace), ["x", "y"]);
  } finally { delete process.env.SKILLS_LIBS; }
});
test("config file: library info loads, a version bump counts as a change, bad metadata is rejected", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const cfgPath = path.join(tmp, "skills.json");
  const write = (libs: unknown[]) => fs.writeFile(cfgPath, JSON.stringify({ libraries: libs }));
  await write([{ namespace: "a", root: libA, source: "v", version: "1" }]);
  const cfg = loadConfig(["--config", cfgPath]);
  assert.deepEqual(cfg.libraries[0].info, { source: "v", version: "1" });
  assert.equal(reloadConfigFile(cfg, []), false, "unchanged");
  await write([{ namespace: "a", root: libA, source: "v", version: "2" }]);
  assert.equal(reloadConfigFile(cfg, []), true, "version bump is a change");
  assert.equal(cfg.libraries[0].info?.version, "2");
  await write([{ namespace: "a", root: libA, metadata: { n: 5 } }]);
  assert.throws(() => reloadConfigFile(cfg, []), /metadata\.n must be a string/);
  await write([{ namespace: "a", root: libA, version: 3 }]);
  assert.throws(() => reloadConfigFile(cfg, []), /version must be a string/);
});
test("SKILLS_ROOT is not read: it is the skills' own contract, a host may export it for them", () => {
  process.env.SKILLS_ROOT = "/anything";
  try {
    const c = cfgFor(["--lib", `bob=${libA}`]);
    assert.deepEqual(c.libraries.map((l) => l.namespace), ["bob"], "only bob, no un-namespaced library from SKILLS_ROOT");
    assert.throws(() => cfgFor([]), /SKILLS_MCP_ROOT/, "SKILLS_ROOT alone does not configure a library");
  } finally { delete process.env.SKILLS_ROOT; }
});
test("SKILLS_MCP_ROOT serves an un-namespaced library; BOB_SKILLS_ROOT is a deprecated alias", () => {
  process.env.SKILLS_MCP_ROOT = libB;
  try {
    const c = cfgFor([]);
    assert.equal(c.libraries.length, 1);
    assert.equal(c.libraries[0].namespace, "");
    assert.equal(c.libraries[0].root, libB);
  } finally { delete process.env.SKILLS_MCP_ROOT; }
  process.env.BOB_SKILLS_ROOT = libA;
  try {
    assert.equal(cfgFor([]).libraries[0].root, libA);
  } finally { delete process.env.BOB_SKILLS_ROOT; }
});
