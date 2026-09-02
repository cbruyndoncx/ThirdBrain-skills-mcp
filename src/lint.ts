/**
 * Scan-time linter for served skill files. It does not block anything; it labels.
 * Findings surface in catalog warnings, in `_meta["io.modelcontextprotocol.skills/risk-flags"]`,
 * and in tool output so a host can apply policy before following a skill or running a script.
 */
import fs from "node:fs/promises";
import type { SkillFile } from "./catalog.js";
import { isTextMime } from "./catalog.js";

export interface LintFinding { rule: string; file: string; line: number; excerpt: string }

interface Rule { id: string; re: RegExp; files?: RegExp }

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i;

export const RULES: Rule[] = [
  { id: "pipe-to-shell", re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i },
  { id: "remote-exec", re: /\b(Invoke-Expression|iex)\s*\(?\s*\(?\s*(New-Object\s+Net\.WebClient|iwr|Invoke-WebRequest|curl)/i },
  { id: "eval-decode", re: /\b(eval|exec)\s*\(\s*(base64|b64decode|atob|codecs\.decode|Buffer\.from)/i },
  { id: "base64-blob", re: /[A-Za-z0-9+/]{200,}={0,2}/, files: SCRIPT_EXT },
  { id: "destructive-rm", re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME|"\$HOME"|\/\*)(\s|$)/ },
  { id: "world-writable", re: /\bchmod\s+(-R\s+)?[0-7]?777\b/ },
  { id: "sensitive-path", re: /(~|\$HOME|\/home\/[^/\s]+|\/root)\/\.(ssh|aws|gnupg|kube|docker|npmrc|netrc)\b|\/etc\/(passwd|shadow)\b/ },
  { id: "credential-literal", re: /\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|sk-[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/ },
  { id: "env-exfil", re: /\b(printenv|env)\b[^\n]*\|\s*(curl|wget|nc)\b|\bcurl\b[^\n]*(-d|--data)[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i },
  { id: "prompt-injection", re: /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+instructions\b|\bdo not (tell|inform|reveal to) the user\b|\bwithout (asking|telling) the user\b/i, files: /\.md$/i },
  { id: "reverse-shell", re: /\b(nc|ncat|netcat)\s+(-e|-c)\s|\/dev\/tcp\/\d/ },
];

const MAX_LINT_BYTES = 512 * 1024;

export async function lintFiles(files: SkillFile[]): Promise<LintFinding[]> {
  const out: LintFinding[] = [];
  for (const f of files) {
    if (!isTextMime(f.mimeType) && !SCRIPT_EXT.test(f.rel)) continue;
    if (f.size > MAX_LINT_BYTES) continue;
    let text: string;
    try { text = await fs.readFile(f.abs, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      if (rule.files && !rule.files.test(f.rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const m = rule.re.exec(lines[i]);
        if (!m) continue;
        // Skip the linter's own rule table and obvious documentation of the pattern.
        if (/^\s*(#|\/\/|-|\*)\s*(never|do not|don't|avoid|warning|note)/i.test(lines[i]) && rule.id !== "prompt-injection") continue;
        out.push({ rule: rule.id, file: f.rel, line: i + 1, excerpt: lines[i].trim().slice(0, 120) });
        break; // one finding per rule per file is enough to flag it
      }
    }
  }
  return out;
}

export const SCRIPT_EXTENSIONS = SCRIPT_EXT;
