import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { loadConfig, reloadConfigFile } from "../../src/config.js";
import { Catalog } from "../../src/catalog.js";
import { fetchArchive } from "../../src/remote.js";
import { pack, parsePackArgs } from "../../src/pack.js";
import { pull } from "../../src/pull.js";
import { FIX, libA, libB } from "./helpers.js";

test("reload keeps CLI script restriction and rejects an empty file atomically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-config-"));
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify({ libraries: [{ namespace: "a", root: libA }], noScripts: false }));
  const cfg = loadConfig(["--config", file, "--no-scripts"]);
  assert.equal(cfg.noScripts, true);
  reloadConfigFile(cfg, []);
  assert.equal(cfg.noScripts, true);
  await fs.writeFile(file, JSON.stringify({ libraries: [] }));
  assert.throws(() => reloadConfigFile(cfg, []), /at least one library/);
  assert.equal(cfg.libraries.length, 1);
  assert.equal(cfg.root, libA);
});

test("playbook attachments reject symlinks and scripts under noScripts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-vault-"));
  await fs.cp(path.join(FIX, "vault"), dir, { recursive: true });
  const playbooks = path.join(dir, "00-CORE", "Playbooks");
  const external = path.join(os.tmpdir(), `skills-review-outside-${process.pid}`);
  await fs.writeFile(external, "private fixture");
  await fs.symlink(external, path.join(playbooks, "outside.txt"));
  await fs.writeFile(path.join(playbooks, "run.py"), "print('fixture')\n");
  await fs.writeFile(path.join(playbooks, "Safe.md"), "---\ntype: playbook\nstatus: active\n---\n![[outside.txt]] ![[run.py]]\n");
  const cfg = loadConfig(["--root", dir, "--no-scripts"]);
  const cat = new Catalog(cfg);
  await cat.scan();
  assert.deepEqual(cat.getPlaybook("Safe")?.attachments, []);
  await fs.rm(external);
});

test("a changed support file triggers a catalog change notification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-catalog-"));
  await fs.cp(libA, dir, { recursive: true });
  const cat = new Catalog(loadConfig(["--root", dir]));
  await cat.scan();
  const file = path.join(dir, "alpha", "reference.txt");
  await fs.writeFile(file, "aaa");
  await cat.scan();
  let changes = 0;
  cat.onChange(() => changes++);
  await fs.writeFile(file, "bbb");
  await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
  await cat.scan();
  assert.equal(changes, 1);
});

test("cached remote archive bytes are checked against their digest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-remote-"));
  const good = Buffer.from("verified archive fixture");
  const digest = createHash("sha256").update(good).digest("hex");
  await fs.mkdir(path.join(dir, "downloads"));
  await fs.writeFile(path.join(dir, "downloads", `${digest}.zip`), "tampered");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(good); };
  try {
    const got = await fetchArchive("https://example.test/library.zip", { cacheDir: dir, maxBytes: 1024, expectedSha256: digest, timeoutMs: 1000 });
    assert.equal(got.cached, false);
    assert.equal(requests, 1);
    assert.deepEqual(await fs.readFile(got.file), good);
  } finally { globalThis.fetch = originalFetch; }
});

test("wrapped archive still serves skills when extras are disabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-pack-"));
  const output = path.join(dir, "pack.zip");
  await pack({ ...parsePackArgs(["--vault", path.join(FIX, "vault"), "--out", output, "--wrapper", "release"]), log: () => {} });
  const cfg = loadConfig(["--root", output, "--no-playbooks", "--no-value-chains"]);
  cfg.cacheDir = path.join(dir, "cache");
  const cat = new Catalog(cfg);
  await cat.scan();
  assert.equal(cat.all().length, 3);
});

test("changing a remote pin invalidates the in-process library", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-pin-"));
  const output = path.join(dir, "pack.zip");
  const packed = await pack({ ...parsePackArgs(["--vault", path.join(FIX, "vault"), "--out", output]), log: () => {} });
  const bytes = await fs.readFile(output);
  const cfg = loadConfig(["--root", `https://example.test/library.zip#sha256=${packed.sha256}`]);
  cfg.cacheDir = path.join(dir, "cache");
  const cat = new Catalog(cfg);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes);
  try {
    await cat.scan();
    assert.equal(cat.getStats().libraries[0].digest, packed.sha256);
    cfg.libraries[0].sha256 = "0".repeat(64);
    await assert.rejects(cat.scan(), /sha256 mismatch/);
  } finally { globalThis.fetch = originalFetch; }
});

test("another catalog scan cannot prune a live archive from the shared cache", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-cache-"));
  const a = path.join(dir, "a.zip"), b = path.join(dir, "b.zip");
  await pack({ ...parsePackArgs(["--vault", path.join(FIX, "vault"), "--out", a]), log: () => {} });
  await pack({ ...parsePackArgs(["--vault", path.join(FIX, "vault2"), "--out", b]), log: () => {} });
  const cacheDir = path.join(dir, "cache");
  const first = loadConfig(["--root", a]); first.cacheDir = cacheDir;
  const second = loadConfig(["--root", b]); second.cacheDir = cacheDir;
  const firstCat = new Catalog(first); await firstCat.scan();
  const file = firstCat.all()[0].files[0].abs;
  const secondCat = new Catalog(second); await secondCat.scan();
  assert.ok(await fs.stat(file));
});

test("a changed extracted file is refused on rescan", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-extracted-"));
  const output = path.join(dir, "pack.zip");
  await pack({ ...parsePackArgs(["--vault", path.join(FIX, "vault"), "--out", output]), log: () => {} });
  const cfg = loadConfig(["--root", output]); cfg.cacheDir = path.join(dir, "cache");
  const cat = new Catalog(cfg); await cat.scan();
  await fs.writeFile(cat.all()[0].files[0].abs, "tampered");
  await assert.rejects(cat.scan(), /cached extraction.*changed on disk/);
});

test("skills with invalid frontmatter are withheld", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-invalid-"));
  await fs.mkdir(path.join(dir, "wrong"));
  await fs.writeFile(path.join(dir, "wrong", "SKILL.md"), "---\nname: different\n---\nbody\n");
  const cat = new Catalog(loadConfig(["--root", dir]));
  await cat.scan();
  assert.equal(cat.all().length, 0);
  assert.match(cat.getStats().warnings.join("\n"), /skill not served/);
});

test("pull rejects a symlink destination and duplicate skill names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-review-pull-"));
  const outside = path.join(dir, "outside");
  const target = path.join(dir, "target");
  await fs.mkdir(outside);
  await fs.mkdir(target);
  await fs.symlink(outside, path.join(target, "beta"));
  const tsx = path.resolve("node_modules/.bin/tsx");
  const entry = path.resolve("src/index.ts");
  const base = { skills: ["beta"], all: false, list: false, to: target, keepPath: false, force: false, sync: true, dryRun: false, log: () => {} };
  await assert.rejects(pull({ ...base, command: [tsx, entry, "--root", libB] }), /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(pull({ ...base, command: [tsx, entry, "--lib", `a=${libA}`, "--lib", `b=${libB}`], skills: [], all: true }), /share destination/);
});

test("HTTP rejects an untrusted Origin", async () => {
  const tsx = path.resolve("node_modules/.bin/tsx");
  const entry = path.resolve("src/index.ts");
  const port = 43000 + Math.floor(Math.random() * 1000);
  const proc = spawn(tsx, [entry, "--root", libA, "--http", String(port)], { stdio: "ignore" });
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(url); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(ready, "HTTP fixture started");
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "http://untrusted.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "review", version: "1" } } }) });
    assert.equal(response.status, 403);
  } finally { proc.kill(); }
});
