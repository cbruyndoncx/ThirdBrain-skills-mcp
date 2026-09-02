import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, coerceList, coerceString } from "../../src/frontmatter.js";

test("splits frontmatter and body", () => {
  const r = splitFrontmatter("---\nname: x\ndescription: >\n  multi\n  line\n---\n# Body\n");
  assert.equal(r.data?.name, "x");
  assert.equal(r.data?.description, "multi line\n");
  assert.equal(r.body, "# Body\n");
});
test("tolerates BOM and CRLF", () => {
  const r = splitFrontmatter("﻿---\r\nname: y\r\n---\r\nbody");
  assert.equal(r.data?.name, "y");
  assert.equal(r.body, "body");
});
test("no frontmatter → null data, full body", () => {
  const r = splitFrontmatter("# just markdown");
  assert.equal(r.data, null);
  assert.equal(r.body, "# just markdown");
});
test("malformed YAML → null data, does not throw", () => {
  const r = splitFrontmatter("---\nname: [unclosed\n---\nbody");
  assert.equal(r.data, null);
});
test("coercions", () => {
  assert.deepEqual(coerceList("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(coerceList(["x", 1]), ["x", "1"]);
  assert.equal(coerceString(["a", "b"]), "a, b");
  assert.equal(coerceString(null), "");
});
