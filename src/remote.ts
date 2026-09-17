/**
 * Remote archive libraries: fetch a `.zip` library over HTTPS, verify it, hand the local file to
 * the extractor in archive.ts.
 *
 * A zip pulled off the network is more hostile input than one already on disk — it arrives from
 * whatever answered the DNS query — so this module is deliberately narrow:
 *
 *  - HTTPS only, re-checked after every redirect (no downgrade to plaintext mid-chain)
 *  - the Authorization header is dropped the moment a redirect crosses to another host
 *  - the download is capped *while streaming*, so a huge body never lands on disk in the first place
 *  - the sha256 is verified before the archive is handed to the extractor, against a digest pinned
 *    in config where available, otherwise a `<url>.sha256` sidecar
 *
 * Downloads are cached by content digest, which is the same key the extractor uses, so a pinned
 * URL that has already been fetched costs no network at all.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";

export class RemoteError extends Error {}

export const DEFAULT_MAX_REDIRECTS = 5;

export interface FetchOptions {
  /** Cache root; downloads land in <cacheDir>/downloads/<sha256>.zip. */
  cacheDir: string;
  /** Hard ceiling on bytes read from the network. */
  maxBytes: number;
  /** Digest pinned in configuration. Strictly better than the sidecar: it does not travel the same wire. */
  expectedSha256?: string;
  /** Fall back to a `<url>.sha256` sidecar when no digest is pinned. */
  useSidecar?: boolean;
  /** Bearer token for private assets. Never sent across a cross-host redirect. */
  token?: string;
  timeoutMs: number;
  /**
   * Schemes permitted for the URL and every redirect hop. Production always uses the default;
   * the tests widen it to run a local plaintext server. Not reachable from config or CLI.
   */
  allowedProtocols?: string[];
  maxRedirects?: number;
}

export interface FetchResult {
  /** Local path of the verified archive. */
  file: string;
  digest: string;
  bytes: number;
  /** True when the download was served from cache without touching the network. */
  cached: boolean;
}

export function isUrlRoot(root: string): boolean {
  return /^https?:\/\//i.test(root);
}

/** Strip query and fragment so tokens in signed URLs never reach a log line. */
export function redact(u: URL | string): string {
  const url = typeof u === "string" ? new URL(u) : u;
  return `${url.origin}${url.pathname}`;
}

function checkProtocol(u: URL, allowed: string[]): void {
  if (!allowed.includes(u.protocol)) {
    throw new RemoteError(`refusing ${u.protocol}//${u.host} for a library archive; https is required`);
  }
}

/**
 * GET with manual redirect handling. Auth is only attached while the chain stays on the host the
 * request started from — a redirect elsewhere must not carry the caller's credentials.
 */
async function request(rawUrl: string, opts: FetchOptions, accept: string): Promise<Response> {
  const allowed = opts.allowedProtocols ?? ["https:"];
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = new URL(rawUrl);
  checkProtocol(current, allowed);
  const authHost = current.host;
  let sendAuth = !!opts.token;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const headers: Record<string, string> = { Accept: accept };
    if (sendAuth && current.host === authHost) headers.Authorization = `Bearer ${opts.token}`;

    const res = await fetch(current, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      const next = new URL(location, current);
      checkProtocol(next, allowed);
      // Crossing hosts (including to a different port or scheme) drops the credential for good.
      if (next.host !== authHost) sendAuth = false;
      current = next;
      continue;
    }
    if (!res.ok) throw new RemoteError(`GET ${redact(current)} returned ${res.status} ${res.statusText}`);
    return res;
  }
  throw new RemoteError(`GET ${redact(rawUrl)} exceeded ${maxRedirects} redirects`);
}

/** Read `<url>.sha256` and return the hex digest it names, or undefined when there is no sidecar. */
export async function fetchSidecarDigest(url: string, opts: FetchOptions): Promise<string | undefined> {
  try {
    const res = await request(url + ".sha256", opts, "text/plain");
    const text = (await res.text()).trim();
    const m = /\b([0-9a-f]{64})\b/i.exec(text);
    return m ? m[1].toLowerCase() : undefined;
  } catch {
    return undefined; // no sidecar published; the caller decides whether that is fatal
  }
}

/** Stream the body to `dest`, hashing as it goes and aborting the moment the cap is passed. */
async function streamTo(res: Response, dest: string, maxBytes: number, url: string): Promise<{ digest: string; bytes: number }> {
  if (!res.body) throw new RemoteError(`GET ${redact(url)} returned no body`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new RemoteError(`${redact(url)} declares ${declared} bytes, over the ${maxBytes} download limit`);
  }

  const h = createHash("sha256");
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  let bytes = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new RemoteError(`${redact(url)} exceeded the ${maxBytes} byte download limit`);
      }
      h.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return { digest: h.digest("hex"), bytes };
}

function downloadPath(cacheDir: string, digest: string): string {
  return path.join(cacheDir, "downloads", `${digest}.zip`);
}

/**
 * Fetch (or reuse) the archive at `url` and return a verified local file.
 *
 * With a pinned digest the cache is consulted before any request is made, so a pinned library that
 * has been fetched once never touches the network again.
 */
export async function fetchArchive(url: string, opts: FetchOptions): Promise<FetchResult> {
  const dir = path.join(opts.cacheDir, "downloads");
  await fsp.mkdir(dir, { recursive: true });

  const cachedAt = async (digest: string): Promise<FetchResult | null> => {
    const file = downloadPath(opts.cacheDir, digest);
    try {
      const st = await fsp.stat(file);
      return { file, digest, bytes: st.size, cached: true };
    } catch { return null; }
  };

  let expected = opts.expectedSha256?.toLowerCase();
  if (expected) {
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new RemoteError(`pinned sha256 for ${redact(url)} is not a 64-char hex digest`);
    const hit = await cachedAt(expected);
    if (hit) return hit;
  } else if (opts.useSidecar) {
    expected = await fetchSidecarDigest(url, opts);
    if (expected) {
      const hit = await cachedAt(expected);
      if (hit) return hit;
    }
  }

  const tmp = path.join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  let got: { digest: string; bytes: number };
  try {
    const res = await request(url, opts, "application/octet-stream");
    got = await streamTo(res, tmp, opts.maxBytes, url);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e instanceof RemoteError ? e : new RemoteError(`fetching ${redact(url)}: ${(e as Error).message}`);
  }

  if (expected && got.digest !== expected) {
    await fsp.rm(tmp, { force: true });
    throw new RemoteError(
      `sha256 mismatch for ${redact(url)}: expected ${expected}, got ${got.digest}. Refusing to serve it.`,
    );
  }

  const file = downloadPath(opts.cacheDir, got.digest);
  await fsp.rename(tmp, file).catch(async (e) => {
    await fsp.rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  });
  return { file, digest: got.digest, bytes: got.bytes, cached: false };
}

/** Drop cached downloads whose digest is no longer referenced, plus abandoned temp files. */
export async function pruneDownloads(cacheDir: string, keep: Set<string>): Promise<number> {
  const dir = path.join(cacheDir, "downloads");
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const digest = n.endsWith(".zip") ? n.slice(0, -4) : "";
    if (digest && keep.has(digest)) continue;
    if (!/^[0-9a-f]{64}\.zip$/.test(n) && !n.startsWith(".tmp-")) continue;
    await fsp.rm(path.join(dir, n), { force: true });
    removed++;
  }
  return removed;
}
