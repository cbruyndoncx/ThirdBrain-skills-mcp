/**
 * Security tests for remote (URL) archive libraries.
 *
 * These run against local plaintext servers, so every test widens `allowedProtocols` explicitly.
 * Production never does: the default is https-only and nothing in config or the CLI can change it,
 * which is itself one of the cases asserted below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fetchArchive, fetchSidecarDigest, pruneDownloads, isUrlRoot, redact,
  RemoteError, type FetchOptions,
} from "../../src/remote.js";

const PLAINTEXT = ["https:", "http:"];

interface Srv { url: string; close: () => Promise<void>; hits: () => number; auth: () => (string | undefined)[] }

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Srv> {
  let hits = 0;
  const auth: (string | undefined)[] = [];
  const s = http.createServer((req, res) => { hits++; auth.push(req.headers.authorization); handler(req, res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
    hits: () => hits,
    auth: () => auth,
  };
}

const BODY = Buffer.from("PK\x03\x04 pretend this is a zip; remote.ts never parses it");
const DIGEST = createHash("sha256").update(BODY).digest("hex");

async function tmpCache(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "skills-remote-"));
}

function opts(cacheDir: string, extra: Partial<FetchOptions> = {}): FetchOptions {
  return { cacheDir, maxBytes: 1024 * 1024, timeoutMs: 5000, allowedProtocols: PLAINTEXT, ...extra };
}

/** Serves BODY at /lib.zip and its digest at /lib.zip.sha256. */
function zipHandler(body: Buffer = BODY) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/lib.zip.sha256") {
      const d = createHash("sha256").update(body).digest("hex");
      res.writeHead(200, { "content-type": "text/plain" }).end(`${d}  lib.zip\n`);
    } else if (req.url === "/lib.zip") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) }).end(body);
    } else {
      res.writeHead(404).end();
    }
  };
}

// ---------------------------------------------------------------- scheme

test("plaintext http is refused by default", async () => {
  const cache = await tmpCache();
  await assert.rejects(
    () => fetchArchive("http://example.invalid/lib.zip", { cacheDir: cache, maxBytes: 1024, timeoutMs: 1000 }),
    (e: Error) => { assert.ok(e instanceof RemoteError); assert.match(e.message, /https is required/); return true; },
  );
  await fsp.rm(cache, { recursive: true, force: true });
});

test("the scheme allowlist is re-applied to every redirect target", async () => {
  // In production the allowlist is ["https:"], so this is the https -> http downgrade case.
  // Here the allowlist is inverted (http only) so the hop can be driven by a plain local server:
  // what is under test is that a redirect target's scheme is checked at all, not just the first URL.
  const cache = await tmpCache();
  const s = await serve((req, res) => {
    if (req.url === "/lib.zip") { res.writeHead(302, { location: "https://127.0.0.1:1/evil.zip" }).end(); return; }
    res.writeHead(404).end();
  });
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { allowedProtocols: ["http:"] })),
    (e: Error) => { assert.ok(e instanceof RemoteError); assert.match(e.message, /refusing https:/); return true; },
  );
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

// ---------------------------------------------------------------- credentials

test("the auth token is not forwarded across a cross-host redirect", async () => {
  const cache = await tmpCache();
  const dest = await serve(zipHandler());
  const origin = await serve((req, res) => {
    if (req.url === "/lib.zip") { res.writeHead(302, { location: `${dest.url}/lib.zip` }).end(); return; }
    res.writeHead(404).end();
  });

  const r = await fetchArchive(`${origin.url}/lib.zip`, opts(cache, { token: "secret-token", useSidecar: false }));
  assert.equal(r.digest, DIGEST);
  assert.ok(origin.auth().some((a) => a === "Bearer secret-token"), "origin host should receive the token");
  assert.ok(dest.auth().every((a) => a === undefined), "redirect target must NOT receive the token");

  await origin.close(); await dest.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("the auth token is kept across a same-host redirect", async () => {
  const cache = await tmpCache();
  const s = await serve((req, res) => {
    if (req.url === "/start.zip") { res.writeHead(302, { location: "/lib.zip" }).end(); return; }
    zipHandler()(req, res);
  });
  const r = await fetchArchive(`${s.url}/start.zip`, opts(cache, { token: "tok", useSidecar: false }));
  assert.equal(r.digest, DIGEST);
  assert.ok(s.auth().filter((a) => a === "Bearer tok").length >= 2, "same-host hops keep the token");
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

// ---------------------------------------------------------------- integrity

test("a digest mismatch is refused and nothing is left on disk", async () => {
  const cache = await tmpCache();
  const s = await serve(zipHandler());
  const wrong = "0".repeat(64);
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { expectedSha256: wrong })),
    (e: Error) => { assert.ok(e instanceof RemoteError); assert.match(e.message, /sha256 mismatch/); return true; },
  );
  const left = await fsp.readdir(path.join(cache, "downloads"));
  assert.deepEqual(left, [], "a failed verification must not leave the download behind");
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("a tampered body is caught by the sidecar digest", async () => {
  const cache = await tmpCache();
  // Sidecar advertises the digest of BODY, but the server serves something else.
  const s = await serve((req, res) => {
    if (req.url === "/lib.zip.sha256") { res.writeHead(200).end(`${DIGEST}  lib.zip\n`); return; }
    if (req.url === "/lib.zip") { res.writeHead(200).end(Buffer.from("tampered payload")); return; }
    res.writeHead(404).end();
  });
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { useSidecar: true })),
    (e: Error) => { assert.match(e.message, /sha256 mismatch/); return true; },
  );
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("a pinned digest beats the sidecar and is not overridden by it", async () => {
  const cache = await tmpCache();
  const s = await serve((req, res) => {
    // A hostile sidecar claiming the digest of the tampered body.
    if (req.url === "/lib.zip.sha256") {
      res.writeHead(200).end(`${createHash("sha256").update("tampered").digest("hex")}  lib.zip\n`);
      return;
    }
    if (req.url === "/lib.zip") { res.writeHead(200).end(Buffer.from("tampered")); return; }
    res.writeHead(404).end();
  });
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { expectedSha256: DIGEST, useSidecar: true })),
    (e: Error) => { assert.match(e.message, /sha256 mismatch/); return true; },
  );
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("a malformed pinned digest is rejected before any request", async () => {
  const cache = await tmpCache();
  await assert.rejects(
    () => fetchArchive("https://example.invalid/lib.zip", { cacheDir: cache, maxBytes: 1024, timeoutMs: 1000, expectedSha256: "nope" }),
    (e: Error) => { assert.match(e.message, /not a 64-char hex digest/); return true; },
  );
  await fsp.rm(cache, { recursive: true, force: true });
});

// ---------------------------------------------------------------- size

test("an oversize download is refused via content-length, before streaming", async () => {
  const cache = await tmpCache();
  const big = Buffer.alloc(200_000, 1);
  const s = await serve(zipHandler(big));
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { maxBytes: 1000, useSidecar: false })),
    (e: Error) => { assert.match(e.message, /declares \d+ bytes, over the/); return true; },
  );
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("an oversize download is refused mid-stream when content-length is absent or lies", async () => {
  const cache = await tmpCache();
  const s = await serve((req, res) => {
    if (req.url !== "/lib.zip") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }); // chunked, no length
    for (let i = 0; i < 40; i++) res.write(Buffer.alloc(10_000, 7));
    res.end();
  });
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { maxBytes: 50_000, useSidecar: false })),
    (e: Error) => { assert.match(e.message, /exceeded the \d+ byte download limit/); return true; },
  );
  const left = await fsp.readdir(path.join(cache, "downloads"));
  assert.deepEqual(left, [], "aborted download must not be left behind");
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("a redirect loop is bounded", async () => {
  const cache = await tmpCache();
  const s = await serve((req, res) => { res.writeHead(302, { location: "/lib.zip" }).end(); });
  await assert.rejects(
    () => fetchArchive(`${s.url}/lib.zip`, opts(cache, { maxRedirects: 3 })),
    (e: Error) => { assert.match(e.message, /exceeded 3 redirects/); return true; },
  );
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

// ---------------------------------------------------------------- caching

test("a pinned digest already in cache costs no network at all", async () => {
  const cache = await tmpCache();
  const s = await serve(zipHandler());

  const first = await fetchArchive(`${s.url}/lib.zip`, opts(cache, { useSidecar: true }));
  assert.equal(first.cached, false);
  assert.equal(first.digest, DIGEST);
  const afterFirst = s.hits();

  const second = await fetchArchive(`${s.url}/lib.zip`, opts(cache, { expectedSha256: DIGEST }));
  assert.equal(second.cached, true);
  assert.equal(second.file, first.file);
  assert.equal(s.hits(), afterFirst, "a pinned, cached digest must not touch the network");

  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});

test("pruneDownloads keeps referenced digests and drops the rest", async () => {
  const cache = await tmpCache();
  const dir = path.join(cache, "downloads");
  await fsp.mkdir(dir, { recursive: true });
  const keep = "a".repeat(64), drop = "b".repeat(64);
  await fsp.writeFile(path.join(dir, `${keep}.zip`), "x");
  await fsp.writeFile(path.join(dir, `${drop}.zip`), "x");
  await fsp.writeFile(path.join(dir, ".tmp-abandoned"), "x");
  await fsp.writeFile(path.join(dir, "unrelated.txt"), "x");

  const removed = await pruneDownloads(cache, new Set([keep]));
  assert.equal(removed, 2);
  const left = (await fsp.readdir(dir)).sort();
  assert.deepEqual(left, [`${keep}.zip`, "unrelated.txt"]);
  await fsp.rm(cache, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

test("isUrlRoot and redact", () => {
  assert.ok(isUrlRoot("https://example.com/a.zip"));
  assert.ok(isUrlRoot("http://example.com/a.zip"));
  assert.ok(!isUrlRoot("/srv/libs/a.zip"));
  assert.ok(!isUrlRoot("./a.zip"));
  // Signed-URL credentials must never reach a log line.
  assert.equal(redact("https://example.com/a.zip?token=secret#frag"), "https://example.com/a.zip");
});

test("a missing sidecar is not fatal on its own", async () => {
  const cache = await tmpCache();
  const s = await serve((req, res) => {
    if (req.url === "/lib.zip") { res.writeHead(200).end(BODY); return; }
    res.writeHead(404).end(); // no sidecar published
  });
  assert.equal(await fetchSidecarDigest(`${s.url}/lib.zip`, opts(cache)), undefined);
  const r = await fetchArchive(`${s.url}/lib.zip`, opts(cache, { useSidecar: true }));
  assert.equal(r.digest, DIGEST);
  await s.close();
  await fsp.rm(cache, { recursive: true, force: true });
});
