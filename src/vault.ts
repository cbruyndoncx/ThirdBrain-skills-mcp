/**
 * Vault extras: playbooks and value chains.
 *
 * A library laid out as a ThirdBrain BOB vault (`00-CORE/Agents/skills` plus the folders below)
 * may hold two other kinds of information that agents need to chain skills into outcomes. The
 * conventions come from BOB; any library that follows them is served the same way, and one that
 * does not is served as skills only:
 *
 *  - Playbooks: markdown notes with `type: playbook` frontmatter under `00-CORE/Playbooks/` (the
 *    only folder served; company, personal and client playbook folders are private and only
 *    counted). Each one lists numbered steps that name skills (`3 (5). cro → audit page (AGENT)`,
 *    or `[[cro]]` links in the step text), a trigger, an outcome and the value chain it covers.
 *    Executing one requires the `playbook-runner` skill, so playbooks are only served when that
 *    skill is served too.
 *  - Value chains: end-to-end business journeys with ordered stages. Canonical definitions live in
 *    `20-COMPANY/03-PROCESSES/value-chains.md` (`### <id>` blocks with `**SME Label:**`,
 *    `**Description:**` and `**Stages:**` fields, bulleted or not), plus the unstaged groups
 *    (`## Cross-Chain: …` / `## Meta-Chain: …` sections and the "Valid chain IDs" list) that are
 *    served as buckets; the generated `VALUE-CHAINS.md` at the vault root carries the chains under
 *    `## <id>`. When neither file exists, chains are derived from the `value-chains` /
 *    `chain-stage` frontmatter of skills and the `value-chain` / `chain-coverage` frontmatter of
 *    playbooks. No skill gates them: coverage is computed here from the catalog.
 *
 * Both are optional and are read only from inside the library root the operator gave (or a vault
 * directory named explicitly). Nothing here runs anything; all of it is read-only discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { splitFrontmatter, coerceString, coerceList } from "./frontmatter.js";

/**
 * The only playbook folder that is served: the vault-shipped library. Company, personal and client
 * playbooks (`20-COMPANY/03-PROCESSES/Playbooks`, `10-ME/Playbooks`, `30-CLIENTS/<id>/Playbooks`)
 * are private to the vault owner and never leave the server.
 */
export const PLAYBOOK_DIR = "00-CORE/Playbooks";
export const PRIVATE_PLAYBOOK_DIRS = ["20-COMPANY/03-PROCESSES/Playbooks", "10-ME/Playbooks"];
/** Chain definition files, tried first; any other `value-chains.md` (case-insensitive) is found by walking. */
export const VALUE_CHAIN_FILES = ["20-COMPANY/03-PROCESSES/value-chains.md", "VALUE-CHAINS.md"];
const CHAIN_FILE_RE = /^value-chains\.md$/i;
/** How deep below the vault root the layout walk looks for Playbooks folders and the chain file. */
const WALK_DEPTH = 4;
/** Subdirectories of a playbook root that hold retired or teaser notes, never runnable playbooks. */
const EXCLUDED_SUBDIRS = new Set(["_archive", "UPGRADE"]);
/** Files that live in a playbook directory but are not playbooks (folder manifests, local guidance). */
const NON_PLAYBOOK_FILES = new Set(["AGENTS.md", "CLAUDE.md", "_local.md"]);
/** The skill that executes playbooks. Playbooks are withheld when it is not served. */
export const PLAYBOOK_RUNNER = "playbook-runner";

export interface PlaybookStep {
  n: number;
  /**
   * Skill the step delegates to: the head of `cro → ...` / `cro (route) → ...` / `[[cro]] → ...`,
   * else the first served skill the step links to (`[[cro]]`, `[[cro/SKILL.md|…]]`,
   * `{skills.root}/cro/...`).
   */
  skill?: string;
  /** Route named in the head, `cro (audit) → ...`. */
  route?: string;
  /** Further served skills the step links to, besides `skill`. */
  mentions?: string[];
  /** What the step does, without the skill prefix and actor suffix. */
  action: string;
  /** Who performs it as written in the playbook: AGENT, HUMAN, HUMAN + AGENT, ... */
  actor?: string;
}

export interface PlaybookAttachment {
  /** File name in the playbook's folder, as embedded with `![[name]]`. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
  digest?: string;
}

export interface Playbook {
  /** File stem, e.g. "CRO improvement loop". */
  name: string;
  title: string;
  library: string;
  /** `<library>/<name>` (or just `<name>` for an un-namespaced library): the key used in URIs. */
  playbookPath: string;
  /** playbook://<playbookPath> */
  uri: string;
  abs: string;
  /** Path relative to the vault root, forward slashes: "00-CORE/Playbooks/CRO improvement loop.md". */
  vaultRel: string;
  trigger: string;
  outcome: string;
  totalSteps: number;
  duration: string;
  status: string;
  valueChain: string;
  chainCoverage: string[];
  tags: string[];
  maturity: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  steps: PlaybookStep[];
  /** Skills named by the steps, in order, de-duplicated. */
  skills: string[];
  attachments: PlaybookAttachment[];
  size: number;
  mtimeMs: number;
  digest?: string;
  /** True when the note sits in a subdirectory of its playbook root (the vault's "misplaced" bucket). */
  misplaced: boolean;
  /** Fingerprint of the served skill names the steps were matched against (cache key). */
  skillSetKey?: string;
}

export interface ValueChainDef {
  id: string;
  label: string;
  description: string;
  stages: string[];
  /**
   * `chain`: an ordered journey with stages. `bucket`: an unstaged group that serves every chain
   * (Cross-Chain / Meta-Chain sections, or an id listed as valid without a chain block): no
   * stages, no coverage gaps.
   */
  kind: "chain" | "bucket";
}

export interface ValueChain extends ValueChainDef {
  library: string;
  /** value-chain://<library>/<id> */
  uri: string;
  /** Where the definition came from. */
  source: "definition" | "index" | "derived";
  /** Skill names per stage; "" collects skills that declare the chain without a stage. */
  skillsByStage: Record<string, string[]>;
  /** Playbook names per stage; "" collects playbooks without chain-coverage. */
  playbooksByStage: Record<string, string[]>;
  skillCount: number;
  playbookCount: number;
}

const SKILLS_SUBDIR = path.join("00-CORE", "Agents", "skills");

export interface VaultLayout {
  /** Directory searched for SKILL.md folders. */
  skillsRoot: string;
  /** Directory searched for playbooks and chain definitions, null when the library is not in a vault. */
  vaultRoot: string | null;
  /** How the vault was recognised, for the operator log. */
  how: "explicit" | "vault-root" | "wrapped-vault" | "markers" | "none";
}

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function hasMarkers(root: string, excludeDirs: Set<string>, ignoreDirs: Set<string>): Promise<boolean> {
  if (await isDir(path.join(root, PLAYBOOK_DIR))) return true;
  return (await walkFiles(root, root, excludeDirs, ignoreDirs, (name) => CHAIN_FILE_RE.test(name), 1)).length > 0;
}

/**
 * Decide where skills and vault extras live for a library root, so the same content works as a
 * checked-out folder, a zip, or a GitHub release asset (which wraps everything in one top-level
 * folder). The root is the boundary: nothing above or beside it is ever read. Only what is inside
 * decides the layout:
 *
 *  - the root contains `00-CORE/Agents/skills`        → skills there, vault is the root
 *  - the root holds one folder that contains it       → same, one level down (release zips)
 *  - the root contains `00-CORE/Playbooks` or a `value-chains.md` anywhere shallow → vault is the
 *    root, skills are discovered from the root as before
 *  - otherwise                                        → skills only
 *
 * A root that is itself a skills folder (`.../00-CORE/Agents/skills`) therefore serves skills only.
 * The operator may name a vault directory explicitly (`--vault`, or `vault` in the config file),
 * which is the one case where content outside the root is served, by explicit choice.
 */
export async function detectLayout(effectiveRoot: string, explicit: string | false | undefined, excludeDirs: Set<string>, ignoreDirs: Set<string>): Promise<VaultLayout> {
  if (explicit === false) return { skillsRoot: effectiveRoot, vaultRoot: null, how: "none" };
  if (typeof explicit === "string" && explicit) return { skillsRoot: effectiveRoot, vaultRoot: path.resolve(explicit), how: "explicit" };
  if (await isDir(path.join(effectiveRoot, SKILLS_SUBDIR))) return { skillsRoot: path.join(effectiveRoot, SKILLS_SUBDIR), vaultRoot: effectiveRoot, how: "vault-root" };
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(effectiveRoot, { withFileTypes: true }); } catch { /* unreadable: handled by the caller */ }
  const visible = entries.filter((e) => !e.name.startsWith("."));
  if (visible.length === 1 && visible[0].isDirectory()) {
    const inner = path.join(effectiveRoot, visible[0].name);
    if (await isDir(path.join(inner, SKILLS_SUBDIR))) return { skillsRoot: path.join(inner, SKILLS_SUBDIR), vaultRoot: inner, how: "wrapped-vault" };
  }
  if (await hasMarkers(effectiveRoot, excludeDirs, ignoreDirs)) return { skillsRoot: effectiveRoot, vaultRoot: effectiveRoot, how: "markers" };
  return { skillsRoot: effectiveRoot, vaultRoot: null, how: "none" };
}

async function walkFiles(root: string, dir: string, excludeDirs: Set<string>, ignoreDirs: Set<string>, match: (name: string) => boolean, depth: number, out: string[] = [], skip?: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isFile()) { if (match(e.name)) out.push(abs); continue; }
    if (!e.isDirectory() || excludeDirs.has(e.name) || ignoreDirs.has(e.name) || (skip && abs === skip)) continue;
    if (depth < WALK_DEPTH) await walkFiles(root, abs, excludeDirs, ignoreDirs, match, depth + 1, out, skip);
  }
  return out;
}

/** The served playbook folder (`00-CORE/Playbooks`) when it exists, and a count of notes in the private folders. */
export async function findPlaybookRoots(vaultRoot: string): Promise<{ roots: string[]; privateNotes: number }> {
  const core = path.join(vaultRoot, PLAYBOOK_DIR);
  const roots = (await isDir(core)) ? [core] : [];
  let privateNotes = 0;
  for (const rel of PRIVATE_PLAYBOOK_DIRS) {
    const found: { abs: string; misplaced: boolean }[] = [];
    if (await isDir(path.join(vaultRoot, rel))) await walkMd(path.join(vaultRoot, rel), 0, new Set(), found);
    privateNotes += found.length;
  }
  return { roots, privateNotes };
}

/** Candidate chain definition files, in preference order: the conventional paths, then any found by walking. */
export async function findChainFiles(vaultRoot: string, skillsRoot: string, excludeDirs: Set<string>, ignoreDirs: Set<string>): Promise<string[]> {
  const known: string[] = [];
  for (const rel of VALUE_CHAIN_FILES) { const abs = path.join(vaultRoot, rel); try { if ((await fs.stat(abs)).isFile()) known.push(abs); } catch { /* absent */ } }
  const found = (await walkFiles(vaultRoot, vaultRoot, excludeDirs, ignoreDirs, (n) => CHAIN_FILE_RE.test(n), 1, [], skillsRoot)).filter((f) => !known.includes(f)).sort();
  return [...known, ...found];
}

export const encodeSegs = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function playbookUri(playbookPath: string, rel?: string): string {
  return `playbook://${encodeSegs(playbookPath)}${rel ? "/" + encodeSegs(rel) : ""}`;
}

export function valueChainUri(library: string, id: string): string {
  return `value-chain://${library ? encodeURIComponent(library) + "/" : ""}${encodeURIComponent(id)}`;
}

// ---- playbooks ---------------------------------------------------------------

// Step grammar follows playbook-runner (`scripts/lint_playbook_grammar.py`): `N (countdown). head
// → action (AGENT|HUMAN[ — note])`, with head `skill`, `skill (route)`, `[[Playbook]]` or
// `script:file.py`, and bold/code decoration around the head ignored. Vault playbooks also wrap a
// step over indented continuation lines and name skills as `[[skill]]` links in the prose, with
// the actor at the end of the step's first paragraph.
const STEP_RE = /^(\s*)(\d+)\s*(?:\(\d+\))?[.)]\s+(.+?)\s*$/;
const ACTOR_WORDS = "(?:AGENT|HUMAN|AUTO|MANUAL|BOTH)";
/** A terminal actor made only of actor words: `(AGENT)`, `(HUMAN + AGENT)`. */
const ACTOR_RE = new RegExp(`\\s*\\((${ACTOR_WORDS}(?:\\s*[+/&]\\s*${ACTOR_WORDS})*)\\)\\s*:?\\s*$`, "i");
/** A terminal actor with a note: `(AGENT — run if …)`, `(HUMAN, 5 min)`, `(HUMAN decides, AGENT drafts)`. */
const ACTOR_NOTE_RE = new RegExp(`\\s*\\((${ACTOR_WORDS}\\b[^()]*)\\)\\s*:?\\s*$`);
/** An actor anywhere in the text, used when none ends it: `**Gate** (AGENT): …`. */
const ACTOR_INLINE_RE = new RegExp(`\\s*\\((${ACTOR_WORDS}\\b[^()]*)\\)`);
const SKILL_NAME_RE = /^([a-z0-9][a-z0-9_-]*)$/;
const SKILL_ROUTE_RE = /^([a-z0-9][a-z0-9_-]*)\s*\(\s*([a-z0-9][a-z0-9_-]*)\s*\)$/;
const WIKI_HEAD_RE = /^\[\[([^\]]+)\]\]$/;
const WIKILINK_RE = /(!?)\[\[([^\]]+?)\]\]/g;
const SKILLS_ROOT_REF_RE = /\{skills\.root\}\/([a-z0-9][a-z0-9_-]*)\//g;
const SKILL_SCRIPT_REF_RE = /(?<![\w./{}-])([a-z0-9][a-z0-9_-]*)\/scripts\//g;
const PHASE_HEADING_RE = /^(#{2,4})\s+(?:Phase|Step)\s+(\d+)\b\s*(?:[:.—–-]\s*)?(.*?)\s*$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^#{1,6}\s/;

/** Strip presentational decoration around a step head: `**cro**`, `__cro__`, `` `cro` ``. */
function normalizeHead(head: string): string {
  return head.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
}

/** The skill a wikilink target names: `cro`, `cro/SKILL.md`, `.../skills/cro/SKILL`; else null. */
function linkedSkill(target: string): string | null {
  const t = target.split(/[|#]/)[0].trim().replace(/\.md$/i, "");
  const segs = t.split("/").filter(Boolean);
  if (segs.length === 1) return segs[0];
  if (segs.length >= 2 && segs[segs.length - 1] === "SKILL") return segs[segs.length - 2];
  return null;
}

function normActor(a: string, strict: boolean): string {
  const s = a.replace(/\s+/g, " ").trim();
  return strict ? s.toUpperCase() : s;
}

/** Split a trailing actor off a text: strict form first, then the form with a note. */
function takeActor(text: string): { text: string; actor?: string } {
  const am = ACTOR_RE.exec(text);
  if (am) return { text: text.slice(0, am.index).trim(), actor: normActor(am[1], true) };
  const an = ACTOR_NOTE_RE.exec(text);
  if (an) return { text: text.slice(0, an.index).trim(), actor: normActor(an[1], false) };
  return { text };
}

/** Skills a step's text links to, in order: `[[skill]]`, `[[skill/SKILL.md|…]]`, `{skills.root}/skill/`, `skill/scripts/`. */
function linkedSkills(text: string, isSkill: (name: string) => boolean): string[] {
  const hits: { at: number; name: string }[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    if (m[1]) continue; // an embed, not a reference
    const name = linkedSkill(m[2]);
    if (name && isSkill(name)) hits.push({ at: m.index!, name });
  }
  for (const re of [SKILLS_ROOT_REF_RE, SKILL_SCRIPT_REF_RE]) for (const m of text.matchAll(re)) if (isSkill(m[1])) hits.push({ at: m.index!, name: m[1] });
  return [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.name))];
}

/** The first paragraph of a step: its numbered line plus continuation lines up to a blank line, list, fence or table. */
function leadOf(first: string, rest: string[]): string {
  const out = [first.trim()];
  for (const l of rest) {
    const t = l.trim();
    if (!t || /^([-*+]\s|```|~~~|\||>)/.test(t) || /^\d+[.)]\s/.test(t)) break;
    out.push(t);
  }
  return out.join(" ");
}

/** The actor ending any later paragraph of the step (a step whose first paragraph names none). */
function laterActor(rest: string[]): string | undefined {
  let fence = false;
  for (let i = 0; i < rest.length; i++) {
    if (FENCE_RE.test(rest[i])) { fence = !fence; continue; }
    if (fence) continue;
    const endsParagraph = i === rest.length - 1 || !rest[i + 1].trim();
    if (!endsParagraph) continue;
    const a = takeActor(rest[i].trim()).actor;
    if (a) return a;
  }
  return undefined;
}

function buildStep(n: number, first: string, rest: string[], isSkill?: (name: string) => boolean): PlaybookStep {
  let { text, actor } = takeActor(leadOf(first, rest));
  if (!actor) {
    const im = ACTOR_INLINE_RE.exec(text);
    if (im) {
      actor = new RegExp(`^${ACTOR_WORDS}(?:\\s*[+/&]\\s*${ACTOR_WORDS})*$`, "i").test(im[1].trim()) ? normActor(im[1], true) : normActor(im[1], false);
      text = (text.slice(0, im.index) + text.slice(im.index + im[0].length)).trim();
    } else actor = laterActor(rest);
  }
  let skill: string | undefined;
  let route: string | undefined;
  const arrow = text.indexOf("→");
  if (arrow > 0) {
    const head = normalizeHead(text.slice(0, arrow));
    let m: RegExpExecArray | null;
    if ((m = SKILL_NAME_RE.exec(head))) skill = m[1];
    else if ((m = SKILL_ROUTE_RE.exec(head))) { skill = m[1]; route = m[2]; }
    else if ((m = WIKI_HEAD_RE.exec(head))) { const s = linkedSkill(m[1]); if (s && isSkill?.(s)) skill = s; }
    if (skill) text = text.slice(arrow + 1).trim();
  }
  const linked = isSkill ? linkedSkills([first, ...rest].join("\n"), isSkill) : [];
  if (!skill && linked.length) skill = linked[0];
  const mentions = linked.filter((s) => s !== skill);
  return { n, ...(skill ? { skill } : {}), ...(route ? { route } : {}), ...(mentions.length ? { mentions } : {}), action: text, ...(actor ? { actor } : {}) };
}

/**
 * Parse the steps of a playbook body: the numbered items of the `## Steps` section, each with its
 * continuation lines up to the next item or heading. Without a Steps section, `### Phase N` /
 * `### Step N` headings are the steps; failing that, any numbered lines. `isSkill` tells which
 * linked names are served skills (links to other notes, such as playbooks, are not skills).
 */
export function parseSteps(body: string, isSkill?: (name: string) => boolean): PlaybookStep[] {
  const lines = body.split(/\r?\n/);
  let start = lines.findIndex((l) => /^##+\s+Steps\b/i.test(l));
  let end = lines.length;
  if (start >= 0) {
    end = lines.findIndex((l, i) => i > start && /^##?\s+\S/.test(l) && !/^###/.test(l));
    if (end < 0) end = lines.length;
    start += 1;
  } else {
    const phases = phaseSteps(lines, isSkill);
    if (phases.length) return phases;
    start = 0;
  }
  const blocks: { n: number; first: string; rest: string[] }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  let fence = false;
  let base: number | null = null;
  for (const line of lines.slice(start, end)) {
    if (FENCE_RE.test(line)) { fence = !fence; cur?.rest.push(line); continue; }
    if (!fence) {
      if (HEADING_RE.test(line)) { cur = null; continue; }
      const m = STEP_RE.exec(line);
      if (m && (base === null || m[1].length <= base)) {
        base ??= m[1].length;
        cur = { n: Number(m[2]), first: m[3], rest: [] };
        blocks.push(cur);
        continue;
      }
    }
    cur?.rest.push(line);
  }
  return blocks.map((b) => buildStep(b.n, b.first, trimTrailingBlank(b.rest), isSkill));
}

function trimTrailingBlank(rest: string[]): string[] {
  let n = rest.length;
  while (n > 0 && !rest[n - 1].trim()) n--;
  return rest.slice(0, n);
}

/** `### Phase N — Title` sections as steps, for playbooks written as phases without a Steps list. */
function phaseSteps(lines: string[], isSkill?: (name: string) => boolean): PlaybookStep[] {
  const out: PlaybookStep[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const h = PHASE_HEADING_RE.exec(lines[i]);
    if (!h) continue;
    const rest: string[] = [];
    let f = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (FENCE_RE.test(lines[j])) f = !f;
      if (!f && HEADING_RE.test(lines[j])) break;
      rest.push(lines[j]);
    }
    const step = buildStep(Number(h[2]), h[3] || `Phase ${h[2]}`, [], isSkill);
    const linked = isSkill ? linkedSkills(rest.join("\n"), isSkill) : [];
    const all = [...new Set([...(step.skill ? [step.skill] : []), ...(step.mentions ?? []), ...linked])];
    const actor = step.actor ?? laterActor(trimTrailingBlank(rest));
    out.push({ n: step.n, ...(all[0] ? { skill: all[0] } : {}), ...(step.route ? { route: step.route } : {}), ...(all.length > 1 ? { mentions: all.slice(1) } : {}), action: step.action, ...(actor ? { actor } : {}) });
  }
  return out;
}

const EMBED_RE = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;

async function statAttachment(dir: string, name: string, mimeFor: (f: string) => string, maxBytes: number): Promise<PlaybookAttachment | null> {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const abs = path.join(dir, name);
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > maxBytes) return null;
    return { rel: name, abs, size: st.size, mtimeMs: st.mtimeMs, mimeType: mimeFor(name) };
  } catch { return null; }
}

export interface PlaybookScanOpts {
  library: string;
  vaultRoot: string;
  /** Playbook folders to walk (see findPlaybookRoots). */
  roots: string[];
  excludeDirs: Set<string>;
  maxFileBytes: number;
  mimeFor: (f: string) => string;
  /** Serve every status, not only `active`. */
  showAll: boolean;
  /** Served skill names: which `[[links]]` in step text name skills. */
  skillNames?: Set<string>;
  prev?: Map<string, Playbook>;
}

async function walkMd(dir: string, depth: number, excludeDirs: Set<string>, out: { abs: string; misplaced: boolean }[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDED_SUBDIRS.has(e.name) || excludeDirs.has(e.name) || depth >= 4) continue;
      await walkMd(abs, depth + 1, excludeDirs, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md") && !NON_PLAYBOOK_FILES.has(e.name)) {
      out.push({ abs, misplaced: depth > 0 });
    }
  }
}

/** Discover and parse the playbooks of one vault. Never throws: problems become warnings. */
export async function scanPlaybooks(o: PlaybookScanOpts): Promise<{ playbooks: Playbook[]; hidden: Playbook[]; warnings: string[]; rootsFound: number }> {
  const found: { abs: string; misplaced: boolean }[] = [];
  let rootsFound = 0;
  for (const dir of o.roots) {
    rootsFound++;
    await walkMd(dir, 0, o.excludeDirs, found);
  }
  found.sort((a, b) => a.abs.localeCompare(b.abs));
  const playbooks: Playbook[] = [];
  const hidden: Playbook[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const names = o.skillNames ?? new Set<string>();
  const skillSetKey = createHash("sha1").update([...names].sort().join("\n")).digest("hex");
  const isSkill = (n: string) => names.has(n);
  for (const f of found) {
    let st;
    try { st = await fs.stat(f.abs); } catch { continue; }
    if (st.size > o.maxFileBytes) { warnings.push(`playbook ${path.basename(f.abs)}: ${st.size} bytes exceeds the per-file limit, skipped`); continue; }
    const name = path.basename(f.abs, path.extname(f.abs));
    const playbookPath = o.library ? `${o.library}/${name}` : name;
    const prev = o.prev?.get(playbookPath);
    let pb: Playbook;
    if (prev && prev.abs === f.abs && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.skillSetKey === skillSetKey) {
      pb = prev;
      // Attachments may have changed independently of the note.
      pb = { ...prev, attachments: await refreshAttachments(prev, o) };
    } else {
      const text = await fs.readFile(f.abs, "utf8");
      const { data, body } = splitFrontmatter(text);
      if (!data) continue; // not a note with frontmatter: not a playbook
      if (coerceString(data.type).toLowerCase() !== "playbook") continue;
      const steps = parseSteps(body, isSkill);
      const attachments: PlaybookAttachment[] = [];
      const embeds = new Set<string>();
      for (const m of body.matchAll(EMBED_RE)) embeds.add(m[1].trim());
      for (const name of embeds) {
        const a = await statAttachment(path.dirname(f.abs), name, o.mimeFor, o.maxFileBytes);
        if (a) attachments.push(a);
      }
      const totalSteps = Number(coerceString(data["total-steps"])) || steps.length;
      pb = {
        name,
        title: coerceString(data.title) || name,
        library: o.library,
        playbookPath,
        uri: playbookUri(playbookPath),
        abs: f.abs,
        vaultRel: path.relative(o.vaultRoot, f.abs).split(path.sep).join("/"),
        trigger: coerceString(data.trigger),
        outcome: coerceString(data.outcome),
        totalSteps,
        duration: coerceString(data["estimated-duration"] ?? data.duration),
        status: (coerceString(data.status) || "active").toLowerCase(),
        valueChain: coerceString(data["value-chain"]),
        chainCoverage: coerceList(data["chain-coverage"]),
        tags: coerceList(data.tags),
        maturity: coerceList(data.maturity),
        frontmatter: data,
        body,
        steps,
        skills: [...new Set(steps.flatMap((s) => [...(s.skill ? [s.skill] : []), ...(s.mentions ?? [])]))],
        attachments,
        size: st.size,
        mtimeMs: st.mtimeMs,
        misplaced: f.misplaced,
        skillSetKey,
      };
      if (!pb.steps.length) warnings.push(`playbook ${pb.vaultRel}: no numbered steps found`);
      const declared = Number(coerceString(data["total-steps"]));
      if (declared && pb.steps.length && declared !== pb.steps.length) warnings.push(`playbook ${pb.vaultRel}: frontmatter total-steps is ${declared} but ${pb.steps.length} steps were parsed`);
      if (!pb.trigger) warnings.push(`playbook ${pb.vaultRel}: frontmatter.trigger missing`);
      if (!pb.valueChain) warnings.push(`playbook ${pb.vaultRel}: frontmatter.value-chain missing`);
    }
    const dup = seen.get(playbookPath);
    if (dup) { warnings.push(`playbook ${pb.vaultRel}: duplicate name '${name}' (also ${dup}); later one skipped`); continue; }
    seen.set(playbookPath, pb.vaultRel);
    if (pb.misplaced) warnings.push(`playbook ${pb.vaultRel}: filed in a subdirectory of its playbook root`);
    (pb.status === "active" || o.showAll ? playbooks : hidden).push(pb);
  }
  return { playbooks, hidden, warnings, rootsFound };
}

async function refreshAttachments(prev: Playbook, o: PlaybookScanOpts): Promise<PlaybookAttachment[]> {
  const out: PlaybookAttachment[] = [];
  for (const a of prev.attachments) {
    const fresh = await statAttachment(path.dirname(prev.abs), a.rel, o.mimeFor, o.maxFileBytes);
    if (!fresh) continue;
    out.push(fresh.mtimeMs === a.mtimeMs && fresh.size === a.size ? a : fresh);
  }
  return out;
}

export async function digestOf(f: { abs: string; digest?: string }): Promise<string> {
  if (f.digest) return f.digest;
  const buf = await fs.readFile(f.abs);
  f.digest = "sha256:" + createHash("sha256").update(buf).digest("hex");
  return f.digest;
}

// ---- value chains --------------------------------------------------------------

const CHAIN_HEADING = /^(#{2,3})\s+([a-z][a-z0-9-]+)\s*$/;
/** `## Cross-Chain: Operating Controls`, `## Meta-Chain: Infrastructure`: unstaged groups. */
const BUCKET_HEADING = /^(#{2,3})\s+(?:Cross|Meta)-Chain:\s*(.+?)\s*$/i;
const VALID_IDS_HEADING = /^#{2,4}\s+Valid chain IDs\b/i;
/** A field line, bulleted (`- **Stages:** …`) or not (`**Stages:** …`). */
const field = (name: string) => new RegExp(`^(?:[-*+]\\s+)?\\*\\*${name}:\\*\\*\\s*(.+)$`);
const SME_LABEL = field("SME Label"), DESCRIPTION = field("Description"), STAGES = field("Stages");
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Parse chain definitions from either file shape:
 *   ### lead-to-cash            (canonical value-chains.md; fields bulleted or not)
 *   - **SME Label:** Win and get paid
 *   - **Description:** ...
 *   - **Stages:** prospect → qualify → ...
 * or
 *   ## lead-to-cash             (generated VALUE-CHAINS.md)
 *   **Win and get paid**
 *   The full revenue journey ...
 *   **Stages:** prospect → qualify → ...
 * The canonical file also defines unstaged groups, returned with `kind: "bucket"`:
 *   ## Cross-Chain: Operating Controls   → operating-controls (label, first paragraph as description)
 *   ## Meta-Chain: Infrastructure        → infrastructure
 *   ### Valid chain IDs                  → every listed id without a chain block is a bucket too
 */
export function parseChainDefinitions(text: string): ValueChainDef[] {
  const lines = text.split(/\r?\n/);
  const out: ValueChainDef[] = [];
  let cur: ValueChainDef | null = null;
  let curLevel = 0;
  let chainLevel = 0;
  let inTable = false;
  let inValidIds = false;
  let fence = false;
  const validIds: string[] = [];
  const flush = () => { if (cur && cur.id) out.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#/.test(line)) {
      const lvl = /^#+/.exec(line)![0].length;
      inValidIds = false;
      inTable = false;
      let m: RegExpExecArray | null;
      if (VALID_IDS_HEADING.test(line)) { flush(); inValidIds = true; continue; }
      if ((m = BUCKET_HEADING.exec(line))) {
        flush();
        cur = { id: slugOf(m[2]), label: m[2].trim(), description: "", stages: [], kind: "bucket" };
        curLevel = lvl;
        continue;
      }
      const h = CHAIN_HEADING.exec(line);
      if (h && (chainLevel === 0 || lvl === chainLevel)) {
        flush();
        chainLevel = curLevel = lvl;
        cur = { id: h[2], label: "", description: "", stages: [], kind: "chain" };
      } else if (cur && lvl <= curLevel) flush(); // a sibling or parent heading ends the block
      continue; // deeper headings inside a block carry no fields
    }
    if (inValidIds) { for (const m of line.matchAll(/`([a-z][a-z0-9-]*)`/g)) validIds.push(m[1]); continue; }
    if (!cur) continue;
    const c: ValueChainDef = cur;
    if (line.startsWith("|")) { inTable = true; continue; }
    if (inTable && line.trim() === "") { inTable = false; continue; }
    if (inTable) continue;
    let m: RegExpExecArray | null;
    if ((m = SME_LABEL.exec(line))) { c.label = m[1].trim(); continue; }
    if ((m = DESCRIPTION.exec(line))) { c.description = m[1].trim(); continue; }
    if ((m = STAGES.exec(line))) {
      if (c.kind === "chain") c.stages = m[1].split(/[→,>]/).map((s) => s.trim().replace(/^`|`$/g, "")).filter(Boolean);
      continue;
    }
    if ((m = /^\*\*([^*]+)\*\*\s*$/.exec(line)) && !c.label) { c.label = m[1].trim(); continue; }
    if (/^\*\*/.test(line) || /^_/.test(line) || /^[-*+] /.test(line) || /^\s*$/.test(line)) continue;
    if (!c.description) c.description = line.trim();
  }
  flush();
  const defs = out.filter((c) => c.kind === "bucket" || c.stages.length || c.label || c.description);
  const have = new Set(defs.map((d) => d.id));
  for (const id of validIds) if (!have.has(id)) { defs.push({ id, label: "", description: "", stages: [], kind: "bucket" }); have.add(id); }
  return defs;
}

export async function loadChainDefinitions(vaultRoot: string, files: string[]): Promise<{ defs: ValueChainDef[]; source: "definition" | "index" | null; warnings: string[] }> {
  const warnings: string[] = [];
  for (const abs of files) {
    let text: string;
    try { text = await fs.readFile(abs, "utf8"); } catch { continue; }
    const defs = parseChainDefinitions(text);
    const rel = path.relative(vaultRoot, abs).split(path.sep).join("/");
    if (!defs.length) { warnings.push(`value chains: ${rel} has no recognisable chain definitions`); continue; }
    // The canonical file uses `**SME Label:**` fields (bulleted or not); anything else is treated as a generated index.
    const canonical = /\*\*SME Label:\*\*/.test(text);
    return { defs, source: canonical ? "definition" : "index", warnings };
  }
  return { defs: [], source: null, warnings };
}

export interface ChainSkillRef { name: string; valueChains: string[]; stage: string }

/**
 * Join chain definitions with the skills and playbooks that declare them. Chains referenced by
 * frontmatter but absent from the definitions are added as `derived` chains, with their stages
 * inferred from the references, so a vault without a definition file still gets a usable map.
 * Buckets keep no stages: every member is listed without a stage and no gaps are computed.
 */
export function buildValueChains(
  library: string,
  defs: ValueChainDef[],
  source: "definition" | "index" | null,
  skills: ChainSkillRef[],
  playbooks: Playbook[],
): ValueChain[] {
  const chains = new Map<string, ValueChain>();
  const norm = (s: string) => s.trim().toLowerCase();
  const ensure = (id: string): ValueChain => {
    let c = chains.get(id);
    if (!c) {
      c = { id, label: "", description: "", stages: [], kind: "chain", library, uri: valueChainUri(library, id), source: "derived", skillsByStage: {}, playbooksByStage: {}, skillCount: 0, playbookCount: 0 };
      chains.set(id, c);
    }
    return c;
  };
  for (const d of defs) {
    const c = ensure(norm(d.id));
    c.label = d.label; c.description = d.description; c.stages = d.kind === "bucket" ? [] : [...d.stages]; c.kind = d.kind ?? "chain"; c.source = source ?? "derived";
  }
  const add = (map: Record<string, string[]>, stage: string, name: string) => {
    (map[stage] ??= []);
    if (!map[stage].includes(name)) map[stage].push(name);
  };
  for (const s of skills) {
    const stage = norm(s.stage);
    for (const raw of s.valueChains) {
      const c = ensure(norm(raw));
      if (stage && !c.stages.includes(stage)) { if (c.source === "derived") c.stages.push(stage); }
      add(c.skillsByStage, stage && c.stages.includes(stage) ? stage : "", s.name);
      c.skillCount++;
    }
  }
  for (const p of playbooks) {
    if (!p.valueChain) continue;
    const c = ensure(norm(p.valueChain));
    const stages = p.chainCoverage.map(norm).filter(Boolean);
    for (const st of stages) if (!c.stages.includes(st) && c.source === "derived") c.stages.push(st);
    const known = stages.filter((st) => c.stages.includes(st));
    if (known.length) for (const st of known) add(c.playbooksByStage, st, p.name);
    else add(c.playbooksByStage, "", p.name);
    c.playbookCount++;
  }
  for (const c of chains.values()) {
    for (const list of Object.values(c.skillsByStage)) list.sort();
    for (const list of Object.values(c.playbooksByStage)) list.sort();
  }
  const order = new Map(defs.map((d, i) => [norm(d.id), i]));
  return [...chains.values()].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
}

/** Markdown rendering of a chain: the stage table agents read when they fetch the resource. */
export function renderValueChain(c: ValueChain, P?: string): string {
  const bucket = c.kind === "bucket";
  const head = `# ${bucket ? "Value-chain bucket" : "Value chain"}: ${c.id}${c.label ? ` — ${c.label}` : ""}\n` +
    (c.description ? `\n${c.description}\n` : "") +
    `\nSource: ${c.source === "derived" ? "derived from skill and playbook frontmatter (no chain definition file in the vault)" : c.source === "definition" ? "vault chain definitions" : "vault chain index"}${c.library ? `, library ${c.library}` : ""}\n` +
    (bucket ? "\nStages: none — an unstaged group that serves every chain; no coverage gaps are computed.\n"
      : c.stages.length ? `\nStages: ${c.stages.join(" → ")}\n` : "\nStages: (none declared)\n");
  const rows = c.stages.map((st) => `| \`${st}\` | ${(c.skillsByStage[st] ?? []).join(", ") || "—"} | ${(c.playbooksByStage[st] ?? []).join(", ") || "—"} |`);
  const table = rows.length ? `\n| Stage | Skills | Playbooks |\n|---|---|---|\n${rows.join("\n")}\n` : "";
  const unstaged = (c.skillsByStage[""]?.length || c.playbooksByStage[""]?.length)
    ? `\n${bucket ? "Members" : "Without a stage"}: skills ${(c.skillsByStage[""] ?? []).join(", ") || "—"}; playbooks ${(c.playbooksByStage[""] ?? []).join(", ") || "—"}\n` : "";
  const gaps = c.stages.filter((st) => !(c.skillsByStage[st]?.length) && !(c.playbooksByStage[st]?.length));
  const gapText = gaps.length ? `\nCoverage gaps (no skill or playbook): ${gaps.join(", ")}\n` : "";
  const next = P ? `\nNext: ${P}_get_skill(name) for a skill, ${P}_get_playbook(name) for a playbook.\n` : "";
  return `${head}${table}${unstaged}${gapText}\n_Counts: ${c.skillCount} skills, ${c.playbookCount} playbooks_\n${next}`;
}
