import { test } from "node:test";
import assert from "node:assert/strict";
import { searchSkills, tokenize } from "../../src/search.js";
import { catalogFor, libA, libB } from "./helpers.js";

test("tokenize drops stop words and short tokens", () => {
  assert.deepEqual(tokenize("Use when the user says 'A/B test'"), ["says", "test"]);
});
test("ranking: exact name > phrase > tokens; trigger phrases count", async () => {
  const { cat } = await catalogFor(["--lib", `a=${libA}`, "--lib", `b=${libB}`]);
  const all = cat.all();
  assert.equal(searchSkills(all, "alpha")[0].skill.name, "alpha");
  assert.equal(searchSkills(all, "VAT return invoice")[0].skill.name, "alpha");
  assert.equal(searchSkills(all, "level 10")[0].skill.name, "beta");
  assert.equal(searchSkills(all, "zzzz").length, 0);
});
test("filters: category, limit", async () => {
  const { cat } = await catalogFor(["--lib", `a=${libA}`, "--lib", `b=${libB}`]);
  const ops = searchSkills(cat.all(), "", { category: "ops" });
  assert.deepEqual(ops.map((h) => h.skill.skillPath).sort(), ["a/shared", "b/beta", "b/shared"]);
  assert.equal(searchSkills(cat.all(), "shared", { limit: 1 }).length, 1);
});
