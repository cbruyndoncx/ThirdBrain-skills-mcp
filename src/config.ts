import path from "node:path";
import fs from "node:fs";
import { isArchiveRoot, defaultCacheRoot, DEFAULT_LIMITS, type ExtractLimits } from "./archive.js";
import { isUrlRoot } from "./remote.js";

export interface Library {
  /** Namespace used as the first URI segment (skill://<ns>/<skill>/...). Empty string = un-namespaced single library. */
  namespace: string;
  /**
   * Absolute path to the library. Either a directory containing skill directories (searched
   * recursively), or a `.zip` archive of one, which is extracted before discovery.
   */
  root: string;
  /** True when `root` is a `.zip` to be extracted rather than a directory. */
  archive?: boolean;
  /** https URL of a `.zip` library. When set, `root` mirrors it for display only. */
  url?: string;
  /** sha256 pinned in configuration, verified before the archive is extracted. */
  sha256?: string;
  /** Withhold executable files (scripts) from this library's manifests. */
  noScripts?: boolean;
  /** Descriptive metadata shown to clients instead of the root path. */
  info?: LibraryInfo;
}

/**
 * What a client may learn about a library. Paths are never shown over MCP, so this is how an
 * operator says what is loaded: where it comes from, its version, and anything else useful.
 */
export interface LibraryInfo {
  /** Human title, e.g. "BOB – ThirdBrain Business Operating Brain". */
  title?: string;
  /** Where the content comes from, e.g. the vault, repository or team that publishes it: "brncx-skills". */
  source?: string;
  /** Version of the library content, e.g. "2026.09" or a git tag. */
  version?: string;
  /** Free-form string pairs, e.g. {"maintainer": "...", "channel": "stable"}. */
  metadata?: Record<string, string>;
}

/** Shape of the optional JSON config file (--config). Re-read on every rescan and on SIGHUP. */
export interface ConfigFile {
  libraries: ({ namespace: string; root?: string; url?: string; sha256?: string; noScripts?: boolean } & LibraryInfo)[];
  noScripts?: boolean;
  lint?: boolean;
}

export interface Config {
  /** One or more skill libraries. A single library may have an empty namespace. */
  libraries: Library[];
  /** Convenience: root of the first library (used in stats/logging). */
  root: string;
  /** Path of the JSON config file, when libraries come from one. */
  configFile?: string;
  /** Withhold executable files from every library. */
  noScripts: boolean;
  /** Run the scan-time linter on served files. */
  lint: boolean;
  /** Server name reported in initialize (e.g. "bob-skills"). */
  serverName: string;
  /** Human title reported in initialize. */
  title: string;
  /** Prefix for tool names, e.g. "bob" -> bob_search_skills. */
  toolPrefix: string;
  /** Directory names never entered when discovering skills (any depth). */
  excludeDirs: Set<string>;
  /** Directory names never served as skill files (any depth inside a skill). */
  ignoreDirs: Set<string>;
  /** File extensions (lowercase, with dot) never served. */
  ignoreExts: Set<string>;
  /** Skip skills whose frontmatter sets disable-model-invocation: true. */
  hideDisabled: boolean;
  /** Per-file size ceiling in bytes. */
  maxFileBytes: number;
  /** Max files listed per skill (SEP-2640 cap is 512). */
  maxFilesPerSkill: number;
  /** How deep below root to look for SKILL.md directories. */
  maxDiscoveryDepth: number;
  /** Seconds between automatic catalog rescans (0 disables). */
  rescanSeconds: number;
  /** Where archive libraries are extracted, keyed by content digest. */
  cacheDir: string;
  /** Extraction ceilings for archive libraries. */
  archiveLimits: ExtractLimits;
  /** Ceiling on bytes downloaded for a remote archive library. */
  maxDownloadBytes: number;
  /** Timeout for a single HTTP request when fetching a remote library. */
  fetchTimeoutMs: number;
  /** Bearer token for private archive assets. */
  fetchToken?: string;
  http?: { port: number; host: string };
  statsOnly: boolean;
}

const HELP = `skills-mcp — serve a directory of Agent Skills (SKILL.md folders) over MCP (SEP-2640 + discovery tools)

usage: skills-mcp [serve] (--root DIR | --lib NS=DIR ...) [--name NAME] [--prefix PREFIX] [--title TITLE] [--http PORT] [--show-disabled] [--stats]
       skills-mcp pull --help        sync skills from any SEP-2640 server to disk

  --config FILE      JSON {libraries:[{namespace,root|url,noScripts?,title?,source?,version?,metadata?}],noScripts?,lint?}
                     re-read on rescan/SIGHUP                                        env SKILLS_CONFIG
  --no-scripts       withhold executable files (.sh .py .js .ps1 ...) from all manifests      env SKILLS_NO_SCRIPTS=true
  --no-lint          disable the scan-time risk linter                                        env SKILLS_LINT=false
  --root DIR|ZIP     single un-namespaced library (skill://<skill>/...)          env SKILLS_ROOT
  --lib NS=DIR|ZIP   add a namespaced library (skill://NS/<skill>/...); repeatable env SKILLS_LIBS="bob=/a,gbl=/b.zip"
                     A .zip root is extracted to the cache dir before discovery; archives are
                     never allowed *inside* a library. The value may also be an https URL of a
                     .zip, optionally pinned: https://host/lib.zip#sha256=<64 hex>
  --name NAME        MCP server name, default "skills"                           env SKILLS_NAME
  --prefix PREFIX    tool-name prefix, default = --name with '-' -> '_'          env SKILLS_TOOL_PREFIX
  --title TITLE      human title, default derived from name                     env SKILLS_TITLE
  --exclude a,b      dir names skipped during discovery (default _archive,_audit) env SKILLS_EXCLUDE
  --depth N          max discovery depth below root (default 4)                  env SKILLS_DEPTH
  --show-disabled    serve skills with disable-model-invocation: true            env SKILLS_HIDE_DISABLED=false
  --http PORT        Streamable HTTP on PORT instead of stdio                    env SKILLS_HOST (bind address)
  --stats            print catalog statistics as JSON and exit
  env SKILLS_MAX_FILE_BYTES (default 4 MiB), SKILLS_RESCAN_SECONDS (default 60)
  env SKILLS_CACHE_DIR (default ~/.cache/skills-mcp), SKILLS_MAX_ARCHIVE_BYTES (default 256 MiB),
      SKILLS_MAX_ARCHIVE_ENTRIES (default 8192)
  env SKILLS_MAX_DOWNLOAD_BYTES (default 256 MiB), SKILLS_FETCH_TIMEOUT_MS (default 60000),
      SKILLS_FETCH_TOKEN (or GH_TOKEN / GITHUB_TOKEN) for private archive assets
`;

export function validateLibraries(libs: Library[]): void {
  const seen = new Set<string>();
  for (const l of libs) {
    if (l.url) {
      let u: URL;
      try { u = new URL(l.url); } catch { throw new Error(`library '${l.namespace || "(root)"}' has an invalid url '${l.url}'`); }
      if (u.protocol !== "https:") throw new Error(`library '${l.namespace || "(root)"}' must use https, got '${u.protocol}//'`);
      if (l.sha256 && !/^[0-9a-f]{64}$/i.test(l.sha256)) throw new Error(`library '${l.namespace || "(root)"}' has a malformed sha256 pin`);
      l.sha256 = l.sha256?.toLowerCase();
      l.root = l.url;      // identifier shown in stats and logs
      l.archive = true;
    } else {
      if (typeof l.root !== "string" || !l.root) throw new Error(`library '${l.namespace}' has no root`);
      l.root = path.resolve(l.root);
      l.archive = isArchiveRoot(l.root);
    }
    if (l.namespace && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(l.namespace)) throw new Error(`library namespace '${l.namespace}' must match [a-zA-Z0-9][a-zA-Z0-9_.-]*`);
    if (l.info) validateInfo(l.namespace, l.info);
    if (seen.has(l.namespace)) throw new Error(`duplicate library namespace '${l.namespace || "(root)"}'`);
    seen.add(l.namespace);
  }
  if (libs.length > 1 && libs.some((l) => !l.namespace)) throw new Error(`--root cannot be combined with other libraries; give every library a namespace`);
}

function validateInfo(ns: string, info: LibraryInfo): void {
  const who = `library '${ns || "(root)"}'`;
  for (const k of ["title", "source", "version"] as const) {
    if (info[k] !== undefined && (typeof info[k] !== "string" || info[k]!.length > 200)) throw new Error(`${who}: ${k} must be a string of at most 200 characters`);
  }
  if (info.metadata !== undefined) {
    if (!info.metadata || typeof info.metadata !== "object" || Array.isArray(info.metadata)) throw new Error(`${who}: metadata must be an object of strings`);
    for (const [k, v] of Object.entries(info.metadata)) {
      if (typeof v !== "string" || k.length > 64 || v.length > 500) throw new Error(`${who}: metadata.${k} must be a string (key ≤ 64, value ≤ 500 characters)`);
    }
  }
}

/** Lift the descriptive fields of a config-file library entry into a LibraryInfo, or undefined when there are none. */
export function infoOf(l: LibraryInfo): LibraryInfo | undefined {
  const info: LibraryInfo = {};
  if (l.title !== undefined) info.title = l.title;
  if (l.source !== undefined) info.source = l.source;
  if (l.version !== undefined) info.version = l.version;
  if (l.metadata !== undefined) info.metadata = l.metadata;
  return Object.keys(info).length ? info : undefined;
}

export function readConfigFile(file: string): ConfigFile {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`cannot read config ${file}: ${(e as Error).message}`); }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).libraries)) throw new Error(`config ${file}: expected {"libraries": [...]}`);
  const cf = raw as ConfigFile;
  const base = path.dirname(file);
  // A url library has no root to resolve; String(undefined) would become a bogus "undefined" path.
  cf.libraries = cf.libraries.map((l) => (l.url ? { ...l } : { ...l, root: path.resolve(base, String(l.root)) }));
  return cf;
}

/**
 * Re-read the config file into an existing Config (in place). Returns true when the library set changed.
 * CLI-provided libraries (--root/--lib) are kept; only file-provided ones are replaced.
 */
export function reloadConfigFile(cfg: Config, cliLibs: Library[]): boolean {
  if (!cfg.configFile) return false;
  const cf = readConfigFile(cfg.configFile);
  const next: Library[] = [...cliLibs, ...cf.libraries.map((l) => ({ namespace: l.namespace, root: l.root ?? "", url: l.url, sha256: l.sha256, noScripts: l.noScripts, info: infoOf(l) }))];
  validateLibraries(next);
  const key = (ls: Library[]) => JSON.stringify(ls.map((l) => [l.namespace, l.root, l.url ?? "", l.sha256 ?? "", !!l.noScripts, l.info ?? null]));
  const changed = key(next) !== key(cfg.libraries) || !!cf.noScripts !== cfg.noScripts || (cf.lint === false) === cfg.lint;
  cfg.libraries.splice(0, cfg.libraries.length, ...next);
  cfg.root = next[0].root;
  if (cf.noScripts !== undefined) cfg.noScripts = !!cf.noScripts;
  if (cf.lint !== undefined) cfg.lint = cf.lint !== false;
  return changed;
}

function parseLib(kv: string): Library {
  const i = kv.indexOf("=");
  if (i <= 0) throw new Error(`--lib expects NS=DIR, got '${kv}'`);
  const namespace = kv.slice(0, i).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(namespace)) throw new Error(`library namespace '${namespace}' must match [a-zA-Z0-9][a-zA-Z0-9_.-]*`);
  return { namespace, ...parseLibValue(kv.slice(i + 1).trim()) };
}

/**
 * A library value is a directory, a .zip path, or an https URL of a .zip with an optional
 * `#sha256=<64 hex>` pin. Shared by --lib and --root.
 */
function parseLibValue(value: string): { root: string; url?: string; sha256?: string } {
  if (!isUrlRoot(value)) return { root: value };
  const hash = value.indexOf("#sha256=");
  if (hash > 0) {
    return { root: "", url: value.slice(0, hash), sha256: value.slice(hash + 8).trim().toLowerCase() };
  }
  return { root: "", url: value };
}

function env(name: string): string | undefined {
  return process.env[`SKILLS_${name}`] ?? process.env[`BOB_SKILLS_${name}`]; // BOB_* kept for backward compatibility
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let root = env("ROOT");
  let configFile = env("CONFIG");
  let noScripts = (env("NO_SCRIPTS") ?? "false") === "true";
  let lint = (env("LINT") ?? "true") !== "false";
  const libs: Library[] = [];
  for (const kv of (env("LIBS") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) libs.push(parseLib(kv));
  let name = env("NAME");
  let prefix = env("TOOL_PREFIX");
  let title = env("TITLE");
  let exclude = env("EXCLUDE") ?? "_archive,_audit";
  let depth = Number(env("DEPTH") ?? 4);
  let hideDisabled = (env("HIDE_DISABLED") ?? "true") !== "false";
  let http: Config["http"];
  let statsOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--root") root = next();
    else if (a === "--lib") libs.push(parseLib(next()));
    else if (a === "--config") configFile = next();
    else if (a === "--no-scripts") noScripts = true;
    else if (a === "--no-lint") lint = false;
    else if (a === "--name") name = next();
    else if (a === "--prefix") prefix = next();
    else if (a === "--title") title = next();
    else if (a === "--exclude") exclude = next();
    else if (a === "--depth") depth = Number(next());
    else if (a === "--http") http = { port: Number(argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : 3939), host: env("HOST") ?? "127.0.0.1" };
    else if (a === "--show-disabled") hideDisabled = false;
    else if (a === "--stats") statsOnly = true;
    else if (a === "--help" || a === "-h") { process.stderr.write(HELP); process.exit(0); }
    else throw new Error(`Unknown argument ${a}\n${HELP}`);
  }
  // --root accepts a directory, a .zip, or an https URL (with an optional #sha256= pin).
  if (root) libs.unshift({ namespace: "", ...parseLibValue(root) });
  if (configFile) {
    const cf = readConfigFile(path.resolve(configFile));
    libs.push(...cf.libraries.map((l) => ({ namespace: l.namespace, root: l.root ?? "", url: l.url, sha256: l.sha256, noScripts: l.noScripts, info: infoOf(l) })));
    if (cf.noScripts) noScripts = true;
    if (cf.lint === false) lint = false;
  }
  if (libs.length === 0) throw new Error(`--root DIR, --lib NS=DIR or --config FILE (or SKILLS_ROOT / SKILLS_LIBS / SKILLS_CONFIG) is required.\n${HELP}`);
  validateLibraries(libs);
  name ??= libs.length === 1 && libs[0].namespace ? libs[0].namespace : "skills";
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`--name must match [a-zA-Z0-9_-]+`);
  prefix ??= name.replace(/-/g, "_");
  if (!/^[a-zA-Z0-9_]+$/.test(prefix)) throw new Error(`--prefix must match [a-zA-Z0-9_]+`);

  return {
    libraries: libs,
    root: libs[0].root,
    configFile: configFile ? path.resolve(configFile) : undefined,
    noScripts,
    lint,
    serverName: name,
    title: title ?? `${name} (Agent Skills over MCP)`,
    toolPrefix: prefix,
    excludeDirs: new Set(exclude.split(",").map((s) => s.trim()).filter(Boolean)),
    ignoreDirs: new Set([".venv", "venv", "node_modules", "__pycache__", ".git", ".pytest_cache", ".mypy_cache", ".ruff_cache", "site-packages"]),
    ignoreExts: new Set([".pyc", ".pyo", ".so", ".dylib", ".dll", ".whl", ".pyi"]),
    hideDisabled,
    maxFileBytes: Number(env("MAX_FILE_BYTES") ?? 4 * 1024 * 1024),
    maxFilesPerSkill: 512,
    maxDiscoveryDepth: Number.isFinite(depth) && depth > 0 ? depth : 4,
    rescanSeconds: Number(env("RESCAN_SECONDS") ?? 60),
    cacheDir: env("CACHE_DIR") ? path.resolve(env("CACHE_DIR")!) : defaultCacheRoot(),
    maxDownloadBytes: Number(env("MAX_DOWNLOAD_BYTES") ?? 256 * 1024 * 1024),
    fetchTimeoutMs: Number(env("FETCH_TIMEOUT_MS") ?? 60_000),
    fetchToken: env("FETCH_TOKEN") ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    archiveLimits: {
      ...DEFAULT_LIMITS,
      maxTotalBytes: Number(env("MAX_ARCHIVE_BYTES") ?? DEFAULT_LIMITS.maxTotalBytes),
      maxEntries: Number(env("MAX_ARCHIVE_ENTRIES") ?? DEFAULT_LIMITS.maxEntries),
      maxEntryBytes: Number(env("MAX_FILE_BYTES") ?? 4 * 1024 * 1024) * 16,
    },
    http,
    statsOnly,
  };
}
