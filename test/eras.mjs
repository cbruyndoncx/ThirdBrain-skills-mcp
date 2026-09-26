// Stdio serves both protocol eras from one binary: a 2025 client (initialize handshake, what Claude Code
// uses today) and a 2026-07-28 client (server/discover, per-request envelope). Checks the era-specific
// behaviour of the SEP-2640 methods on each. Usage: npm run build && node test/eras.mjs
import assert from "node:assert/strict";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";

const EXT = "io.modelcontextprotocol/skills";
const args = ["dist/index.js", "--root", "test/fixtures/libB", "--name", "eras"];

async function connect(versionNegotiation) {
  const c = new Client({ name: "eras", version: "0" }, versionNegotiation ? { versionNegotiation } : {});
  await c.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" }));
  return c;
}

for (const [label, negotiation, era] of [
  ["2025 handshake (default client)", undefined, "legacy"],
  ["2026-07-28 pinned", { mode: { pin: "2026-07-28" } }, "modern"],
  ["auto negotiation", { mode: "auto" }, "modern"],
]) {
  const c = await connect(negotiation);
  try {
    if (negotiation) assert.equal(c.getProtocolEra(), era, `${label}: negotiated era`);
    assert.ok(c.getServerCapabilities()?.extensions?.[EXT], `${label}: skills extension declared`);

    const list = await c.request({ method: "skills/list", params: {} }, z.any());
    assert.ok(list.skills.length >= 2, `${label}: skills listed`);
    const get = await c.request({ method: "skills/get", params: { uri: list.skills[0].uri } }, z.any());
    assert.equal(get.skill?.uri, list.skills[0].uri, `${label}: skills/get wraps the entry as {skill}`);
    const read = await c.readResource({ uri: list.skills[0].uri });
    assert.match(read.contents[0].text, /^---/, `${label}: SKILL.md readable`);

    if (era === "modern") {
      for (const [m, r] of [["skills/list", list], ["skills/get", get]]) {
        assert.equal(typeof r.ttlMs, "number", `${label}: ${m} carries ttlMs`);
        assert.equal(r.cacheScope, "private", `${label}: ${m} carries cacheScope`);
      }
    } else {
      assert.equal(list.ttlMs, undefined, `${label}: no cache fields on 2025-era skills/list`);
      assert.equal(get.ttlMs, undefined, `${label}: no cache fields on 2025-era skills/get`);
    }
    const tools = await c.listTools();
    assert.ok(tools.tools.some((t) => t.name === "eras_search_skills"), `${label}: discovery tools listed`);
    console.log(`✓ ${label}`);
  } finally {
    await c.close();
  }
}
console.log("ERAS OK");
