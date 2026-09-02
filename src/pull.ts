/**
 * `skills-mcp pull` — client-side sync of skills from any SEP-2640 server to a local directory.
 * Uses skills/list (paginated) + resources/read, verifies every sha256 digest, writes atomically.
 */
import fs from "node:fs/promises";
import { PKG_VERSION } from "./version.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
  force: boolean;
  dryRun: boolean;
  log: (msg: string) => void;
}

const SkillEntry = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.literal("dynamic"), z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number().int().nonnegative() }))]),
});
const SkillsListResult = z.object({ skills: z.array(SkillEntry), nextCursor: z.string().optional() }).passthrough();
type SkillEntryT = z.infer<typeof SkillEntry>;

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
  const client = new Client({ name: "skills-mcp-pull", version: PKG_VERSION });
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
        const g = await client.request({ method: "skills/get", params: { uri: e.uri } }, SkillEntry);
        resources = g.resources === "dynamic" ? [{ uri: e.uri, digest: "", size: 0 }] : g.resources;
      }
      const exists = await fs.stat(dest).then(() => true, () => false);
      if (exists && !o.force) { o.log(`skip  ${sp} (exists at ${dest}; use --force)`); skipped++; continue; }
      o.log(`${o.dryRun ? "would" : "pull "} ${sp} → ${dest} (${resources.length} files)`);
      const prefix = e.uri.replace(/SKILL\.md$/, "");
      for (const r of resources) {
        if (!r.uri.startsWith(prefix)) throw new Error(`${sp}: resource ${r.uri} is outside the skill`);
        const rel = r.uri.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
        if (rel.split("/").some((seg) => seg === ".." || seg === "" )) throw new Error(`${sp}: unsafe path ${rel}`);
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
      done.push(sp);
    }
    return { written, skipped, skills: done };
  } finally {
    await client.close().catch(() => {});
  }
}

const PULL_HELP = `skills-mcp pull [skill ...] (--url URL | --command CMD [ARGS...]) --to DIR [--all] [--list] [--keep-path] [--force] [--dry-run]

  Sync skills from any SEP-2640 server into DIR/<skill-name>/ with sha256 verification.
  --url URL          Streamable HTTP endpoint, e.g. http://127.0.0.1:3939/mcp
  --command CMD...   spawn a stdio server; everything after --command is the argv
  --to DIR           destination directory (default ./skills)
  --all              pull every skill the server lists
  --list             only list skills on the server
  --keep-path        use the full skill path (incl. namespace) as the folder name
  --force            overwrite existing skill folders
  --dry-run          verify digests but write nothing
`;

export function parsePullArgs(argv: string[]): PullOptions {
  const o: PullOptions = { skills: [], all: false, list: false, to: "./skills", keepPath: false, force: false, dryRun: false, log: (m) => process.stderr.write(m + "\n") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value\n${PULL_HELP}`); return v; };
    if (a === "--url") o.url = next();
    else if (a === "--command") { o.command = argv.slice(i + 1); break; }
    else if (a === "--to") o.to = next();
    else if (a === "--all") o.all = true;
    else if (a === "--list") o.list = true;
    else if (a === "--keep-path") o.keepPath = true;
    else if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") { process.stderr.write(PULL_HELP); process.exit(0); }
    else if (a.startsWith("--")) throw new Error(`Unknown argument ${a}\n${PULL_HELP}`);
    else o.skills.push(a);
  }
  return o;
}
