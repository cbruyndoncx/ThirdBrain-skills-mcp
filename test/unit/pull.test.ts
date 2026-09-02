import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parsePullArgs, pull } from "../../src/pull.js";
import { libA, libB } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "..", "src", "index.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const serverCmd = [tsx, entry, "--lib", `a=${libA}`, "--lib", `b=${libB}`];

test("parsePullArgs", () => {
  const o = parsePullArgs(["alpha", "b/shared", "--to", "/x", "--force", "--command", "node", "s.js", "--root", "r"]);
  assert.deepEqual(o.skills, ["alpha", "b/shared"]);
  assert.equal(o.to, "/x"); assert.equal(o.force, true);
  assert.deepEqual(o.command, ["node", "s.js", "--root", "r"]);
});
test("pull over stdio: list, fetch by name and path, digest-verified, skip existing, keep-path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pull-"));
  const logs: string[] = [];
  const base = { command: serverCmd, all: false, list: false, keepPath: false, force: false, dryRun: false, log: (m: string) => logs.push(m) };
  const listed = await pull({ ...base, skills: [], list: true, to: tmp });
  assert.deepEqual(listed.skills, ["a/alpha", "a/shared", "b/beta", "b/shared"]);
  const r = await pull({ ...base, skills: ["beta", "b/shared"], to: tmp });
  assert.equal(r.written, 3 + 1);
  assert.equal(await fs.readFile(path.join(tmp, "beta", "refs", "notes.md"), "utf8"), "notes here\n");
  const png = await fs.readFile(path.join(tmp, "beta", "refs", "pic.png"));
  assert.equal(png.subarray(0, 4).toString("latin1"), "\x89PNG");
  assert.match(await fs.readFile(path.join(tmp, "shared", "SKILL.md"), "utf8"), /Shared name in library B/);
  const again = await pull({ ...base, skills: ["beta"], to: tmp });
  assert.equal(again.skipped, 1);
  await assert.rejects(pull({ ...base, skills: ["shared"], to: tmp }), /ambiguous/);
  await assert.rejects(pull({ ...base, skills: ["nope"], to: tmp }), /not found/);
  const kp = await pull({ ...base, skills: ["a/shared"], to: tmp, keepPath: true });
  assert.equal(kp.written, 1);
  assert.ok(await fs.stat(path.join(tmp, "a", "shared", "SKILL.md")));
  const dry = await pull({ ...base, skills: ["alpha"], to: tmp, dryRun: true });
  assert.equal(dry.written, 0);
  await assert.rejects(fs.stat(path.join(tmp, "alpha")));
});
