/**
 * `skills-mcp pack`: build a distributable pack from a vault.
 *
 * The pack is the boundary the server serves, so it contains exactly the public content and
 * nothing else:
 *
 *   00-CORE/Agents/skills/                     every skill the server would serve (same ignore rules)
 *   00-CORE/Playbooks/                         playbooks at `status: active` and the files they embed
 *   20-COMPANY/03-PROCESSES/value-chains.md    the canonical chain definitions (or VALUE-CHAINS.md)
 *   pack.json                                  what was packed and by which generator
 *
 * Company, personal and client folders are never read. `_archive/` and `UPGRADE/` are skipped.
 * The zip is deterministic for the same input (sorted entries, fixed timestamps) and gets a
 * `<out>.sha256` sidecar; the command prints the pinned `--lib` line to hand to consumers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { PKG_VERSION } from "./version.js";
import { splitFrontmatter, coerceString } from "./frontmatter.js";
import { isArchivePath } from "./archive.js";
import { PLAYBOOK_DIR, VALUE_CHAIN_FILES } from "./vault.js";

export interface PackOptions {
  vault: string;
  out?: string;
  /** Top-level folder inside the zip (GitHub-release style). Default: none. */
  wrapper?: string;
  /** Include playbooks of every status, not only `active`. */
  allStatuses: boolean;
  /** Per-file ceiling; larger files are left out with a warning (the server would not serve them either). */
  maxFileBytes: number;
  dryRun: boolean;
  log: (msg: string) => void;
}

export interface PackResult {
  out: string;
  sha256: string;
  skills: number;
  playbooks: number;
  chainFile?: string;
  files: number;
  bytes: number;
  warnings: string[];
}

const SKILLS_DIR = path.join("00-CORE", "Agents", "skills");
const IGNORE_DIRS = new Set([".venv", "venv", "node_modules", "__pycache__", ".git", ".pytest_cache", ".mypy_cache", ".ruff_cache", "site-packages", "_archive", "_audit"]);
const IGNORE_EXTS = new Set([".pyc", ".pyo", ".so", ".dylib", ".dll", ".whl", ".pyi"]);
const PLAYBOOK_SKIP_DIRS = new Set(["_archive", "UPGRADE"]);
const NON_PLAYBOOK_FILES = new Set(["AGENTS.md", "CLAUDE.md", "_local.md"]);
const EMBED_RE = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;

interface Entry { name: string; abs?: string; data?: Buffer }

const PACK_HELP = `skills-mcp pack --vault DIR [--out FILE.zip] [--wrapper NAME] [--all-statuses] [--dry-run]

  Build a distributable pack from a vault: 00-CORE/Agents/skills, the active playbooks in
  00-CORE/Playbooks (with the files they embed) and the canonical value-chains file. Nothing
  else is read. Writes FILE.zip and FILE.zip.sha256 and prints the pinned --lib line.

  --vault DIR        vault root (contains 00-CORE/Agents/skills)
  --out FILE         output zip, default <vault-name>-<YYYY-MM-DD>.zip in the current directory
  --wrapper NAME     put everything under one top-level folder NAME/ inside the zip
  --all-statuses     include draft/review/retired playbooks too (default: active only)
  --dry-run          list what would be packed, write nothing
  env SKILLS_MAX_FILE_BYTES (default 4 MiB): larger files are left out, as the server would
`;

export function parsePackArgs(argv: string[]): PackOptions {
  const o: PackOptions = { vault: "", allStatuses: false, maxFileBytes: Number(process.env.SKILLS_MAX_FILE_BYTES ?? 4 * 1024 * 1024), dryRun: false, log: (m) => process.stderr.write(m + "\n") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value\n${PACK_HELP}`); return v; };
    if (a === "--vault") o.vault = next();
    else if (a === "--out") o.out = next();
    else if (a === "--wrapper") o.wrapper = next().replace(/^\/+|\/+$/g, "");
    else if (a === "--all-statuses") o.allStatuses = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") { process.stderr.write(PACK_HELP); process.exit(0); }
    else throw new Error(`Unknown argument ${a}\n${PACK_HELP}`);
  }
  if (!o.vault) throw new Error(`--vault DIR is required\n${PACK_HELP}`);
  return o;
}

async function isDir(p: string): Promise<boolean> { try { return (await fs.lstat(p)).isDirectory(); } catch { return false; } }
async function isFile(p: string): Promise<boolean> { try { return (await fs.lstat(p)).isFile(); } catch { return false; } }
async function within(root: string, candidate: string): Promise<boolean> {
  try { return (await fs.realpath(candidate)).startsWith((await fs.realpath(root)) + path.sep); } catch { return false; }
}
async function isRegularFile(p: string): Promise<boolean> { try { return (await fs.lstat(p)).isFile(); } catch { return false; } }
async function readRegularFile(p: string): Promise<Buffer> {
  const handle = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw new Error(`${p} is not a regular file`); return await handle.readFile(); }
  finally { await handle.close(); }
}
const rel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** Every file of one skill directory that the server would serve; null when the skill bundles an archive. */
async function skillFiles(dir: string, o: PackOptions, warnings: string[], skillRel: string): Promise<string[] | null> {
  const out: string[] = [];
  const walk = async (d: string): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".") || e.name.endsWith(".dist-info") || e.name.endsWith(".egg-info")) continue;
        if (!(await walk(abs))) return false;
      } else if (e.isFile()) {
        if (isArchivePath(e.name)) { warnings.push(`${skillRel}: bundles an archive (${rel(dir, abs)}); the server refuses such skills, skill left out`); return false; }
        if (e.name.startsWith(".") || IGNORE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
        const st = await fs.stat(abs);
        if (st.size > o.maxFileBytes) { warnings.push(`${skillRel}: ${rel(dir, abs)} is ${(st.size / 1048576).toFixed(1)} MiB, over the per-file limit, left out`); continue; }
        out.push(abs);
      }
    }
    return true;
  };
  if (!(await walk(dir))) return null;
  const instruction = path.join(dir, "SKILL.md");
  if (!out.includes(instruction)) { warnings.push(`${skillRel}: SKILL.md cannot be served; skill left out`); return null; }
  const { data } = splitFrontmatter(await fs.readFile(instruction, "utf8"));
  if (!data || data.name !== path.basename(dir) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(data.name)) || typeof data.description !== "string" || !data.description.trim()) {
    warnings.push(`${skillRel}: invalid required frontmatter; skill left out`);
    return null;
  }
  if (out.length > 512 || (await Promise.all(out.map(async (f) => (await fs.stat(f)).size))).reduce((a, b) => a + b, 0) > 16 * 1024 * 1024) {
    warnings.push(`${skillRel}: exceeds the skill file or byte limit; skill left out`);
    return null;
  }
  return out;
}

/** Skill directories (folders holding SKILL.md) below the skills root, up to 4 levels, never descending into a skill. */
async function findSkills(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  if (depth > 0 && entries.some((e) => e.name === "SKILL.md" && e.isFile())) { out.push(root); return out; }
  if (depth >= 4) return out;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
    await findSkills(path.join(root, e.name), depth + 1, out);
  }
  return out;
}

async function findPlaybooks(root: string, o: PackOptions, warnings: string[]): Promise<{ notes: string[]; attachments: string[]; skipped: number }> {
  const notes: string[] = [], attachments = new Set<string>();
  let skipped = 0;
  const walk = async (d: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { if (!PLAYBOOK_SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && depth < 4) await walk(abs, depth + 1); continue; }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md") || NON_PLAYBOOK_FILES.has(e.name)) continue;
      const text = await fs.readFile(abs, "utf8");
      const { data, body } = splitFrontmatter(text);
      if (!data || coerceString(data.type).toLowerCase() !== "playbook") continue;
      const status = (coerceString(data.status) || "active").toLowerCase();
      if (status !== "active" && !o.allStatuses) { skipped++; continue; }
      notes.push(abs);
      for (const m of body.matchAll(EMBED_RE)) {
        const name = m[1].trim();
        if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".") || isArchivePath(name)) continue;
        const a = path.join(d, name);
        if (await isRegularFile(a)) {
          if ((await fs.stat(a)).size > o.maxFileBytes) warnings.push(`playbook ${e.name}: embedded ${name} is over the per-file limit, left out`);
          else attachments.add(a);
        } else warnings.push(`playbook ${e.name}: embedded file ${name} not found next to it`);
      }
    }
  };
  await walk(root, 0);
  return { notes, attachments: [...attachments], skipped };
}

// ---- zip writer (stored or deflated, crc32, fixed timestamp, 0644) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00: deterministic archives

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const payload = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + payload.length;
  }
  const localBuf = Buffer.concat(locals), cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

export async function pack(o: PackOptions): Promise<PackResult> {
  const vault = path.resolve(o.vault);
  const warnings: string[] = [];
  const skillsRoot = path.join(vault, SKILLS_DIR);
  if (!(await isDir(skillsRoot)) || !(await within(vault, skillsRoot))) throw new Error(`${vault} is not a vault: no safe ${SKILLS_DIR} inside`);
  const entries: Entry[] = [];
  const prefix = o.wrapper ? o.wrapper + "/" : "";

  // Skills
  let skillCount = 0;
  for (const dir of (await findSkills(skillsRoot)).sort()) {
    const skillRel = rel(skillsRoot, dir);
    const files = await skillFiles(dir, o, warnings, skillRel);
    if (!files) continue;
    skillCount++;
    for (const f of files) entries.push({ name: prefix + rel(vault, f), abs: f });
  }

  // Playbooks
  const pbRoot = path.join(vault, PLAYBOOK_DIR);
  let playbookCount = 0;
  if (await isDir(pbRoot) && await within(vault, pbRoot)) {
    const r = await findPlaybooks(pbRoot, o, warnings);
    playbookCount = r.notes.length;
    for (const f of [...r.notes, ...r.attachments].sort()) entries.push({ name: prefix + rel(vault, f), abs: f });
    if (r.skipped) o.log(`${r.skipped} playbook(s) not at status active left out (use --all-statuses to include)`);
  } else warnings.push(`no ${PLAYBOOK_DIR} in the vault: no playbooks packed`);

  // Value chains: the canonical file only. The generated index names playbooks from private folders.
  let chainFile: string | undefined;
  for (const relPath of VALUE_CHAIN_FILES) {
    const abs = path.join(vault, relPath);
    if (await isFile(abs) && await within(vault, abs)) { chainFile = relPath; entries.push({ name: prefix + relPath, abs }); break; }
  }
  if (!chainFile) warnings.push("no value-chains file found: value chains will be derived from frontmatter only");
  else if (chainFile !== VALUE_CHAIN_FILES[0]) warnings.push(`packed ${chainFile}: the generated index may name playbooks that are not in the pack`);

  const manifest = {
    generator: `skills-mcp ${PKG_VERSION} pack`,
    ...(process.env.SOURCE_DATE_EPOCH ? { created: new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() } : {}),
    vault: path.basename(vault),
    skills: skillCount, playbooks: playbookCount, valueChains: chainFile ?? null,
    contents: [SKILLS_DIR.split(path.sep).join("/"), PLAYBOOK_DIR, ...(chainFile ? [chainFile] : [])],
  };
  entries.push({ name: prefix + "pack.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out = path.resolve(o.out ?? `${path.basename(vault)}-${new Date().toISOString().slice(0, 10)}.zip`);
  if (o.dryRun) {
    for (const e of entries) o.log(e.name);
    for (const w of warnings) o.log(`warning: ${w}`);
    return { out, sha256: "", skills: skillCount, playbooks: playbookCount, chainFile, files: entries.length, bytes: 0, warnings };
  }
  const loaded: { name: string; data: Buffer }[] = [];
  let bytes = 0;
  for (const e of entries) { const data = e.data ?? await readRegularFile(e.abs!); bytes += data.length; loaded.push({ name: e.name, data }); }
  const zip = buildZip(loaded);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = out + ".tmp";
  await fs.writeFile(tmp, zip);
  await fs.rename(tmp, out);
  await fs.writeFile(out + ".sha256", `${sha256}  ${path.basename(out)}\n`);
  for (const w of warnings) o.log(`warning: ${w}`);
  o.log(`packed ${skillCount} skills, ${playbookCount} playbooks, ${chainFile ? "1 chain file" : "no chain file"}: ${entries.length} files, ${(bytes / 1048576).toFixed(1)} MiB → ${out} (${(zip.length / 1048576).toFixed(1)} MiB)`);
  o.log(`sha256 ${sha256}`);
  o.log(`serve:  skills-mcp --lib bob='${out}'`);
  o.log(`pinned: skills-mcp --lib bob='https://<host>/${path.basename(out)}#sha256=${sha256}'`);
  return { out, sha256, skills: skillCount, playbooks: playbookCount, chainFile, files: entries.length, bytes, warnings };
}
