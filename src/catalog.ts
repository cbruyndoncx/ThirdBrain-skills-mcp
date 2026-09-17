import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Config, Library } from "./config.js";

interface Discovered { skillPath: string; abs: string; library: string }
import { splitFrontmatter, coerceString, coerceList } from "./frontmatter.js";
import { lintFiles, SCRIPT_EXTENSIONS, type LintFinding } from "./lint.js";
import { extractLibrary, pruneCache, isArchivePath } from "./archive.js";

export interface SkillFile {
  /** Path relative to the skill directory, always with forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
  /** Lazily computed sha256:<hex>. */
  digest?: string;
}

export interface Skill {
  name: string;           // frontmatter name (must equal the last path segment)
  dir: string;            // directory name on disk
  library: string;        // namespace of the library ("" for un-namespaced)
  skillPath: string;      // URI path incl. namespace, '/'-joined, e.g. "bob/ab-test-setup" or "acme/billing/refunds"
  abs: string;            // absolute directory path
  uri: string;            // skill://<skillPath>/SKILL.md
  description: string;
  category: string;
  version: string;
  tags: string[];
  valueChains: string[];
  requires: string[];
  disabled: boolean;      // disable-model-invocation: true
  userInvocable: boolean;
  frontmatter: Record<string, unknown>;
  frontmatterWarnings: string[];
  body: string;           // SKILL.md without frontmatter
  trust: Record<string, unknown>; // origin/risk/outbound/gate_required/... lifted from frontmatter
  riskFlags: LintFinding[];       // scan-time linter findings (empty when clean or lint disabled)
  scriptsWithheld: number;        // executable files dropped because of noScripts
  files: SkillFile[];     // includes SKILL.md
  totalBytes: number;
  skillMdMtimeMs: number;
}

export interface CatalogStats {
  root: string;
  libraries: { namespace: string; root: string; skills: number; hidden: number; noScripts: boolean }[];
  flaggedSkills: number;
  scriptsWithheld: number;
  /** Skills not served because they bundle an archive file. */
  archiveSkillsRejected: number;
  skills: number;
  hidden: number;
  files: number;
  bytes: number;
  categories: Record<string, number>;
  warnings: string[];
  scannedAt: string;
  scanMs: number;
}

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".toml": "application/toml", ".xml": "application/xml", ".xsd": "application/xml", ".html": "text/html",
  ".py": "text/x-python", ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript",
  ".sh": "text/x-shellscript", ".ps1": "text/plain", ".sql": "application/sql", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Category derived from the path between the library namespace and the skill directory, if any. */
export function parentCategory(skillPath: string, library: string): string {
  const segs = skillPath.split("/");
  if (library) segs.shift();
  segs.pop();
  return segs.join("/");
}

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function isTextMime(m: string): boolean {
  return m.startsWith("text/") || /^(application\/(json|yaml|toml|xml|sql|javascript))$/.test(m) || m === "image/svg+xml";
}

export class Catalog {
  private skills = new Map<string, Skill>();
  private hidden = new Map<string, Skill>();
  private stats!: CatalogStats;
  private scanning: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  /** Per-archive memo so an unchanged zip is not re-hashed or re-extracted on every rescan. */
  private archiveState = new Map<string, { mtimeMs: number; size: number; dir: string; digest: string }>();
  private archiveRejected = 0;

  constructor(private cfg: Config) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStats(): CatalogStats { return this.stats ?? { root: this.cfg.root, libraries: [], flaggedSkills: 0, scriptsWithheld: 0, archiveSkillsRejected: 0, skills: 0, hidden: 0, files: 0, bytes: 0, categories: {}, warnings: [], scannedAt: "", scanMs: 0 }; }
  all(library?: string): Skill[] {
    const v = [...this.skills.values()].filter((s) => library === undefined || s.library === library);
    return v.sort((a, b) => a.skillPath.localeCompare(b.skillPath));
  }
  libraries(): Library[] { return this.cfg.libraries; }
  /** Look up by skill path, or by bare name when unambiguous. */
  get(key: string): Skill | undefined { return this.find(key, false); }
  /** Resolve even hidden skills (skills/get MUST answer for anything the server serves). */
  getAny(key: string): Skill | undefined { return this.find(key, true); }
  private find(key: string, includeHidden: boolean): Skill | undefined {
    const maps = includeHidden ? [this.skills, this.hidden] : [this.skills];
    for (const m of maps) { const s = m.get(key); if (s) return s; }
    // Bare name (unique across all libraries) or "<library>/<name>" for a nested skill inside that library.
    let found: Skill | undefined;
    const [maybeLib, ...rest] = key.split("/");
    const bare = rest.length === 0 ? key : undefined;
    const libName = rest.length > 0 ? rest.join("/") : undefined;
    for (const m of maps) for (const s of m.values()) {
      const hit = bare !== undefined ? s.name === bare : (s.library === maybeLib && s.name === libName);
      if (hit) { if (found && found !== s) return undefined; found = s; }
    }
    return found;
  }

  /** Parse skill://<skill-path>/<file-path>. Longest matching skill path wins. Returns null when not ours. */
  resolveUri(uri: string): { skill: Skill; file?: SkillFile; rel: string } | null {
    if (!uri.startsWith("skill://")) return null;
    const segs = uri.slice("skill://".length).split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    if (segs.some((p) => p === "..")) return null;
    for (let n = segs.length; n >= 1; n--) {
      const skill = this.getAny(segs.slice(0, n).join("/"));
      if (!skill) continue;
      const rel = segs.slice(n).join("/");
      const file = rel ? skill.files.find((f) => f.rel === rel) : undefined;
      return { skill, file, rel };
    }
    return null;
  }

  async digestFor(f: SkillFile): Promise<string> {
    if (f.digest) return f.digest;
    const buf = await fs.readFile(f.abs);
    f.digest = "sha256:" + createHash("sha256").update(buf).digest("hex");
    return f.digest;
  }

  private firstScan: Promise<void> | null = null;
  /** Resolves once the initial scan has completed (or immediately afterwards). Request handlers await this. */
  ready(): Promise<void> { return this.firstScan ?? this.scan(); }

  /** Full rescan. Concurrent callers share one scan. */
  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => { this.scanning = null; });
    this.firstScan ??= this.scanning;
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const t0 = Date.now();
    const warnings: string[] = [];
    this.archiveRejected = 0;
    const next = new Map<string, Skill>();
    const nextHidden = new Map<string, Skill>();
    const dirs: Discovered[] = [];
    for (const lib of this.cfg.libraries) {
      try { await fs.access(lib.root); } catch (e) {
        if (this.cfg.libraries.length === 1) throw new Error(`Cannot read skills root ${lib.root}: ${(e as Error).message}`);
        warnings.push(`library '${lib.namespace}': cannot read ${lib.root}: ${(e as Error).message}`);
        continue;
      }
      let effectiveRoot = lib.root;
      if (lib.archive) {
        try {
          effectiveRoot = await this.resolveArchive(lib);
        } catch (e) {
          const msg = `archive library ${lib.root}: ${(e as Error).message}`;
          if (this.cfg.libraries.length === 1) throw new Error(msg);
          warnings.push(`library '${lib.namespace || "(root)"}': ${msg}`);
          continue;
        }
      }
      await this.discover(lib, effectiveRoot, lib.namespace, 0, dirs);
    }
    if (this.cfg.libraries.some((l) => l.archive)) {
      // Drop extractions for archives that are no longer referenced or have been replaced.
      const keep = new Set([...this.archiveState.values()].map((v) => v.digest));
      await pruneCache(this.cfg.cacheDir, keep).catch(() => 0);
    }
    const oldAll = new Map([...this.skills, ...this.hidden]);

    // Limited concurrency: /mnt/d on WSL is slow for many small stats.
    const CONC = 16;
    let i = 0;
    const worker = async () => {
      while (i < dirs.length) {
        const d = dirs[i++];
        try {
          const s = await this.loadSkill(d, oldAll.get(d.skillPath), warnings);
          if (!s) continue;
          if (next.has(s.skillPath) || nextHidden.has(s.skillPath)) { warnings.push(`${s.skillPath}: duplicate skill path`); continue; }
          (s.disabled && this.cfg.hideDisabled ? nextHidden : next).set(s.skillPath, s);
        } catch (e) {
          warnings.push(`${d.skillPath}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));

    const changed = this.diff(this.skills, next);
    this.skills = next;
    this.hidden = nextHidden;
    const categories: Record<string, number> = {};
    let files = 0, bytes = 0;
    const perLib = new Map(this.cfg.libraries.map((l) => [l.namespace, { namespace: l.namespace, root: l.root, skills: 0, hidden: 0, noScripts: !!(l.noScripts || this.cfg.noScripts) }]));
    let flaggedSkills = 0, scriptsWithheld = 0;
    for (const s of next.values()) {
      categories[s.category] = (categories[s.category] ?? 0) + 1;
      files += s.files.length; bytes += s.totalBytes;
      perLib.get(s.library)!.skills++;
      if (s.riskFlags.length) flaggedSkills++;
      scriptsWithheld += s.scriptsWithheld;
    }
    for (const s of nextHidden.values()) perLib.get(s.library)!.hidden++;
    this.stats = {
      root: this.cfg.root, libraries: [...perLib.values()], flaggedSkills, scriptsWithheld, archiveSkillsRejected: this.archiveRejected, skills: next.size, hidden: nextHidden.size, files, bytes, categories, warnings,
      scannedAt: new Date().toISOString(), scanMs: Date.now() - t0,
    };
    if (changed) for (const fn of this.listeners) fn();
  }

  private diff(a: Map<string, Skill>, b: Map<string, Skill>): boolean {
    if (a.size !== b.size) return true;
    for (const [k, v] of a) {
      const w = b.get(k);
      if (!w || w.skillMdMtimeMs !== v.skillMdMtimeMs || w.files.length !== v.files.length || w.totalBytes !== v.totalBytes) return true;
    }
    return false;
  }

  /**
   * Resolve an archive library to the directory it extracts to. The archive is re-extracted only
   * when its mtime/size changed, so the usual rescan costs a single stat rather than a re-hash of
   * a large zip.
   */
  private async resolveArchive(lib: Library): Promise<string> {
    const st = await fs.stat(lib.root);
    const prev = this.archiveState.get(lib.root);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      try { await fs.access(prev.dir); return prev.dir; } catch { /* cache was cleared; re-extract */ }
    }
    const r = await extractLibrary(lib.root, this.cfg.cacheDir, this.cfg.archiveLimits);
    this.archiveState.set(lib.root, { mtimeMs: st.mtimeMs, size: st.size, dir: r.dir, digest: r.digest });
    return r.dir;
  }

  /** Find directories containing SKILL.md, up to maxDiscoveryDepth. A skill directory is not descended into. */
  private async discover(lib: Library, absDir: string, relDir: string, depth: number, out: Discovered[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(absDir, { withFileTypes: true }); } catch { return; }
    if (depth > 0 && entries.some((e) => e.name === "SKILL.md" && e.isFile())) { out.push({ skillPath: relDir, abs: absDir, library: lib.namespace }); return; }
    if (depth >= this.cfg.maxDiscoveryDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || this.cfg.excludeDirs.has(e.name) || this.cfg.ignoreDirs.has(e.name)) continue;
      await this.discover(lib, path.join(absDir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1, out);
    }
  }

  private async loadSkill(d: Discovered, prev: Skill | undefined, warnings: string[]): Promise<Skill | null> {
    const { skillPath, abs, library } = d;
    const dir = skillPath.split("/").pop()!;
    const skillMd = path.join(abs, "SKILL.md");
    let st;
    try { st = await fs.stat(skillMd); } catch { return null; } // not a skill dir

    const lib = this.cfg.libraries.find((l) => l.namespace === library);
    const noScripts = !!(this.cfg.noScripts || lib?.noScripts);
    const archives: string[] = [];
    let files = await this.walk(abs, abs, warnings, [], archives);
    if (archives.length) {
      const shown = archives.slice(0, 3).join(", ") + (archives.length > 3 ? `, +${archives.length - 3} more` : "");
      warnings.push(`${skillPath}: bundles archive file(s) (${shown}); skills may not contain archives, skill not served`);
      this.archiveRejected++;
      return null;
    }
    let scriptsWithheld = 0;
    if (noScripts) {
      const kept = files.filter((f) => f.rel === "SKILL.md" || !SCRIPT_EXTENSIONS.test(f.rel));
      scriptsWithheld = files.length - kept.length;
      files = kept;
    }
    files.sort((x, y) => (x.rel === "SKILL.md" ? -1 : y.rel === "SKILL.md" ? 1 : x.rel.localeCompare(y.rel)));
    if (files.length > this.cfg.maxFilesPerSkill) {
      warnings.push(`${skillPath}: ${files.length} files, truncated to ${this.cfg.maxFilesPerSkill} (SEP-2640 limit)`);
      files.length = this.cfg.maxFilesPerSkill;
    }
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    if (totalBytes > 16 * 1024 * 1024) warnings.push(`${skillPath}: ${(totalBytes / 1048576).toFixed(1)} MiB exceeds the 16 MiB SEP-2640 per-skill limit; strict hosts may reject it`);

    // Reuse parsed SKILL.md, digests and lint results when nothing changed.
    const sameFiles = !!prev && prev.files.length === files.length && files.every((f) => { const pf = prev.files.find((p) => p.rel === f.rel); return pf && pf.mtimeMs === f.mtimeMs && pf.size === f.size; });
    if (prev && prev.skillMdMtimeMs === st.mtimeMs && prev.scriptsWithheld === scriptsWithheld) {
      for (const f of files) {
        const pf = prev.files.find((p) => p.rel === f.rel);
        if (pf && pf.mtimeMs === f.mtimeMs && pf.size === f.size) f.digest = pf.digest;
      }
      const riskFlags = sameFiles || !this.cfg.lint ? (this.cfg.lint ? prev.riskFlags : []) : await lintFiles(files);
      return { ...prev, files, totalBytes, riskFlags };
    }
    const riskFlags = this.cfg.lint ? await lintFiles(files) : [];
    if (riskFlags.length) warnings.push(`${skillPath}: risk flags ${[...new Set(riskFlags.map((r) => r.rule))].join(", ")} (${riskFlags.map((r) => `${r.file}:${r.line}`).join(", ")})`);
    const TRUST_KEYS = ["origin", "origin-repo", "origin-url", "risk", "outbound", "outbound_targets", "outbound_data", "gate_required", "dev-status", "pricing-tier", "license", "allowed-tools"];

    const text = await fs.readFile(skillMd, "utf8");
    const { data, body } = splitFrontmatter(text);
    const fmWarnings: string[] = [];
    const fm: Record<string, unknown> = data ?? {};
    if (!data) fmWarnings.push("frontmatter missing or unparseable");
    let name = coerceString(fm.name);
    if (!name) { name = dir; fmWarnings.push("frontmatter.name missing, using directory name"); }
    if (name !== dir) {
      // SEP-2640: last URI segment MUST equal frontmatter name. We key by name, so warn about mismatch.
      fmWarnings.push(`frontmatter.name '${name}' differs from directory '${dir}'`);
    }
    const description = coerceString(fm.description) || `(no description) ${name}`;
    if (!fm.description) fmWarnings.push("frontmatter.description missing");
    if (fmWarnings.length) warnings.push(`${skillPath}: ${fmWarnings.join("; ")}`);

    return {
      name, dir, library, skillPath, abs,
      uri: `skill://${skillPath.split("/").map(encodeURIComponent).join("/")}/SKILL.md`,
      description,
      // Nested libraries often encode the category in the folder path (e.g. sales/create-a-sales-asset).
      category: coerceString(fm.category) || parentCategory(skillPath, library) || "uncategorized",
      version: coerceString(fm.version) || "1.0.0",
      tags: [...new Set([...coerceList(fm.tags), ...coerceList(fm["dev-tags"]), ...coerceList(fm["trigger-phrases"])])],
      valueChains: coerceList(fm["value-chains"]),
      requires: coerceList(fm.requires),
      disabled: fm["disable-model-invocation"] === true || fm["disable-model-invocation"] === "true",
      userInvocable: fm["user-invocable"] !== false && fm["user-invocable"] !== "false",
      frontmatter: fm,
      frontmatterWarnings: fmWarnings,
      body,
      trust: Object.fromEntries(TRUST_KEYS.filter((k) => fm[k] !== undefined && fm[k] !== null && fm[k] !== "").map((k) => [k, fm[k]])),
      riskFlags, scriptsWithheld,
      files, totalBytes,
      skillMdMtimeMs: st.mtimeMs,
    };
  }

  private async walk(base: string, dir: string, warnings: string[], out: SkillFile[] = [], archives: string[] = []): Promise<SkillFile[]> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (this.cfg.ignoreDirs.has(e.name) || e.name.startsWith(".") || e.name.endsWith(".dist-info") || e.name.endsWith(".egg-info")) continue;
        await this.walk(base, abs, warnings, out, archives);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        // A library may *be* an archive, but nothing inside one may be: archives hide their
        // contents from the linter, so a bundled zip would be served unscanned.
        if (isArchivePath(e.name)) { archives.push(path.relative(base, abs).split(path.sep).join("/")); continue; }
        if (this.cfg.ignoreExts.has(ext) || e.name.startsWith(".")) continue;
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size > this.cfg.maxFileBytes) { continue; }
        out.push({ rel: path.relative(base, abs).split(path.sep).join("/"), abs, size: st.size, mtimeMs: st.mtimeMs, mimeType: mimeFor(e.name) });
      }
      if (out.length > this.cfg.maxFilesPerSkill * 2) break; // hard stop on runaway trees
    }
    return out;
  }
}
