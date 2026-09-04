import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFor, libA, libB, nested } from "./helpers.js";

test("single library: flat discovery, hidden skills separated, warnings for non-skill files ignored", async () => {
  const { cat } = await catalogFor(["--root", libB]);
  assert.deepEqual(cat.all().map((s) => s.name), ["beta", "shared"]);
  assert.equal(cat.getStats().hidden, 1);
  assert.equal(cat.get("hidden"), undefined, "hidden not served via get()");
  assert.ok(cat.getAny("hidden"), "but skills/get can still answer");
  assert.equal(cat.get("beta")!.uri, "skill://beta/SKILL.md");
});
test("--show-disabled serves hidden skills", async () => {
  const { cat } = await catalogFor(["--root", libB, "--show-disabled"]);
  assert.ok(cat.get("hidden"));
});
test("multi-library: namespaced paths, bare-name ambiguity, lib/name lookup", async () => {
  const { cat } = await catalogFor(["--lib", `a=${libA}`, "--lib", `b=${libB}`]);
  assert.deepEqual(cat.all().map((s) => s.skillPath), ["a/alpha", "a/shared", "b/beta", "b/shared"]);
  assert.deepEqual(cat.all("b").map((s) => s.name), ["beta", "shared"]);
  assert.equal(cat.get("alpha")!.uri, "skill://a/alpha/SKILL.md");
  assert.equal(cat.get("shared"), undefined, "ambiguous bare name");
  assert.equal(cat.get("b/shared")!.library, "b");
  assert.equal(cat.get("a/shared")!.body.trim(), "# Shared A");
  const st = cat.getStats();
  assert.deepEqual(st.libraries.map((l) => [l.namespace, l.skills, l.hidden]), [["a", 2, 0], ["b", 2, 1]]);
});
test("nested library: deep paths and duplicate leaf names; folder path becomes category", async () => {
  const { cat } = await catalogFor(["--root", nested]);
  assert.equal(cat.get("acme/billing/refunds")!.category, "acme/billing");
  assert.equal(cat.get("solo")!.category, "uncategorized");
  const ns = await catalogFor(["--lib", `n=${nested}`]);
  assert.equal(ns.cat.get("n/acme/billing/refunds")!.category, "acme/billing", "namespace is not part of the category");
  assert.deepEqual(cat.all().map((s) => s.skillPath), ["acme/billing/refunds", "acme/other/refunds", "solo"]);
  assert.equal(cat.get("refunds"), undefined);
  assert.ok(cat.get("acme/billing/refunds"));
});
test("resolveUri: longest prefix, files, directories, traversal", async () => {
  const { cat } = await catalogFor(["--lib", `a=${libA}`, "--lib", `b=${libB}`]);
  const r = cat.resolveUri("skill://b/beta/refs/notes.md")!;
  assert.equal(r.skill.name, "beta");
  assert.equal(r.file?.rel, "refs/notes.md");
  assert.equal(cat.resolveUri("skill://b/beta/refs")!.file, undefined);
  assert.equal(cat.resolveUri("skill://b/beta/../alpha/SKILL.md"), null);
  assert.equal(cat.resolveUri("skill://nope/SKILL.md"), null);
  assert.equal(cat.resolveUri("file:///etc/passwd"), null);
  assert.equal(cat.resolveUri("skill://b/beta/%2E%2E/x"), null);
});
test("digest is sha256 and cached", async () => {
  const { cat } = await catalogFor(["--root", libB]);
  const f = cat.get("beta")!.files.find((x) => x.rel === "refs/notes.md")!;
  const d1 = await cat.digestFor(f);
  assert.match(d1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(d1, "sha256:" + (await import("node:crypto")).createHash("sha256").update("notes here\n").digest("hex"));
  assert.equal(await cat.digestFor(f), d1);
});
test("frontmatter with block scalar and list parses; mime types", async () => {
  const { cat } = await catalogFor(["--root", libB]);
  const b = cat.get("beta")!;
  assert.equal(b.description, "Beta skill for meeting notes and agendas.");
  assert.deepEqual(b.tags, ["level 10"]);
  assert.equal(b.files.find((f) => f.rel === "refs/pic.png")!.mimeType, "image/png");
});
test("rescan detects changes and notifies", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skills-"));
  await fs.mkdir(path.join(tmp, "one"));
  await fs.writeFile(path.join(tmp, "one", "SKILL.md"), "---\nname: one\ndescription: d\n---\nx");
  const { cat } = await catalogFor(["--root", tmp]);
  let fired = 0; cat.onChange(() => fired++);
  await cat.scan(); assert.equal(fired, 0, "no change → no notification");
  await fs.mkdir(path.join(tmp, "two"));
  await fs.writeFile(path.join(tmp, "two", "SKILL.md"), "---\nname: two\ndescription: d\n---\ny");
  await cat.scan();
  assert.equal(fired, 1);
  assert.equal(cat.all().length, 2);
});
