import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")]) {
      try { return JSON.parse(readFileSync(candidate, "utf8")).version ?? "0.0.0"; } catch { /* try next */ }
    }
  } catch { /* fall through */ }
  return "0.0.0";
}

export const PKG_VERSION: string = readVersion();
