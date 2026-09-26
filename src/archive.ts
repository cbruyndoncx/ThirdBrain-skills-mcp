/**
 * Zip-backed skill libraries.
 *
 * A library root may be a `.zip` instead of a directory. The archive is a transport container:
 * it is extracted once into a digest-keyed cache directory, and everything downstream (discovery,
 * walk, lint, digests, URIs) then works on ordinary files and needs no knowledge of archives.
 *
 * The parser is deliberately strict and rejects anything unusual rather than trying to cope:
 * no zip64, no encryption, no compression method other than stored/deflate, no symlinks. Archive
 * files are never served, so the only zip in play is the library container itself.
 *
 * Threat model: the archive is untrusted input.
 *  - path traversal ("zip slip") — every entry must resolve inside the destination
 *  - symlink escape — symlink entries are rejected, never materialised
 *  - decompression bombs — a hard byte budget is enforced *during* inflation, because the sizes
 *    declared in the central directory are attacker-controlled and may lie
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/** Archive extensions that may never appear *inside* a skill library. Nested archives hide content from the linter. */
export const ARCHIVE_EXTENSIONS =
  /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|xz|7z|rar|jar|war|ear|apk|iso|dmg|cab)$/i;

export function isArchivePath(p: string): boolean {
  return ARCHIVE_EXTENSIONS.test(p);
}

/** A library root pointing at an archive rather than a directory. */
export function isArchiveRoot(root: string): boolean {
  return /\.zip$/i.test(root);
}

export interface ExtractLimits {
  /** Max number of entries in the archive. */
  maxEntries: number;
  /** Max total uncompressed bytes. Enforced while inflating, not from declared sizes. */
  maxTotalBytes: number;
  /** Max uncompressed bytes for a single entry. */
  maxEntryBytes: number;
  /**
   * Max uncompressed/compressed ratio for a single entry (declared sizes; cheap pre-filter).
   * Only applied to entries larger than `ratioFloorBytes`: ordinary skill content compresses very
   * well (a repetitive markdown table or a pretty-printed JSON easily beats 200:1), so ratio alone
   * is not evidence of a bomb. The absolute byte budgets are what actually contain one.
   */
  maxRatio: number;
  /** Entries at or below this uncompressed size skip the ratio check. */
  ratioFloorBytes: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxEntries: 8192,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
};

export interface ExtractResult {
  /** Directory the archive was extracted into; hand this to discovery as the effective root. */
  dir: string;
  digest: string;
  entries: number;
  bytes: number;
  /** True when a previous extraction of the same digest was reused. */
  cached: boolean;
  ms: number;
}

export class ArchiveError extends Error {}

interface Entry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  unixMode: number;
  isDir: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const INTEGRITY_FILE = ".skills-mcp-integrity.json";

export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "skills-mcp");
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

/**
 * Reject entry names that could escape the destination directory.
 * Returns the safe relative path (forward slashes, no leading slash).
 */
export function safeEntryName(raw: string): string {
  if (!raw) throw new ArchiveError("archive contains an entry with an empty name");
  if (raw.includes("\0")) throw new ArchiveError(`archive entry '${raw}' contains a NUL byte`);
  // Backslashes are not a path separator in zip; treat them as literal but refuse, since
  // extracting on Windows would turn them into separators and defeat the checks below.
  if (raw.includes("\\")) throw new ArchiveError(`archive entry '${raw}' contains a backslash`);
  if (raw.startsWith("/")) throw new ArchiveError(`archive entry '${raw}' is an absolute path`);
  if (/^[a-zA-Z]:/.test(raw)) throw new ArchiveError(`archive entry '${raw}' has a drive letter`);
  const segs = raw.split("/");
  for (const s of segs) {
    if (s === "..") throw new ArchiveError(`archive entry '${raw}' escapes the archive root`);
  }
  const rel = segs.filter((s) => s !== "" && s !== ".").join("/");
  if (!rel) throw new ArchiveError(`archive entry '${raw}' resolves to nothing`);
  return rel;
}

/** Second line of defence: the resolved path must stay inside dest. */
function resolveInside(dest: string, rel: string): string {
  const abs = path.resolve(dest, rel);
  const prefix = dest.endsWith(path.sep) ? dest : dest + path.sep;
  if (abs !== dest && !abs.startsWith(prefix)) {
    throw new ArchiveError(`archive entry '${rel}' escapes the archive root`);
  }
  return abs;
}

async function readAt(fd: fsp.FileHandle, len: number, pos: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new ArchiveError("archive is truncated");
  return buf;
}

/** Locate and parse the End Of Central Directory record. */
async function readEocd(fd: fsp.FileHandle, size: number): Promise<{ cdOffset: number; cdSize: number; count: number }> {
  if (size < EOCD_MIN) throw new ArchiveError("file is too small to be a zip archive");
  const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
  const tail = await readAt(fd, tailLen, size - tailLen);
  let off = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { off = i; break; }
  }
  if (off < 0) throw new ArchiveError("not a zip archive (no end-of-central-directory record)");
  const diskNo = tail.readUInt16LE(off + 4);
  const cdDisk = tail.readUInt16LE(off + 6);
  const count = tail.readUInt16LE(off + 10);
  const cdSize = tail.readUInt32LE(off + 12);
  const cdOffset = tail.readUInt32LE(off + 16);
  if (diskNo !== 0 || cdDisk !== 0) throw new ArchiveError("multi-disk zip archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError("zip64 archives are not supported; split the library into smaller archives");
  }
  if (cdOffset + cdSize > size) throw new ArchiveError("archive is truncated (central directory past end of file)");
  return { cdOffset, cdSize, count };
}

function parseCentralDirectory(cd: Buffer, count: number): Entry[] {
  const out: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length) throw new ArchiveError("central directory is truncated");
    if (cd.readUInt32LE(p) !== SIG_CD) throw new ArchiveError("central directory is corrupt");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) throw new ArchiveError("central directory is truncated");
    const rawName = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({
      name: rawName,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      unixMode: (externalAttrs >>> 16) & 0xffff,
      isDir: rawName.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Counts bytes flowing through and fails the stream the moment a budget is exceeded. */
function budgetCounter(limit: number, label: string, onBytes: (n: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) { cb(new ArchiveError(label)); return; }
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

/**
 * Extract `zipPath` into `dest` (which must not already exist as a populated tree).
 * Returns the number of entries and total uncompressed bytes written.
 */
export async function extractZip(zipPath: string, dest: string, limits: ExtractLimits): Promise<{ entries: number; bytes: number }> {
  const fd = await fsp.open(zipPath, "r");
  try {
    const { size } = await fd.stat();
    const { cdOffset, cdSize, count } = await readEocd(fd, size);
    if (count > limits.maxEntries) {
      throw new ArchiveError(`archive has ${count} entries, over the ${limits.maxEntries} limit`);
    }
    const entries = parseCentralDirectory(await readAt(fd, cdSize, cdOffset), count);

    // Validate everything before writing a single byte, so a bad archive leaves no partial tree.
    let declaredTotal = 0;
    for (const e of entries) {
      if (e.name === INTEGRITY_FILE) throw new ArchiveError(`archive entry '${e.name}' is reserved`);
      if (e.flags & 0x1) throw new ArchiveError(`archive entry '${e.name}' is encrypted`);
      if ((e.unixMode & 0xf000) === 0xa000) throw new ArchiveError(`archive entry '${e.name}' is a symlink`);
      if (e.isDir) continue;
      if (e.method !== 0 && e.method !== 8) {
        throw new ArchiveError(`archive entry '${e.name}' uses unsupported compression method ${e.method}`);
      }
      safeEntryName(e.name);
      if (isArchivePath(e.name)) {
        throw new ArchiveError(`archive entry '${e.name}' is itself an archive; nested archives are not allowed`);
      }
      if (e.uncompressedSize > limits.maxEntryBytes) {
        throw new ArchiveError(`archive entry '${e.name}' declares ${e.uncompressedSize} bytes, over the ${limits.maxEntryBytes} per-file limit`);
      }
      if (e.uncompressedSize > limits.ratioFloorBytes && e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > limits.maxRatio) {
        throw new ArchiveError(`archive entry '${e.name}' has a ${Math.round(e.uncompressedSize / e.compressedSize)}:1 compression ratio, over the ${limits.maxRatio}:1 limit`);
      }
      declaredTotal += e.uncompressedSize;
    }
    if (declaredTotal > limits.maxTotalBytes) {
      throw new ArchiveError(`archive declares ${declaredTotal} uncompressed bytes, over the ${limits.maxTotalBytes} limit`);
    }

    await fsp.mkdir(dest, { recursive: true });
    let written = 0;
    let fileCount = 0;
    for (const e of entries) {
      if (e.isDir) {
        const rel = safeEntryName(e.name);
        await fsp.mkdir(resolveInside(dest, rel), { recursive: true });
        continue;
      }
      const rel = safeEntryName(e.name);
      const abs = resolveInside(dest, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });

      // The local header's name/extra lengths may differ from the central directory's.
      const lh = await readAt(fd, 30, e.localHeaderOffset);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new ArchiveError(`archive entry '${e.name}' has a corrupt local header`);
      const dataStart = e.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (dataStart + e.compressedSize > size) throw new ArchiveError(`archive entry '${e.name}' is truncated`);

      // Budget is the smaller of what this entry may use and what is left overall. Enforced on the
      // *inflated* stream, so a lying central directory cannot smuggle bytes past the cap.
      const remaining = limits.maxTotalBytes - written;
      const cap = Math.min(limits.maxEntryBytes, remaining);
      const counter = budgetCounter(cap, `archive entry '${e.name}' exceeds the ${limits.maxTotalBytes} byte extraction budget`, (n) => { written += n; });

      if (e.compressedSize === 0) { // empty file: nothing to stream (a range with end -1 is rejected by Node ≥ 24)
        await fsp.writeFile(abs, "", { mode: 0o644 });
        fileCount++;
        continue;
      }
      const src = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + e.compressedSize - 1 });
      const sink = fs.createWriteStream(abs, { mode: 0o644 }); // never executable

      if (e.method === 0) {
        await pipeline(src, counter, sink);
      } else {
        await pipeline(src, zlib.createInflateRaw(), counter, sink);
      }
      fileCount++;
    }
    return { entries: fileCount, bytes: written };
  } finally {
    await fd.close();
  }
}

async function treeHashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === INTEGRITY_FILE) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) files[path.relative(root, abs).split(path.sep).join("/")] = await sha256File(abs);
      else throw new ArchiveError(`cached extraction contains a non-regular entry: ${abs}`);
    }
  };
  await walk(root);
  return files;
}

/** Verify cached extracted files before they are served after a process restart. */
export async function verifyExtraction(dir: string): Promise<void> {
  let expected: Record<string, string>;
  try { expected = JSON.parse(await fsp.readFile(path.join(dir, INTEGRITY_FILE), "utf8")); }
  catch { throw new ArchiveError(`cached extraction ${dir} has no integrity record; remove this cache entry`); }
  const actual = await treeHashes(dir);
  const sorted = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (sorted(actual) !== sorted(expected)) throw new ArchiveError(`cached extraction ${dir} changed on disk; remove this cache entry`);
}

/**
 * Resolve an archive library root to a directory of files, extracting it if this exact archive
 * (by content digest) has not been extracted before. Extraction goes to a temp sibling and is
 * renamed into place, so a concurrent rescan never observes a half-written tree.
 */
export async function extractLibrary(zipPath: string, cacheRoot: string, limits: ExtractLimits): Promise<ExtractResult> {
  const t0 = Date.now();
  const digest = await sha256File(zipPath);
  const dir = path.join(cacheRoot, digest);
  try {
    const st = await fsp.stat(dir);
    if (st.isDirectory()) { await verifyExtraction(dir); return { dir, digest, entries: 0, bytes: 0, cached: true, ms: Date.now() - t0 }; }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await fsp.mkdir(cacheRoot, { recursive: true });
  const tmp = path.join(cacheRoot, `.tmp-${digest.slice(0, 12)}-${randomBytes(4).toString("hex")}`);
  try {
    const { entries, bytes } = await extractZip(zipPath, tmp, limits);
    await fsp.writeFile(path.join(tmp, INTEGRITY_FILE), JSON.stringify(await treeHashes(tmp)), { mode: 0o600 });
    try {
      await fsp.rename(tmp, dir);
    } catch (e) {
      // Another process won the race; its tree is equivalent (same digest).
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
    return { dir, digest, entries, bytes, cached: false, ms: Date.now() - t0 };
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Drop cached extractions that no configured archive refers to any more, plus stale temp dirs. */
export async function pruneCache(cacheRoot: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  let names: string[];
  try { names = await fsp.readdir(cacheRoot); } catch { return 0; }
  for (const n of names) {
    if (keep.has(n)) continue;
    if (!/^[0-9a-f]{64}$/.test(n) && !n.startsWith(".tmp-")) continue;
    await fsp.rm(path.join(cacheRoot, n), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
