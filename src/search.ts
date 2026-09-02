import type { Skill } from "./catalog.js";

const STOP = new Set("a an and are as at be by for from has how in is it of on or that the this to use used user when with your you".split(" "));

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export interface SearchHit { skill: Skill; score: number; why: string[] }

export interface SearchOpts {
  category?: string;
  valueChain?: string;
  limit?: number;
}

/**
 * Lightweight ranked search over name, description, category, tags and (lightly) body.
 * Good enough for ~400 skills without an index; rebuilds nothing.
 */
export function searchSkills(skills: Skill[], query: string, opts: SearchOpts = {}): SearchHit[] {
  const q = query.trim().toLowerCase();
  const terms = [...new Set(tokenize(q))];
  const hits: SearchHit[] = [];
  for (const s of skills) {
    if (opts.category && s.category.toLowerCase() !== opts.category.toLowerCase()) continue;
    if (opts.valueChain && !s.valueChains.some((v) => v.toLowerCase() === opts.valueChain!.toLowerCase())) continue;
    let score = 0;
    const why: string[] = [];
    const name = s.name.toLowerCase();
    const desc = s.description.toLowerCase();
    if (q && name === q) { score += 100; why.push("exact name"); }
    else if (q && name.includes(q)) { score += 40; why.push("name contains query"); }
    if (q && q.length > 3 && desc.includes(q)) { score += 30; why.push("phrase in description"); }
    const nameToks = new Set(tokenize(s.name));
    const descToks = new Set(tokenize(s.description));
    const tagToks = new Set(s.tags.flatMap(tokenize).concat(tokenize(s.category)));
    let bodyToks: Set<string> | null = null;
    for (const t of terms) {
      if (nameToks.has(t)) { score += 12; why.push(`name:${t}`); }
      if (descToks.has(t)) { score += 6; why.push(`desc:${t}`); }
      if (tagToks.has(t)) { score += 5; why.push(`tag:${t}`); }
      if (!nameToks.has(t) && !descToks.has(t)) {
        bodyToks ??= new Set(tokenize(s.body.slice(0, 6000)));
        if (bodyToks.has(t)) { score += 1; why.push(`body:${t}`); }
      }
    }
    if (terms.length === 0 && (opts.category || opts.valueChain)) score = 1; // pure filter
    if (score > 0) hits.push({ skill: s, score, why: [...new Set(why)] });
  }
  hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return hits.slice(0, opts.limit ?? 15);
}
