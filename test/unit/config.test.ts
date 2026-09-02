import { test } from "node:test";
import assert from "node:assert/strict";
import { cfgFor, libA, libB } from "./helpers.js";

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
