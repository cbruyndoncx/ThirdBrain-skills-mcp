import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
