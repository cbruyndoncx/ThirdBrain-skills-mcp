import path from "node:path";
import fs from "node:fs";
import { isArchiveRoot, defaultCacheRoot, DEFAULT_LIMITS, type ExtractLimits } from "./archive.js";

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
  /** Withhold executable files (scripts) from this library's manifests. */
  noScripts?: boolean;
}

/** Shape of the optional JSON config file (--config). Re-read on every rescan and on SIGHUP. */
export interface ConfigFile {
  libraries: { namespace: string; root: string; noScripts?: boolean }[];
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
  http?: { port: number; host: string };
  statsOnly: boolean;
}

const HELP = `skills-mcp — serve a directory of Agent Skills (SKILL.md folders) over MCP (SEP-2640 + discovery tools)

usage: skills-mcp [serve] (--root DIR | --lib NS=DIR ...) [--name NAME] [--prefix PREFIX] [--title TITLE] [--http PORT] [--show-disabled] [--stats]
       skills-mcp pull --help        sync skills from any SEP-2640 server to disk

  --config FILE      JSON {libraries:[{namespace,root,noScripts?}],noScripts?,lint?}; re-read on rescan/SIGHUP   env SKILLS_CONFIG
  --no-scripts       withhold executable files (.sh .py .js .ps1 ...) from all manifests      env SKILLS_NO_SCRIPTS=true
  --no-lint          disable the scan-time risk linter                                        env SKILLS_LINT=false
  --root DIR|ZIP     single un-namespaced library (skill://<skill>/...)          env SKILLS_ROOT
  --lib NS=DIR|ZIP   add a namespaced library (skill://NS/<skill>/...); repeatable env SKILLS_LIBS="bob=/a,gbl=/b.zip"
                     A .zip root is extracted to the cache dir before discovery; archives are
                     never allowed *inside* a library.
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
`;

export function validateLibraries(libs: Library[]): void {
  const seen = new Set<string>();
  for (const l of libs) {
    if (typeof l.root !== "string" || !l.root) throw new Error(`library '${l.namespace}' has no root`);
    l.root = path.resolve(l.root);
    l.archive = isArchiveRoot(l.root);
    if (l.namespace && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(l.namespace)) throw new Error(`library namespace '${l.namespace}' must match [a-zA-Z0-9][a-zA-Z0-9_.-]*`);
    if (seen.has(l.namespace)) throw new Error(`duplicate library namespace '${l.namespace || "(root)"}'`);
    seen.add(l.namespace);
  }
  if (libs.length > 1 && libs.some((l) => !l.namespace)) throw new Error(`--root cannot be combined with other libraries; give every library a namespace`);
}

export function readConfigFile(file: string): ConfigFile {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`cannot read config ${file}: ${(e as Error).message}`); }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).libraries)) throw new Error(`config ${file}: expected {"libraries": [...]}`);
  const cf = raw as ConfigFile;
  const base = path.dirname(file);
  cf.libraries = cf.libraries.map((l) => ({ ...l, root: path.resolve(base, String(l.root)) }));
  return cf;
}

/**
 * Re-read the config file into an existing Config (in place). Returns true when the library set changed.
 * CLI-provided libraries (--root/--lib) are kept; only file-provided ones are replaced.
 */
export function reloadConfigFile(cfg: Config, cliLibs: Library[]): boolean {
  if (!cfg.configFile) return false;
  const cf = readConfigFile(cfg.configFile);
  const next: Library[] = [...cliLibs, ...cf.libraries.map((l) => ({ namespace: l.namespace, root: l.root, noScripts: l.noScripts }))];
  validateLibraries(next);
  const key = (ls: Library[]) => JSON.stringify(ls.map((l) => [l.namespace, l.root, !!l.noScripts]));
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
  return { namespace, root: kv.slice(i + 1).trim() };
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
  if (root) libs.unshift({ namespace: "", root });
  if (configFile) {
    const cf = readConfigFile(path.resolve(configFile));
    libs.push(...cf.libraries.map((l) => ({ namespace: l.namespace, root: l.root, noScripts: l.noScripts })));
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
