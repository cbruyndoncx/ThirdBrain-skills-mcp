/**
 * Security tests for zip-backed libraries.
 *
 * Archives here are built byte by byte rather than with a zip tool, because the interesting cases
 * are ones a well-behaved tool will not produce: a central directory that lies about uncompressed
 * size, a symlink entry, an entry named "../...".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  extractZip, extractLibrary, pruneCache, safeEntryName, isArchivePath,
  ArchiveError, DEFAULT_LIMITS, type ExtractLimits,
} from "../../src/archive.js";

const SIG_LOCAL = 0x04034b50, SIG_CD = 0x02014b50, SIG_EOCD = 0x06054b50;

interface E {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
  /** Override the size written into both headers (to model a lying archive). */
  declaredSize?: number;
  /** Unix mode in the high half of external attributes (0xA1FF => symlink). */
  unixMode?: number;
  flags?: number;
  method?: number;
  dir?: boolean;
}

function buildZip(entries: E[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.dir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const deflate = !!e.deflate;
    const payload = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.method ?? (deflate ? 8 : 0);
    const usize = e.declaredSize ?? raw.length;
    const flags = e.flags ?? 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(0, 14);            // crc, not verified by the parser
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE(0x0314, 4);        // made by unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((e.unixMode ?? 0o644) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);

    offset += 30 + name.length + payload.length;
  }

  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

const SKILL_MD = "---\nname: myskill\ndescription: d\n---\n# hi\n";

async function tmpdir(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "skills-arc-"));
}

async function writeZip(entries: E[]): Promise<{ zip: string; dest: string; base: string }> {
  const base = await tmpdir();
  const zip = path.join(base, "lib.zip");
  await fsp.writeFile(zip, buildZip(entries));
  return { zip, dest: path.join(base, "out"), base };
}

async function rejects(entries: E[], match: RegExp, limits: ExtractLimits = DEFAULT_LIMITS) {
  const { zip, dest, base } = await writeZip(entries);
  await assert.rejects(() => extractZip(zip, dest, limits), (e: Error) => {
    assert.ok(e instanceof ArchiveError, `expected ArchiveError, got ${e.constructor.name}: ${e.message}`);
    assert.match(e.message, match);
    return true;
  });
  await fsp.rm(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------- name safety

test("safeEntryName rejects traversal and absolute paths", () => {
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "..", ""]) {
    assert.throws(() => safeEntryName(bad), ArchiveError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(safeEntryName("a/./b.md"), "a/b.md");
  assert.equal(safeEntryName("skill/SKILL.md"), "skill/SKILL.md");
});

test("zip slip: entry escaping via ../ is rejected", async () => {
  await rejects([{ name: "../../evil.md", data: "pwned" }], /escapes the archive root/);
});

test("zip slip: absolute entry path is rejected", async () => {
  await rejects([{ name: "/etc/cron.d/evil", data: "pwned" }], /absolute path/);
});

test("symlink entries are rejected", async () => {
  await rejects([{ name: "s/link", data: "/home/cb/.ssh/id_rsa", unixMode: 0o120777 }], /is a symlink/);
});

test("encrypted entries are rejected", async () => {
  await rejects([{ name: "s/secret.md", data: "x", flags: 0x1 }], /is encrypted/);
});

test("unsupported compression methods are rejected", async () => {
  await rejects([{ name: "s/a.md", data: "x", method: 12 }], /unsupported compression method/);
});

// ---------------------------------------------------------------- the archive rule

test("nested archives are rejected, whatever the extension", async () => {
  assert.ok(isArchivePath("a/b/payload.zip"));
  assert.ok(isArchivePath("a/payload.tgz"));
  assert.ok(isArchivePath("a/payload.tar.gz"));
  assert.ok(isArchivePath("x.7z"));
  assert.ok(!isArchivePath("notes.md"));
  await rejects([{ name: "s/payload.zip", data: "x" }], /nested archives are not allowed/);
  await rejects([{ name: "s/payload.tgz", data: "x" }], /nested archives are not allowed/);
});

// ---------------------------------------------------------------- bombs

test("declared compression ratio over the limit is rejected", async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 0); // deflates to almost nothing
  await rejects([{ name: "s/bomb.bin", data: big, deflate: true }], /compression ratio/);
});

test("highly compressible but small content is not mistaken for a bomb", async () => {
  // Ordinary skill content (repetitive tables, pretty-printed JSON) beats 200:1 routinely.
  const { zip, dest, base } = await writeZip([{ name: "s/table.md", data: "x".repeat(200_000), deflate: true }]);
  const r = await extractZip(zip, dest, DEFAULT_LIMITS);
  assert.equal(r.bytes, 200_000);
  await fsp.rm(base, { recursive: true, force: true });
});

test("a central directory that lies about size cannot smuggle bytes past the budget", async () => {
  // Declares 10 bytes (so every pre-check passes) but actually inflates to 2 MiB.
  const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const limits: ExtractLimits = { maxEntries: 16, maxTotalBytes: 64 * 1024, maxEntryBytes: 64 * 1024, maxRatio: 100, ratioFloorBytes: 1024 * 1024 };
  await rejects([{ name: "s/liar.bin", data: big, deflate: true, declaredSize: 10 }], /extraction budget/, limits);
});

test("too many entries is rejected", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `s/f${i}.md`, data: "x" }));
  await rejects(many, /entries, over the/, { ...DEFAULT_LIMITS, maxEntries: 5 });
});

test("a rejected archive leaves no partial tree behind", async () => {
  const { zip, dest, base } = await writeZip([
    { name: "s/ok.md", data: "fine" },
    { name: "../escape.md", data: "pwned" },
  ]);
  await assert.rejects(() => extractZip(zip, dest, DEFAULT_LIMITS));
  await assert.rejects(() => fsp.stat(dest), /ENOENT/, "destination should not exist after a rejected archive");
  await fsp.rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- happy path

test("a well-formed archive extracts, non-executable", async () => {
  const { zip, dest, base } = await writeZip([
    { name: "myskill/", dir: true },
    { name: "myskill/SKILL.md", data: SKILL_MD },
    { name: "myskill/scripts/run.py", data: "print('hello')\n", deflate: true },
    { name: "myskill/references/big.md", data: "x".repeat(5000), deflate: true },
  ]);
  const r = await extractZip(zip, dest, DEFAULT_LIMITS);
  assert.equal(r.entries, 3);
  assert.equal(r.bytes, SKILL_MD.length + "print('hello')\n".length + 5000);

  assert.match(await fsp.readFile(path.join(dest, "myskill/SKILL.md"), "utf8"), /name: myskill/);
  assert.equal(await fsp.readFile(path.join(dest, "myskill/scripts/run.py"), "utf8"), "print('hello')\n");
  const st = await fsp.stat(path.join(dest, "myskill/scripts/run.py"));
  assert.equal(st.mode & 0o111, 0, "extracted files must never be executable");
  await fsp.rm(base, { recursive: true, force: true });
});

test("extractLibrary caches by content digest and prunes what is unreferenced", async () => {
  const base = await tmpdir();
  const zip = path.join(base, "lib.zip");
  const cache = path.join(base, "cache");
  await fsp.writeFile(zip, buildZip([{ name: "s/SKILL.md", data: "---\nname: s\ndescription: d\n---\n" }]));

  const first = await extractLibrary(zip, cache, DEFAULT_LIMITS);
  assert.equal(first.cached, false);
  assert.equal(first.entries, 1);

  const second = await extractLibrary(zip, cache, DEFAULT_LIMITS);
  assert.equal(second.cached, true, "same digest should reuse the extraction");
  assert.equal(second.dir, first.dir);

  // A different archive gets its own directory, and pruning drops the one no longer referenced.
  await fsp.writeFile(zip, buildZip([{ name: "t/SKILL.md", data: "---\nname: t\ndescription: d\n---\n" }]));
  const third = await extractLibrary(zip, cache, DEFAULT_LIMITS);
  assert.notEqual(third.digest, first.digest);
  assert.equal((await fsp.readdir(cache)).length, 2);

  const removed = await pruneCache(cache, new Set([third.digest]));
  assert.equal(removed, 1);
  assert.deepEqual(await fsp.readdir(cache), [third.digest]);
  await fsp.rm(base, { recursive: true, force: true });
});
