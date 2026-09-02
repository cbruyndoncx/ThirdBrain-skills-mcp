import { parse as parseYaml } from "yaml";

export interface Frontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a SKILL.md into (frontmatter, body). Tolerates malformed YAML by returning nulls. */
export function splitFrontmatter(text: string): { data: Record<string, unknown> | null; body: string; raw: string } {
  const m = FM_RE.exec(text);
  if (!m) return { data: null, body: text, raw: "" };
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

export function coerceString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(coerceString).filter(Boolean).join(", ");
  return String(v);
}

export function coerceList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(coerceString).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [coerceString(v)];
}
