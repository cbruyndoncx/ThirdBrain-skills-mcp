import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { connected, libA, libB } from "./helpers.js";

const ARGS = ["--lib", `a=${libA}`, "--lib", `b=${libB}`, "--name", "multi"];

test("initialize: extension capability, instructions mention libraries", async () => {
  const { client, close } = await connected(ARGS);
  try {
    assert.deepEqual(client.getServerCapabilities()!.extensions, { "io.modelcontextprotocol/skills": { directoryRead: true } });
    assert.match(client.getInstructions()!, /Libraries served.*a; b/);
    assert.match(client.getInstructions()!, /not installed locally/);
    assert.doesNotMatch(client.getInstructions()!, /as if the skill were installed/);
    assert.equal(client.getServerVersion()!.name, "multi");
  } finally { await close(); }
});
test("skills/list pages with cursor, entries carry frontmatter + digests; skills/get answers hidden", async () => {
  const { client, close } = await connected(ARGS);
  try {
    const p1 = await client.request({ method: "skills/list", params: {} }, z.any());
    assert.equal(p1.skills.length, 4);
    assert.equal(p1.nextCursor, undefined);
    const beta = p1.skills.find((s: any) => s.uri === "skill://b/beta/SKILL.md");
    assert.equal(beta.frontmatter.category, "ops");
    assert.equal(beta.resources.length, 3);
    for (const r of beta.resources) assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
    const hidden = await client.request({ method: "skills/get", params: { uri: "skill://b/hidden/SKILL.md" } }, z.any());
    assert.equal(hidden.frontmatter.name, "hidden");
    await assert.rejects(client.request({ method: "skills/get", params: { uri: "skill://b/nope/SKILL.md" } }, z.any()), /-32602/);
  } finally { await close(); }
});
test("resources: list/templates/read text+blob/directory", async () => {
  const { client, close } = await connected(ARGS);
  try {
    const list = await client.listResources();
    assert.equal(list.resources.length, 4);
    assert.equal(list.resources[0].mimeType, "text/markdown");
    assert.ok((list.resources[0] as any)._meta["io.modelcontextprotocol.skills/category"]);
    const t = await client.listResourceTemplates();
    assert.equal(t.resourceTemplates.length, 5);
    const txt = await client.readResource({ uri: "skill://b/beta/refs/notes.md" });
    assert.equal((txt.contents[0] as any).text, "notes here\n");
    const bin = await client.readResource({ uri: "skill://b/beta/refs/pic.png" });
    assert.equal(bin.contents[0].mimeType, "image/png");
    assert.ok((bin.contents[0] as any).blob.length > 0);
    const dir = await client.request({ method: "resources/directory/read", params: { uri: "skill://b/beta" } }, z.any());
    assert.deepEqual(dir.resources.map((r: any) => [r.name, r.mimeType]).sort(), [["SKILL.md", "text/markdown"], ["refs", "inode/directory"]]);
    await assert.rejects(client.readResource({ uri: "skill://b/beta/../hidden/SKILL.md" }), /-32602/);
  } finally { await close(); }
});
test("tools: prefix, outputSchema, structuredContent, library filter, ambiguity", async () => {
  const { client, close } = await connected(ARGS);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.every((t) => t.name.startsWith("multi_") && t.outputSchema));
    const s = await client.callTool({ name: "multi_search_skills", arguments: { query: "shared", library: "b" } });
    const sc = s.structuredContent as any;
    assert.deepEqual(sc.results.map((r: any) => r.path), ["b/shared"]);
    const bad = await client.callTool({ name: "multi_search_skills", arguments: { query: "x", library: "zzz" } });
    assert.equal(bad.isError, true);
    const amb = await client.callTool({ name: "multi_get_skill", arguments: { name: "shared" } });
    assert.equal(amb.isError, true);
    const ok = await client.callTool({ name: "multi_get_skill", arguments: { name: "b/shared" } });
    assert.equal((ok.structuredContent as any).library, "b");
    assert.match((ok.structuredContent as any).instructions, /Shared B/);
    assert.equal((ok.structuredContent as any).source, "multi");
    assert.equal((ok.structuredContent as any).rootOnDisk, undefined);
    assert.doesNotMatch((ok.content as any)[0].text, new RegExp(libB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no absolute paths in get_skill text");
    const libs = await client.callTool({ name: "multi_list_libraries", arguments: {} });
    assert.deepEqual((libs.structuredContent as any).libraries.map((l: any) => [l.namespace, l.kind, l.root]), [["a", "directory", undefined], ["b", "directory", undefined]]);
    assert.doesNotMatch(JSON.stringify(libs), /fixtures/, "no library path in list_libraries");
    const status = await client.callTool({ name: "multi_catalog_status", arguments: { include_warnings: true } });
    assert.equal((status.structuredContent as any).root, undefined);
    assert.doesNotMatch(JSON.stringify(status), /fixtures/, "no library path in catalog_status");
    const ls = await client.callTool({ name: "multi_list_skills", arguments: { limit: 3 } });
    const lsc = ls.structuredContent as any;
    assert.equal(lsc.skills.length, 3); assert.ok(lsc.nextCursor);
    const ls2 = await client.callTool({ name: "multi_list_skills", arguments: { limit: 3, cursor: lsc.nextCursor } });
    assert.equal((ls2.structuredContent as any).skills.length, 1);
    const f = await client.callTool({ name: "multi_read_skill_file", arguments: { name: "beta", path: "refs/pic.png" } });
    assert.ok((f.structuredContent as any).base64);
    assert.match((f.structuredContent as any).digest, /^sha256:/);
  } finally { await close(); }
});
test("prompt use-skill inlines the skill body", async () => {
  const { client, close } = await connected(ARGS);
  try {
    const p = await client.getPrompt({ name: "use-skill", arguments: { skill: "alpha", task: "t" } });
    assert.match((p.messages[0].content as any).text, /<skill name="alpha" source="multi">[\s\S]*Body A/);
    assert.match((p.messages[0].content as any).text, /Source: multi \(MCP-served skill/);
    assert.doesNotMatch((p.messages[0].content as any).text, /Bundled scripts/, "no script guidance without scripts");
  } finally { await close(); }
});
test("library info from the config file is shown instead of the path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cfg-"));
  const cfgPath = path.join(tmp, "skills.json");
  await fs.writeFile(cfgPath, JSON.stringify({ libraries: [
    { namespace: "a", root: libA, title: "Library A", source: "vault-a", version: "2026.09", metadata: { channel: "stable" } },
    { namespace: "b", root: libB },
  ] }));
  const { client, close } = await connected(["--config", cfgPath, "--name", "multi"]);
  try {
    assert.match(client.getInstructions()!, /a \(Library A, from vault-a, v2026\.09, channel=stable\); b\./);
    const libs = await client.callTool({ name: "multi_list_libraries", arguments: {} });
    const [a, b] = (libs.structuredContent as any).libraries;
    assert.deepEqual(a.info, { title: "Library A", source: "vault-a", version: "2026.09", metadata: { channel: "stable" } });
    assert.equal(b.info, undefined);
    assert.match((libs.content as any)[0].text, /- a: 2 skills \(0 hidden\)  Library A, from vault-a, v2026\.09, channel=stable/);
    assert.doesNotMatch(JSON.stringify(libs) + client.getInstructions(), /fixtures/, "no library path anywhere");
  } finally { await close(); }
});
