import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig, type Config } from "../../src/config.js";
import { Catalog } from "../../src/catalog.js";
import { createServer } from "../../src/server.js";

export const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const libA = path.join(FIX, "libA");
export const libB = path.join(FIX, "libB");
export const nested = path.join(FIX, "nested");

export function cfgFor(argv: string[]): Config {
  return loadConfig(argv);
}

export async function catalogFor(argv: string[]): Promise<{ cfg: Config; cat: Catalog }> {
  const cfg = cfgFor(argv);
  const cat = new Catalog(cfg);
  await cat.scan();
  return { cfg, cat };
}

export async function connected(argv: string[]): Promise<{ client: Client; cat: Catalog; cfg: Config; close: () => Promise<void> }> {
  const { cfg, cat } = await catalogFor(argv);
  const server = createServer(cfg, cat);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "unit", version: "0" });
  await client.connect(ct);
  return { client, cat, cfg, close: async () => { await client.close(); await server.close(); } };
}

/** Minimal stored-only zip of a directory tree, every entry name prefixed (e.g. "repo-1.0/") like a GitHub release asset. */
export async function zipDir(dir: string, prefix = ""): Promise<string> {
  const files: string[] = [];
  const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) await walk(a); else files.push(a); } };
  await walk(dir);
  files.sort();
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(prefix + path.relative(dir, f).split(path.sep).join("/"), "utf8");
    const data = await fs.readFile(f);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE((0o644 << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const localBuf = Buffer.concat(locals), cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "skills-vault-")), "pack.zip");
  await fs.writeFile(out, Buffer.concat([localBuf, cdBuf, eocd]));
  return out;
}
