/**
 * `skills-mcp pull` — client-side sync of skills from any SEP-2640 server to a local directory.
 * Uses skills/list (paginated) + resources/read, verifies every sha256 digest, writes atomically.
 */
import fs from "node:fs/promises";
import { PKG_VERSION } from "./version.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";

export interface PullOptions {
  /** Streamable HTTP endpoint of the server, or ... */
  url?: string;
  /** ... a stdio command line to spawn (argv). */
  command?: string[];
  /** Skill names or skill paths to fetch; empty + all=true fetches everything. */
  skills: string[];
  all: boolean;
  list: boolean;
  /** Destination directory; each skill is written to <to>/<skill name>/ (or <to>/<skill path>/ with keepPath). */
  to: string;
  keepPath: boolean;
  /** Also pull every skill the selected ones declare as a required runtime dependency, transitively, from the same library. */
  withDeps?: boolean;
  force: boolean;
  /** Update an existing folder in place: keep files whose sha256 matches, fetch the rest, delete files not in the manifest. */
  sync: boolean;
  dryRun: boolean;
  /** Skip the protocol-era probe and use the 2025 initialize handshake only. */
  legacyProtocol?: boolean;
  log: (msg: string) => void;
}

const SkillEntry = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.literal("dynamic"), z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number().int().nonnegative() }))]),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const SkillsListResult = z.object({ skills: z.array(SkillEntry), nextCursor: z.string().optional() }).passthrough();
type SkillEntryT = z.infer<typeof SkillEntry>;
/** SEP-2640 final wraps the entry as `{skill}`; draft-era servers returned the bare entry. Accept both. */
const SkillsGetResult = z.union([z.object({ skill: SkillEntry }).passthrough(), SkillEntry]);

async function getSkill(client: Client, uri: string): Promise<SkillEntryT> {
  const r = await client.request({ method: "skills/get", params: { uri } }, SkillsGetResult);
  return "skill" in r ? r.skill : r;
}

const DEPS_KEY = "io.modelcontextprotocol.skills/dependencies";
const LIBRARY_KEY = "io.modelcontextprotocol.skills/library";

/** Required runtime dependencies a server declares for a skill entry (names, same library). */
export function requiredDepsOf(e: { _meta?: Record<string, unknown> }): string[] {
  const d = e._meta?.[DEPS_KEY] as { required?: unknown } | undefined;
  return Array.isArray(d?.required) ? d!.required.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]*$/i.test(x)) : [];
}

export function skillPathOf(uri: string): string {
  return uri.replace(/^skill:\/\//, "").replace(/\/SKILL\.md$/, "").split("/").map(decodeURIComponent).join("/");
}

export async function listAllSkills(client: Client): Promise<SkillEntryT[]> {
  const out: SkillEntryT[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.request({ method: "skills/list", params: cursor ? { cursor } : {} }, SkillsListResult);
    out.push(...res.skills);
    cursor = res.nextCursor;
  } while (cursor);
  return out;
}

function makeTransport(o: PullOptions): Transport {
  if (o.url) return new StreamableHTTPClientTransport(new URL(o.url));
  if (o.command && o.command.length) return new StdioClientTransport({ command: o.command[0], args: o.command.slice(1), stderr: "ignore" });
  throw new Error("pull needs --url <endpoint> or --command <argv...>");
}

export async function pull(o: PullOptions): Promise<{ written: number; skipped: number; skills: string[] }> {
  // 'auto' probes with server/discover and falls back to the 2025 handshake, so pull works against
  // 2025-only servers and against servers that expose skills only on 2026-07-28.
  const client = new Client({ name: "skills-mcp-pull", version: PKG_VERSION },
    { versionNegotiation: { mode: o.legacyProtocol ? "legacy" : "auto" } });
  await client.connect(makeTransport(o));
  try {
    const caps = client.getServerCapabilities();
    if (!caps?.extensions?.["io.modelcontextprotocol/skills"]) o.log("warning: server does not declare the SEP-2640 skills extension; trying skills/list anyway");
    const entries = await listAllSkills(client);
    if (o.list) {
      for (const e of entries) o.log(`${skillPathOf(e.uri)}\t${String(e.frontmatter.description ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
      return { written: 0, skipped: 0, skills: entries.map((e) => skillPathOf(e.uri)) };
    }
    let selected: SkillEntryT[];
    if (o.all) selected = entries;
    else {
      selected = [];
      for (const want of o.skills) {
        const byPath = entries.filter((e) => skillPathOf(e.uri) === want);
        const byName = entries.filter((e) => e.frontmatter.name === want || skillPathOf(e.uri).split("/").pop() === want);
        const hits = byPath.length ? byPath : byName;
        if (hits.length === 0) throw new Error(`skill '${want}' not found on server`);
        if (hits.length > 1) throw new Error(`skill '${want}' is ambiguous: ${hits.map((h) => skillPathOf(h.uri)).join(", ")} — use the full path`);
        selected.push(hits[0]);
      }
    }
    if (!selected.length) throw new Error("nothing selected: give skill names, or --all");
    if (o.withDeps && !o.all) selected = await withDependencies(client, entries, selected, o.log);

    let written = 0, skipped = 0;
    const done: string[] = [];
    for (const e of selected) {
      const sp = skillPathOf(e.uri);
      const name = String(e.frontmatter.name ?? sp.split("/").pop());
      const dest = path.resolve(o.to, o.keepPath ? sp : name);
      if (!dest.startsWith(path.resolve(o.to) + path.sep)) throw new Error(`refusing to write outside ${o.to}: ${dest}`);
      let resources = e.resources;
      if (resources === "dynamic") {
        // Not enumerable up front: re-ask skills/get (servers MUST answer) and fall back to SKILL.md only.
        const g = await getSkill(client, e.uri);
        resources = g.resources === "dynamic" ? [{ uri: e.uri, digest: "", size: 0 }] : g.resources;
      }
      const exists = await fs.stat(dest).then(() => true, () => false);
      if (exists && !o.force && !o.sync) { o.log(`skip  ${sp} (exists at ${dest}; use --force or --sync)`); skipped++; continue; }
      const prefix = e.uri.replace(/SKILL\.md$/, "");
      const wanted = new Map<string, (typeof resources)[number]>();
      for (const r of resources) {
        if (!r.uri.startsWith(prefix)) throw new Error(`${sp}: resource ${r.uri} is outside the skill`);
        const rel = r.uri.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
        if (rel.split("/").some((seg) => seg === ".." || seg === "" )) throw new Error(`${sp}: unsafe path ${rel}`);
        wanted.set(rel, r);
      }
      // --sync: a local file whose bytes already hash to the manifest digest is kept without a network read.
      const current = new Set<string>();
      if (o.sync && exists) {
        for (const rel of await listFiles(dest)) {
          const r = wanted.get(rel);
          if (r?.digest && (await sha256File(path.join(dest, ...rel.split("/")))) === r.digest) current.add(rel);
        }
      }
      const todo = [...wanted].filter(([rel]) => !current.has(rel));
      const stale = o.sync && exists ? (await listFiles(dest)).filter((rel) => !wanted.has(rel)) : [];
      if (!todo.length && !stale.length) { o.log(`ok    ${sp} up to date at ${dest} (${wanted.size} files)`); skipped++; done.push(sp); continue; }
      if (todo.length) o.log(`${o.dryRun ? "would" : "pull "} ${sp} → ${dest} (${todo.length} of ${wanted.size} files)`);
      for (const [rel, r] of todo) {
        const res = await client.readResource({ uri: r.uri });
        const c = res.contents[0];
        if (!c) throw new Error(`${sp}: empty read for ${r.uri}`);
        const buf = "blob" in c && typeof c.blob === "string" ? Buffer.from(c.blob, "base64") : Buffer.from(String((c as any).text ?? ""), "utf8");
        if (r.digest) {
          const actual = "sha256:" + createHash("sha256").update(buf).digest("hex");
          if (actual !== r.digest) throw new Error(`${sp}: digest mismatch for ${rel}\n  expected ${r.digest}\n  actual   ${actual}`);
        }
        if (o.dryRun) continue;
        const target = path.join(dest, ...rel.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const tmp = target + ".tmp-" + process.pid;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, target);
        written++;
      }
      for (const rel of stale) {
        o.log(`${o.dryRun ? "would rm" : "rm   "} ${sp}/${rel} (no longer in the skill)`);
        if (!o.dryRun) await fs.rm(path.join(dest, ...rel.split("/")));
      }
      if (stale.length && !o.dryRun) await pruneEmptyDirs(dest);
      done.push(sp);
    }
    return { written, skipped, skills: done };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Add the transitive required-dependency closure of the selected skills. A dependency is looked
 * up in the same library: the sibling skill path first, then an entry of the same library with that
 * name, then skills/get on the sibling URI (hidden skills are not listed but still served).
 * Cross-library dependencies are not supported; an unresolvable one is an error, since the
 * skill's scripts would fail without it.
 */
async function withDependencies(client: Client, entries: SkillEntryT[], selected: SkillEntryT[], log: (m: string) => void): Promise<SkillEntryT[]> {
  const out = [...selected];
  const seen = new Set(out.map((e) => e.uri));
  const queue = [...out];
  while (queue.length) {
    const e = queue.shift()!;
    const sp = skillPathOf(e.uri);
    const parent = sp.split("/").slice(0, -1).join("/");
    const lib = e._meta?.[LIBRARY_KEY];
    for (const dep of requiredDepsOf(e)) {
      const sibling = parent ? `${parent}/${dep}` : dep;
      let hit = entries.find((x) => skillPathOf(x.uri) === sibling)
        ?? entries.find((x) => lib !== undefined && x._meta?.[LIBRARY_KEY] === lib && (x.frontmatter.name === dep || skillPathOf(x.uri).split("/").pop() === dep));
      if (!hit) {
        const uri = `skill://${sibling.split("/").map(encodeURIComponent).join("/")}/SKILL.md`;
        hit = await getSkill(client, uri).catch(() => undefined);
      }
      if (!hit) throw new Error(`${sp} declares runtime dependency '${dep}', which the server does not serve in the same library; pull without --with-deps to fetch the skill alone`);
      if (seen.has(hit.uri)) continue;
      seen.add(hit.uri);
      log(`deps  ${sp} → ${skillPathOf(hit.uri)}`);
      out.push(hit);
      queue.push(hit);
    }
  }
  return out;
}

const PULL_HELP = `skills-mcp pull [skill ...] (--url URL | --command CMD [ARGS...]) --to DIR [--all] [--list] [--keep-path] [--with-deps] [--sync] [--force] [--dry-run]

  Sync skills from any SEP-2640 server into DIR/<skill-name>/ with sha256 verification.
  --url URL          Streamable HTTP endpoint, e.g. http://127.0.0.1:3939/mcp
  --command CMD...   spawn a stdio server; everything after --command is the argv
  --to DIR           destination directory (default ./skills)
  --all              pull every skill the server lists
  --list             only list skills on the server
  --keep-path        use the full skill path (incl. namespace) as the folder name
  --with-deps        also pull the skills each selected skill declares as a required runtime
                     dependency (transitively, same library), as its siblings; running a skill's
                     scripts runs theirs too, so approve the whole closure
  --sync             update existing skill folders in place: keep files whose sha256 already
                     matches (no network read), fetch the rest, delete files not in the skill
  --force            overwrite existing skill folders
  --dry-run          verify digests but write nothing
  --legacy-protocol  skip the 2026-07-28 probe; use the 2025 initialize handshake only
`;

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await listFiles(abs, base));
    else if (ent.isFile()) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

/** Remove directories left empty by deletions, but never the skill folder itself. */
async function pruneEmptyDirs(dir: string, root = dir): Promise<void> {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const abs = path.join(dir, ent.name);
    await pruneEmptyDirs(abs, root);
    if ((await fs.readdir(abs)).length === 0) await fs.rmdir(abs);
  }
}

async function sha256File(abs: string): Promise<string> {
  return "sha256:" + createHash("sha256").update(await fs.readFile(abs)).digest("hex");
}

export function parsePullArgs(argv: string[]): PullOptions {
  const o: PullOptions = { skills: [], all: false, list: false, to: "./skills", keepPath: false, force: false, sync: false, dryRun: false, log: (m) => process.stderr.write(m + "\n") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value\n${PULL_HELP}`); return v; };
    if (a === "--url") o.url = next();
    else if (a === "--command") { o.command = argv.slice(i + 1); break; }
    else if (a === "--to") o.to = next();
    else if (a === "--all") o.all = true;
    else if (a === "--list") o.list = true;
    else if (a === "--keep-path") o.keepPath = true;
    else if (a === "--with-deps") o.withDeps = true;
    else if (a === "--force") o.force = true;
    else if (a === "--sync") o.sync = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--legacy-protocol") o.legacyProtocol = true;
    else if (a === "--help" || a === "-h") { process.stderr.write(PULL_HELP); process.exit(0); }
    else if (a.startsWith("--")) throw new Error(`Unknown argument ${a}\n${PULL_HELP}`);
    else o.skills.push(a);
  }
  return o;
}
