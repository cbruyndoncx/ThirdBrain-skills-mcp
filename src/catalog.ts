import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import type { Config, LibraryInfo, Library } from "./config.js";

interface Discovered { skillPath: string; abs: string; library: string }
import { splitFrontmatter, coerceString, coerceList } from "./frontmatter.js";
import { lintFiles, SCRIPT_EXTENSIONS, type LintFinding } from "./lint.js";
import { extractLibrary, isArchivePath, verifyExtraction } from "./archive.js";
import { fetchArchive, redact } from "./remote.js";
import {
  detectLayout, findPlaybookRoots, findChainFiles, scanPlaybooks, loadChainDefinitions, buildValueChains, digestOf, PLAYBOOK_RUNNER, PLAYBOOK_DIR, PRIVATE_PLAYBOOK_DIRS,
  type Playbook, type PlaybookAttachment, type ValueChain,
} from "./vault.js";

export interface SkillFile {
  /** Path relative to the skill directory, always with forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
  /** Lazily computed sha256:<hex>. */
  digest?: string;
  /** Lazily read for script files: how to run it (see Catalog.scriptInfo). */
  script?: ScriptInfo;
}

/** What a host needs to know to run a bundled script from a cached copy. */
export interface ScriptInfo {
  /** Python file with a PEP 723 `# /// script` header: run with `uv run`, which installs its inline dependencies. */
  pep723: boolean;
  /** The script's source mentions a `--vault` option, so it is handed the user's workspace explicitly. */
  vaultFlag: boolean;
  /** The script's source mentions `VAULT_PATH`. */
  vaultEnv: boolean;
}

/** Runtime dependencies declared in SKILL.md with the vault's marker line. */
export interface SkillDependencies {
  /** Skill names whose code this skill runs; pulled with it by `pull --with-deps`. */
  required: string[];
  /** Skill names used when present; reported, never pulled. */
  optional: string[];
}

/**
 * The marker line a SKILL.md uses to declare another skill it runs code from:
 * `[[context-pack/SKILL.md|context-pack]] — **runtime dependency.**` (required) or
 * `— **optional runtime dependency.**`. The link may carry an alias or not.
 */
const DEPENDENCY_MARKER = /\[\[([a-z0-9-]+)\/SKILL\.md(?:\|[^\]]*)?\]\]\s*—\s*\*\*(optional )?runtime dependency\.\*\*/g;

/** Parse the runtime-dependency markers of a SKILL.md body. A name marked both ways counts as required; a self-reference is ignored. */
export function parseDependencies(body: string, self?: string): SkillDependencies {
  const required = new Set<string>(), optional = new Set<string>();
  for (const m of body.matchAll(DEPENDENCY_MARKER)) {
    if (m[1] === self) continue;
    (m[2] ? optional : required).add(m[1]);
  }
  for (const r of required) optional.delete(r);
  return { required: [...required], optional: [...optional] };
}

/** Files inside a skill that are not served, by reason; reported as one catalog warning per skill. */
interface Skips { oversize: string[]; symlink: string[]; dotfile: string[] }
const newSkips = (): Skips => ({ oversize: [], symlink: [], dotfile: [] });

/** `bob/x: 3 file(s) skipped (1 over SKILLS_MAX_FILE_BYTES: big.bin; 2 dotfile: .env, cfg/.x)`, or null when nothing was skipped. */
export function skipWarning(skillPath: string, sk: Skips): string | null {
  const parts: string[] = [];
  const list = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? `, +${xs.length - 3} more` : "");
  if (sk.oversize.length) parts.push(`${sk.oversize.length} over SKILLS_MAX_FILE_BYTES: ${list(sk.oversize)}`);
  if (sk.symlink.length) parts.push(`${sk.symlink.length} symlink: ${list(sk.symlink)}`);
  if (sk.dotfile.length) parts.push(`${sk.dotfile.length} dotfile: ${list(sk.dotfile)}`);
  const n = sk.oversize.length + sk.symlink.length + sk.dotfile.length;
  return n ? `${skillPath}: ${n} file(s) skipped (${parts.join("; ")})` : null;
}

/** Interpreter a host should put in front of a bundled script, by extension (PEP 723 Python → uv run). */
export function interpreterFor(rel: string, info?: Pick<ScriptInfo, "pep723">): string {
  const ext = path.extname(rel).toLowerCase();
  switch (ext) {
    case ".py": return info?.pep723 ? "uv run" : "python";
    case ".sh": case ".bash": return "bash";
    case ".zsh": return "zsh";
    case ".js": case ".mjs": case ".cjs": return "node";
    case ".ts": return "npx tsx";
    case ".ps1": case ".psm1": return "pwsh -File";
    case ".bat": case ".cmd": return "cmd /c";
    case ".rb": return "ruby";
    case ".pl": return "perl";
    case ".php": return "php";
    default: return "";
  }
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
  /** Frontmatter `requires`: external setup (tools, keys), not other skills. */
  requires: string[];
  /** Other skills this one runs code from, from the SKILL.md marker lines. */
  dependencies: SkillDependencies;
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

/** Per-library figures. `root` is for the operator (logs, --stats); `publicLibrary()` is what goes over MCP. */
export interface LibraryStats {
  namespace: string;
  root: string;
  /** How the content is loaded: a plain directory, a local .zip, or an https .zip. */
  kind: "directory" | "archive" | "url";
  /** sha256 hex of the archive currently extracted (archive and url libraries only). */
  digest?: string;
  info?: LibraryInfo;
  skills: number;
  hidden: number;
  noScripts: boolean;
  /** True when a vault root was found (or configured) for this library. */
  vault: boolean;
  /** Playbooks served (status active, or all with --show-disabled). */
  playbooks: number;
  /** Playbooks found but not served: non-active status, or no playbook-runner skill available. */
  playbooksHidden: number;
  /** Skill path of the playbook-runner skill that executes this library's playbooks, when served. */
  playbookRunner?: string;
  valueChains: number;
  /** Where the chain definitions come from; absent when no value chains are served. */
  valueChainSource?: "definition" | "index" | "derived";
  /** How many of `valueChains` are unstaged buckets (e.g. infrastructure, operating-controls); absent when none. */
  valueChainBuckets?: number;
}

/** The client-facing view of a library: everything in LibraryStats except where it lives. */
export function publicLibrary(l: LibraryStats): Omit<LibraryStats, "root"> {
  const { root: _root, ...rest } = l;
  return rest;
}

export interface CatalogStats {
  root: string;
  libraries: LibraryStats[];
  flaggedSkills: number;
  scriptsWithheld: number;
  /** Skills not served because they bundle an archive file. */
  archiveSkillsRejected: number;
  /** Skills and playbooks not served because their pricing-tier is in --exclude-tiers (also counted in hidden / playbooksHidden). Present only when tiers are excluded. */
  tierExcluded?: { tiers: string[]; skills: number; playbooks: number };
  skills: number;
  hidden: number;
  files: number;
  bytes: number;
  playbooks: number;
  valueChains: number;
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
  /** Served playbooks keyed by playbookPath (`<ns>/<stem>`). */
  private playbooks = new Map<string, Playbook>();
  /** Value chains keyed by `<ns>/<id>`. */
  private chains = new Map<string, ValueChain>();
  /** Per library: the playbook-runner skill path that executes its playbooks. */
  private runners = new Map<string, string>();
  private stats!: CatalogStats;
  private scanning: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  /** Per-archive memo so an unchanged zip is not re-hashed or re-extracted on every rescan. */
  private archiveState = new Map<string, { mtimeMs: number; size: number; dir: string; digest: string }>();
  /** Remote libraries, memoised by URL. A pinned release URL is fetched once per process. */
  private remoteState = new Map<string, { dir: string; digest: string }>();
  private archiveRejected = 0;
  /** Per scan: skills (by library) and playbooks withheld by --exclude-tiers. */
  private tierHidden = { skills: new Map<string, number>(), playbooks: 0 };

  /** True when a note's pricing-tier is excluded by configuration. */
  private tierExcluded(fm: Record<string, unknown>): boolean {
    if (!this.cfg.excludeTiers?.size) return false;
    return coerceList(fm["pricing-tier"]).some((t) => this.cfg.excludeTiers.has(t.toLowerCase()));
  }

  constructor(private cfg: Config) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getStats(): CatalogStats { return this.stats ?? { root: this.cfg.root, libraries: [], flaggedSkills: 0, scriptsWithheld: 0, archiveSkillsRejected: 0, skills: 0, hidden: 0, files: 0, bytes: 0, playbooks: 0, valueChains: 0, categories: {}, warnings: [], scannedAt: "", scanMs: 0 }; }
  all(library?: string): Skill[] {
    const v = [...this.skills.values()].filter((s) => library === undefined || s.library === library);
    return v.sort((a, b) => a.skillPath.localeCompare(b.skillPath));
  }

  // ---- playbooks and value chains (vault extras) ----
  allPlaybooks(library?: string): Playbook[] {
    return [...this.playbooks.values()].filter((p) => library === undefined || p.library === library).sort((a, b) => a.playbookPath.localeCompare(b.playbookPath));
  }
  /** Look up by playbook path, `<library>/<name>`, or bare name/title (case-insensitive) when unambiguous. */
  getPlaybook(key: string): Playbook | undefined {
    const k = key.trim();
    const direct = this.playbooks.get(k);
    if (direct) return direct;
    const lower = k.toLowerCase();
    const [maybeLib, ...rest] = k.split("/");
    const inLib = rest.length ? rest.join("/").toLowerCase() : undefined;
    let found: Playbook | undefined;
    for (const p of this.playbooks.values()) {
      const hit = inLib !== undefined
        ? p.library === maybeLib && (p.name.toLowerCase() === inLib || p.title.toLowerCase() === inLib)
        : p.name.toLowerCase() === lower || p.title.toLowerCase() === lower;
      if (hit) { if (found && found !== p) return undefined; found = p; }
    }
    return found;
  }
  /** The playbook-runner skill path for a library's playbooks (same library first, else any library). */
  playbookRunner(library: string): Skill | undefined {
    const p = this.runners.get(library);
    return p ? this.skills.get(p) : undefined;
  }
  allValueChains(library?: string): ValueChain[] {
    return [...this.chains.values()].filter((c) => library === undefined || c.library === library);
  }
  getValueChain(id: string, library?: string): ValueChain | undefined {
    const k = id.trim().toLowerCase();
    if (library !== undefined) return this.chains.get(library ? `${library}/${k}` : k);
    const direct = [...this.chains.values()].filter((c) => c.id === k);
    if (direct.length === 1) return direct[0];
    if (direct.length > 1) return undefined;
    const [lib, ...rest] = k.split("/");
    return rest.length ? this.chains.get(`${lib}/${rest.join("/")}`) : undefined;
  }
  /** Parse playbook://<playbookPath>[/<attachment>]. */
  resolvePlaybookUri(uri: string): { playbook: Playbook; attachment?: PlaybookAttachment; rel: string } | null {
    if (!uri.startsWith("playbook://")) return null;
    const segs = uri.slice("playbook://".length).split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    if (segs.some((p) => p === "..")) return null;
    for (let n = segs.length; n >= 1; n--) {
      const pb = this.playbooks.get(segs.slice(0, n).join("/"));
      if (!pb) continue;
      const rel = segs.slice(n).join("/");
      return { playbook: pb, attachment: rel ? pb.attachments.find((a) => a.rel === rel) : undefined, rel };
    }
    return null;
  }
  /** Parse value-chain://[<library>/]<id>. */
  resolveValueChainUri(uri: string): ValueChain | null {
    if (!uri.startsWith("value-chain://")) return null;
    const segs = uri.slice("value-chain://".length).split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    if (segs.length === 2) return this.chains.get(`${segs[0]}/${segs[1].toLowerCase()}`) ?? null;
    if (segs.length === 1) return this.chains.get(segs[0].toLowerCase()) ?? null;
    return null;
  }
  digestForPlaybook(f: { abs: string; digest?: string }): Promise<string> { return digestOf(f); }
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

  /**
   * A skill's runtime-dependency closure inside its own library: every skill reached through
   * required markers, transitively, in discovery order, without the skill itself. Cycles are
   * followed once. Names that resolve to no skill in the library are returned as `missing`;
   * dependencies on other libraries are not supported.
   */
  dependencyClosure(s: Skill): { skills: Skill[]; missing: string[] } {
    const seen = new Set<string>([s.skillPath]);
    const out: Skill[] = [], missing: string[] = [];
    const queue = [...s.dependencies.required];
    const from = new Map(queue.map((d) => [d, s]));
    while (queue.length) {
      const name = queue.shift()!;
      const dep = this.inLibrary(from.get(name)!.library, name);
      if (!dep) { if (!missing.includes(name)) missing.push(name); continue; }
      if (seen.has(dep.skillPath)) continue;
      seen.add(dep.skillPath);
      out.push(dep);
      for (const next of dep.dependencies.required) if (!from.has(next)) { from.set(next, dep); queue.push(next); }
    }
    return { skills: out, missing };
  }

  /** A served skill (hidden included) by frontmatter name inside one library. */
  private inLibrary(library: string, name: string, maps: Map<string, Skill>[] = [this.skills, this.hidden]): Skill | undefined {
    for (const m of maps) for (const s of m.values()) if (s.library === library && s.name === name) return s;
    return undefined;
  }

  /** How to run a bundled script: PEP 723 header, whether it takes --vault / reads VAULT_PATH. Read once per file version. */
  async scriptInfo(f: SkillFile): Promise<ScriptInfo> {
    if (f.script) return f.script;
    let text = "";
    try { text = (await fs.readFile(f.abs, "utf8")).slice(0, 512 * 1024); } catch { /* unreadable: report defaults */ }
    f.script = {
      pep723: f.rel.toLowerCase().endsWith(".py") && /^# \/\/\/ script\s*$/m.test(text),
      vaultFlag: /--vault\b/.test(text),
      vaultEnv: /\bVAULT_PATH\b/.test(text),
    };
    return f.script;
  }

  async digestFor(f: SkillFile): Promise<string> {
    if (f.digest) return f.digest;
    const handle = await fs.open(f.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = await handle.readFile().finally(() => handle.close());
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
    const previousLibraries = this.stats?.libraries ?? [];
    const warnings: string[] = [];
    this.archiveRejected = 0;
    this.tierHidden = { skills: new Map(), playbooks: 0 };
    const next = new Map<string, Skill>();
    const nextHidden = new Map<string, Skill>();
    const dirs: Discovered[] = [];
    const layouts = new Map<string, import("./vault.js").VaultLayout>();
    for (const lib of this.cfg.libraries) {
      if (!lib.url) {
        try { await fs.access(lib.root); } catch (e) {
          if (this.cfg.libraries.length === 1) throw new Error(`Cannot read skills root ${lib.root}: ${(e as Error).message}`);
          warnings.push(`library '${lib.namespace}': cannot read ${lib.root}: ${(e as Error).message}`);
          continue;
        }
      }
      let effectiveRoot = lib.root;
      if (lib.archive) {
        try {
          effectiveRoot = await this.resolveArchive(lib, warnings);
        } catch (e) {
          const msg = `archive library ${lib.root}: ${(e as Error).message}`;
          if (this.cfg.libraries.length === 1) throw new Error(msg);
          warnings.push(`library '${lib.namespace || "(root)"}': ${msg}`);
          continue;
        }
      }
      const layout = await detectLayout(effectiveRoot, lib.vault, this.cfg.excludeDirs, this.cfg.ignoreDirs);
      const resolvedRoot = await fs.realpath(effectiveRoot);
      const resolvedSkills = await fs.realpath(layout.skillsRoot);
      if (resolvedSkills !== resolvedRoot && !resolvedSkills.startsWith(resolvedRoot + path.sep)) throw new Error(`library '${lib.namespace || "(root)"}': skills path escapes the configured root`);
      if (layout.vaultRoot && lib.vault === undefined) {
        const resolvedVault = await fs.realpath(layout.vaultRoot);
        if (resolvedVault !== resolvedRoot && !resolvedVault.startsWith(resolvedRoot + path.sep)) throw new Error(`library '${lib.namespace || "(root)"}': vault path escapes the configured root`);
      }
      layouts.set(lib.namespace, layout);
      await this.discover(lib, layout.skillsRoot, lib.namespace, 0, dirs);
    }
    // The cache is shared by server processes. A catalog cannot know what another process uses.
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
          // Excluded tiers are withheld entirely (not even skills/get answers), and counted as hidden.
          if (this.tierExcluded(s.frontmatter)) { this.tierHidden.skills.set(s.library, (this.tierHidden.skills.get(s.library) ?? 0) + 1); continue; }
          if (next.has(s.skillPath) || nextHidden.has(s.skillPath)) { warnings.push(`${s.skillPath}: duplicate skill path`); continue; }
          (s.disabled && this.cfg.hideDisabled ? nextHidden : next).set(s.skillPath, s);
        } catch (e) {
          warnings.push(`${d.skillPath}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    for (const s of [...next.values(), ...nextHidden.values()]) {
      const missing = s.dependencies.required.filter((d) => !this.inLibrary(s.library, d, [next, nextHidden]));
      if (missing.length) warnings.push(`${s.skillPath}: runtime dependenc${missing.length > 1 ? "ies" : "y"} ${missing.map((d) => `'${d}'`).join(", ")} not served in library '${s.library || "(root)"}'; pull --with-deps cannot complete its closure`);
    }

    const vault = await this.scanVaults(layouts, next, warnings);
    let changed = this.diff(this.skills, next) || this.diff(this.hidden, nextHidden) || this.diffVault(vault.playbooks, vault.chains);
    this.skills = next;
    this.hidden = nextHidden;
    this.playbooks = vault.playbooks;
    this.chains = vault.chains;
    this.runners = vault.runners;
    const categories: Record<string, number> = {};
    let files = 0, bytes = 0;
    const perLib = new Map<string, LibraryStats>(this.cfg.libraries.map((l) => {
      const kind = l.url ? "url" : l.archive ? "archive" : "directory";
      const digest = l.url ? this.remoteState.get(`${l.url}#${l.sha256 ?? ""}`)?.digest : l.archive ? this.archiveState.get(l.root)?.digest : undefined;
      const v = vault.perLib.get(l.namespace);
      const st: LibraryStats = {
        namespace: l.namespace, root: l.root, kind, skills: 0, hidden: 0, noScripts: !!(l.noScripts || this.cfg.noScripts),
        vault: !!v, playbooks: v?.playbooks ?? 0, playbooksHidden: v?.playbooksHidden ?? 0, valueChains: v?.valueChains ?? 0,
      };
      if (digest) st.digest = digest;
      if (l.info) st.info = l.info;
      if (v?.runner) st.playbookRunner = v.runner;
      if (v?.chainSource) st.valueChainSource = v.chainSource;
      if (v?.buckets) st.valueChainBuckets = v.buckets;
      return [l.namespace, st];
    }));
    let flaggedSkills = 0, scriptsWithheld = 0;
    for (const s of next.values()) {
      categories[s.category] = (categories[s.category] ?? 0) + 1;
      files += s.files.length; bytes += s.totalBytes;
      perLib.get(s.library)!.skills++;
      if (s.riskFlags.length) flaggedSkills++;
      scriptsWithheld += s.scriptsWithheld;
    }
    for (const s of nextHidden.values()) perLib.get(s.library)!.hidden++;
    let tierSkills = 0;
    for (const [ns, n] of this.tierHidden.skills) { perLib.get(ns)!.hidden += n; tierSkills += n; }
    this.stats = {
      root: this.cfg.root, libraries: [...perLib.values()], flaggedSkills, scriptsWithheld, archiveSkillsRejected: this.archiveRejected, skills: next.size, hidden: nextHidden.size + tierSkills, files, bytes,
      ...(this.cfg.excludeTiers?.size ? { tierExcluded: { tiers: [...this.cfg.excludeTiers], skills: tierSkills, playbooks: this.tierHidden.playbooks } } : {}),
      playbooks: vault.playbooks.size, valueChains: vault.chains.size, categories, warnings,
      scannedAt: new Date().toISOString(), scanMs: Date.now() - t0,
    };
    if (JSON.stringify(this.stats.libraries.map(publicLibrary)) !== JSON.stringify(previousLibraries.map(publicLibrary))) changed = true;
    if (changed) for (const fn of this.listeners) fn();
  }

  private diffVault(playbooks: Map<string, Playbook>, chains: Map<string, ValueChain>): boolean {
    if (playbooks.size !== this.playbooks.size || chains.size !== this.chains.size) return true;
    for (const [k, v] of this.playbooks) {
      const w = playbooks.get(k);
      if (!w || w.mtimeMs !== v.mtimeMs || w.size !== v.size || w.abs !== v.abs ||
        JSON.stringify(w.attachments.map((a) => [a.rel, a.size, a.mtimeMs])) !== JSON.stringify(v.attachments.map((a) => [a.rel, a.size, a.mtimeMs]))) return true;
    }
    for (const [k, v] of this.chains) {
      const w = chains.get(k);
      if (!w || JSON.stringify([w.label, w.description, w.stages, w.source, w.skillsByStage, w.playbooksByStage]) !==
        JSON.stringify([v.label, v.description, v.stages, v.source, v.skillsByStage, v.playbooksByStage])) return true;
    }
    return false;
  }

  /**
   * Playbooks and value chains for every library that sits in a vault. Playbooks are served only
   * when a playbook-runner skill is served (same library first, else any library); value chains
   * need no skill, only chain definitions or frontmatter that references them.
   */
  private async scanVaults(layouts: Map<string, import("./vault.js").VaultLayout>, skills: Map<string, Skill>, warnings: string[]) {
    const playbooks = new Map<string, Playbook>();
    const chains = new Map<string, ValueChain>();
    const runners = new Map<string, string>();
    const perLib = new Map<string, { playbooks: number; playbooksHidden: number; runner?: string; valueChains: number; buckets?: number; chainSource?: ValueChain["source"] }>();
    if (!this.cfg.playbooks && !this.cfg.valueChains) return { playbooks, chains, runners, perLib };
    const runnerIn = (lib: string) => [...skills.values()].find((s) => s.name === PLAYBOOK_RUNNER && s.library === lib)
      ?? [...skills.values()].find((s) => s.name === PLAYBOOK_RUNNER);
    for (const lib of this.cfg.libraries) {
      const layout = layouts.get(lib.namespace);
      if (!layout?.vaultRoot) continue;
      const { vaultRoot, skillsRoot } = layout;
      try { if (!(await fs.stat(vaultRoot)).isDirectory()) continue; } catch {
        if (lib.vault) warnings.push(`library '${lib.namespace || "(root)"}': vault directory not found`);
        continue;
      }
      const who = `library '${lib.namespace || "(root)"}'`;
      const entry: NonNullable<ReturnType<typeof perLib.get>> = { playbooks: 0, playbooksHidden: 0, valueChains: 0 };
      perLib.set(lib.namespace, entry);
      const libSkills = [...skills.values()].filter((s) => s.library === lib.namespace);

      let served: Playbook[] = [];
      if (this.cfg.playbooks) {
        const pr = await findPlaybookRoots(vaultRoot);
        if (pr.privateNotes) warnings.push(`${who}: ${pr.privateNotes} note(s) under ${PRIVATE_PLAYBOOK_DIRS.join(", ")} are private playbooks and are not served; only ${PLAYBOOK_DIR} is`);
        const r = await scanPlaybooks({
          library: lib.namespace, vaultRoot, roots: pr.roots,
          excludeDirs: this.cfg.excludeDirs, maxFileBytes: this.cfg.maxFileBytes, noScripts: !!(this.cfg.noScripts || lib.noScripts), mimeFor,
          showAll: !this.cfg.hideDisabled, skillNames: new Set(libSkills.map((s) => s.name)), prev: this.playbooks,
        });
        for (const w of r.warnings) warnings.push(`${who}: ${w}`);
        if (this.cfg.lint) for (const p of r.playbooks) {
          const findings = await lintFiles(p.attachments.map((a) => ({ ...a, rel: a.rel })));
          for (const f of findings) warnings.push(`${who}: playbook ${p.name} attachment risk flag ${f.rule} @ ${f.file}:${f.line}`);
        }
        const runner = runnerIn(lib.namespace);
        if (r.playbooks.length + r.hidden.length > 0 && !runner) {
          warnings.push(`${who}: ${r.playbooks.length + r.hidden.length} playbook(s) found but no '${PLAYBOOK_RUNNER}' skill is served; playbooks withheld`);
          entry.playbooksHidden = r.playbooks.length + r.hidden.length;
        } else if (runner) {
          runners.set(lib.namespace, runner.skillPath);
          entry.runner = runner.skillPath;
          served = r.playbooks.filter((p) => !this.tierExcluded(p.frontmatter));
          this.tierHidden.playbooks += r.playbooks.length - served.length;
          for (const p of served) playbooks.set(p.playbookPath, p);
          entry.playbooks = served.length;
          entry.playbooksHidden = r.hidden.length + (r.playbooks.length - served.length);
          const known = new Set(libSkills.map((s) => s.name));
          const missing = new Map<string, string[]>();
          for (const p of served) for (const sk of p.skills) if (!known.has(sk)) (missing.get(sk) ?? missing.set(sk, []).get(sk)!).push(p.name);
          for (const [sk, pbs] of missing) warnings.push(`${who}: playbook step names skill '${sk}' which is not served (${pbs.slice(0, 3).join(", ")}${pbs.length > 3 ? `, +${pbs.length - 3} more` : ""})`);
        }
      }

      if (this.cfg.valueChains) {
        const defs = await loadChainDefinitions(vaultRoot, await findChainFiles(vaultRoot, skillsRoot, this.cfg.excludeDirs, this.cfg.ignoreDirs));
        for (const w of defs.warnings) warnings.push(`${who}: ${w}`);
        const built = buildValueChains(lib.namespace, defs.defs, defs.source, libSkills.map((s) => ({ name: s.name, valueChains: s.valueChains, stage: coerceString(s.frontmatter["chain-stage"]) })), served);
        for (const c of built) chains.set(lib.namespace ? `${lib.namespace}/${c.id}` : c.id, c);
        entry.valueChains = built.length;
        const buckets = built.filter((c) => c.kind === "bucket").length;
        if (buckets) entry.buckets = buckets;
        if (built.length) entry.chainSource = defs.source ?? "derived";
        const derived = built.filter((c) => c.source === "derived");
        if (defs.source && derived.length) warnings.push(`${who}: value chain(s) referenced by frontmatter but not defined: ${derived.map((c) => c.id).join(", ")}`);
      }
    }
    return { playbooks, chains, runners, perLib };
  }

  private diff(a: Map<string, Skill>, b: Map<string, Skill>): boolean {
    if (a.size !== b.size) return true;
    for (const [k, v] of a) {
      const w = b.get(k);
      if (!w || w.skillMdMtimeMs !== v.skillMdMtimeMs || w.abs !== v.abs || w.files.length !== v.files.length ||
        w.scriptsWithheld !== v.scriptsWithheld || JSON.stringify(w.riskFlags) !== JSON.stringify(v.riskFlags) ||
        v.files.some((f, i) => f.rel !== w.files[i].rel || f.size !== w.files[i].size || f.mtimeMs !== w.files[i].mtimeMs)) return true;
    }
    return false;
  }

  /**
   * Resolve an archive library to the directory it extracts to. The archive is re-extracted only
   * when its mtime/size changed, so the usual rescan costs a single stat rather than a re-hash of
   * a large zip.
   */
  private async resolveArchive(lib: Library, warnings: string[]): Promise<string> {
    if (lib.url) return this.resolveRemote(lib, warnings);
    const st = await fs.stat(lib.root);
    const prev = this.archiveState.get(lib.root);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      try { await verifyExtraction(prev.dir); return prev.dir; } catch { /* cache was cleared or changed; re-extract below */ }
    }
    const r = await extractLibrary(lib.root, this.cfg.cacheDir, this.cfg.archiveLimits);
    this.archiveState.set(lib.root, { mtimeMs: st.mtimeMs, size: st.size, dir: r.dir, digest: r.digest });
    return r.dir;
  }

  /**
   * Resolve a remote library to its extracted directory.
   *
   * Fetched once per process: a release URL is expected to be pinned to a tag, so re-fetching on
   * every 60 s rescan would be pure waste. Changing the URL (or the pinned digest) in the config
   * is what picks up a new version.
   *
   * Network failures are soft when a previous extraction is still on disk — a transient DNS blip
   * during a background rescan must not empty a served library.
   */
  private async resolveRemote(lib: Library, warnings: string[]): Promise<string> {
    const url = lib.url!;
    const key = `${url}#${lib.sha256 ?? ""}`;
    const prev = this.remoteState.get(key);
    if (prev && (!lib.sha256 || prev.digest === lib.sha256)) {
      await verifyExtraction(prev.dir);
      return prev.dir;
    }
    try {
      const got = await fetchArchive(url, {
        cacheDir: this.cfg.cacheDir,
        maxBytes: this.cfg.maxDownloadBytes,
        expectedSha256: lib.sha256,
        useSidecar: !lib.sha256,
        token: this.cfg.fetchToken ?? (/^(github\.com|api\.github\.com)$/i.test(new URL(url).hostname) ? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN : undefined),
        timeoutMs: this.cfg.fetchTimeoutMs,
      });
      const r = await extractLibrary(got.file, this.cfg.cacheDir, this.cfg.archiveLimits);
      if (lib.sha256 && r.digest !== lib.sha256) throw new Error(`cached extraction does not match pinned sha256 for ${redact(url)}`);
      this.remoteState.set(key, { dir: r.dir, digest: r.digest });
      return r.dir;
    } catch (e) {
      if (prev && (!lib.sha256 || prev.digest === lib.sha256)) {
        warnings.push(`library '${lib.namespace || "(root)"}': ${redact(url)} could not be refreshed (${(e as Error).message}); serving the cached copy`);
        return prev.dir;
      }
      throw e;
    }
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
    const skips = newSkips();
    let files = await this.walk(abs, abs, warnings, [], archives, skips);
    const skipped = skipWarning(skillPath, skips);
    if (skipped) warnings.push(skipped);
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
    if (!files.some((f) => f.rel === "SKILL.md")) { warnings.push(`${skillPath}: SKILL.md is not servable; skill not served`); return null; }
    if (files.length > this.cfg.maxFilesPerSkill) {
      warnings.push(`${skillPath}: ${files.length} files exceeds ${this.cfg.maxFilesPerSkill}; skill not served because its manifest would be incomplete`);
      return null;
    }
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    if (totalBytes > 16 * 1024 * 1024) { warnings.push(`${skillPath}: ${(totalBytes / 1048576).toFixed(1)} MiB exceeds the 16 MiB SEP-2640 per-skill limit; skill not served`); return null; }

    // Reuse parsed SKILL.md, digests and lint results when nothing changed.
    const sameFiles = !!prev && prev.files.length === files.length && files.every((f) => { const pf = prev.files.find((p) => p.rel === f.rel); return pf && pf.mtimeMs === f.mtimeMs && pf.size === f.size; });
    if (prev && prev.abs === abs && prev.skillMdMtimeMs === st.mtimeMs && prev.scriptsWithheld === scriptsWithheld) {
      for (const f of files) {
        const pf = prev.files.find((p) => p.rel === f.rel);
        if (pf && pf.mtimeMs === f.mtimeMs && pf.size === f.size) { f.digest = pf.digest; f.script = pf.script; }
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
    if (fmWarnings.length) { warnings.push(`${skillPath}: ${fmWarnings.join("; ")}; skill not served`); return null; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { warnings.push(`${skillPath}: invalid Agent Skills name '${name}'; skill not served`); return null; }

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
      dependencies: parseDependencies(body, name),
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

  private async walk(base: string, dir: string, warnings: string[], out: SkillFile[] = [], archives: string[] = [], skips: Skips = newSkips()): Promise<SkillFile[]> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    const relOf = (abs: string) => path.relative(base, abs).split(path.sep).join("/");
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      // Silently ignored by design: tool and build folders (.venv, node_modules, __pycache__,
      // .git, caches, *.dist-info, *.egg-info) and compiled artefacts. Everything else that is not
      // served is counted, so the operator sees it in catalog warnings.
      if (e.isSymbolicLink()) { skips.symlink.push(relOf(abs)); continue; }
      if (e.isDirectory()) {
        if (this.cfg.ignoreDirs.has(e.name) || e.name.endsWith(".dist-info") || e.name.endsWith(".egg-info")) continue;
        if (e.name.startsWith(".")) { skips.dotfile.push(relOf(abs) + "/"); continue; }
        await this.walk(base, abs, warnings, out, archives, skips);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        // A library may *be* an archive, but nothing inside one may be: archives hide their
        // contents from the linter, so a bundled zip would be served unscanned.
        if (isArchivePath(e.name)) { archives.push(relOf(abs)); continue; }
        if (this.cfg.ignoreExts.has(ext)) continue;
        if (e.name.startsWith(".")) { skips.dotfile.push(relOf(abs)); continue; }
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size > this.cfg.maxFileBytes) { skips.oversize.push(relOf(abs)); continue; }
        out.push({ rel: path.relative(base, abs).split(path.sep).join("/"), abs, size: st.size, mtimeMs: st.mtimeMs, mimeType: mimeFor(e.name) });
      }
      if (out.length > this.cfg.maxFilesPerSkill * 2) break; // hard stop on runaway trees
    }
    return out;
  }
}
