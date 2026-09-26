import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Usage: tsx test/smoke.ts [ROOT] [NAME] [SEARCH_QUERY] [EXPECTED_TOP_HIT] [SKILL_WITH_FILES] [FILE_IN_THAT_SKILL]
// ROOT omitted, "" or "-": <vault>/00-CORE/Agents/skills, where <vault> is $GBL_VAULT when NAME is
// "gbl" and $BOB_VAULT otherwise. When that variable is unset or the folder is missing, the smoke
// test prints SKIP and exits 0 (it needs a real skills library; the unit tests use fixtures).
const [ROOT_ARG = "", NAME = "bob", QUERY = "A/B test sample size", TOP = "ab-test-setup",
  SKILL = "browser-use-cli", FILE = "references/troubleshooting.md"] = process.argv.slice(2);
const VAULT_ENV = NAME === "gbl" ? "GBL_VAULT" : "BOB_VAULT";
const ROOT = ROOT_ARG && ROOT_ARG !== "-" ? ROOT_ARG : process.env[VAULT_ENV] ? path.join(process.env[VAULT_ENV]!, "00-CORE", "Agents", "skills") : "";
if (!ROOT || !fs.existsSync(ROOT)) {
  console.log(`SKIP: ${ROOT ? `${ROOT} not found` : `no ROOT argument and $${VAULT_ENV} is not set`}`);
  process.exit(0);
}
const P = NAME.replace(/-/g, "_");
const tool = (n: string) => `${P}_${n}`;

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts", "--root", ROOT, "--name", NAME], stderr: "pipe" }));

const caps = client.getServerCapabilities()!;
assert.ok(caps.extensions?.["io.modelcontextprotocol/skills"], "skills extension declared");
console.log("✓ extension capability", JSON.stringify(caps.extensions));
console.log("✓ instructions present:", !!client.getInstructions());

const list = await client.request({ method: "skills/list", params: {} }, z.any());
assert.ok(list.skills.length > 0);
const first = list.skills[0];
assert.match(first.uri, /^skill:\/\/.+\/SKILL\.md$/);
assert.equal(typeof first.frontmatter.name, "string");
assert.match(first.resources[0].digest, /^sha256:[0-9a-f]{64}$/);
let total = list.skills.length, cursor = list.nextCursor;
while (cursor) { const p = await client.request({ method: "skills/list", params: { cursor } }, z.any()); total += p.skills.length; cursor = p.nextCursor; }
console.log(`✓ skills/list paginated total=${total}, first=${first.frontmatter.name}`);

const got = await client.request({ method: "skills/get", params: { uri: first.uri } }, z.any());
assert.equal(got.skill.uri, first.uri, "skills/get wraps the entry as {skill}");
console.log("✓ skills/get");

const res = await client.listResources();
assert.ok(res.resources.length > 0 && res.resources[0].mimeType === "text/markdown");
console.log(`✓ resources/list total=${res.resources.length} (the v2 client aggregates pages)`);

const rd = await client.readResource({ uri: first.uri });
assert.ok("text" in rd.contents[0] && (rd.contents[0] as any).text.startsWith("---"));
console.log("✓ resources/read SKILL.md");

// verify a digest
const { createHash } = await import("node:crypto");
const h = "sha256:" + createHash("sha256").update((rd.contents[0] as any).text).digest("hex");
assert.equal(h, first.resources[0].digest, "digest matches content");
console.log("✓ digest verified");

const dir = await client.request({ method: "resources/directory/read", params: { uri: first.uri.replace(/\/SKILL\.md$/, "") } }, z.any());
assert.ok(dir.resources.some((r: any) => r.name === "SKILL.md"));
console.log(`✓ resources/directory/read entries=${dir.resources.length}`);

const tools = await client.listTools();
console.log("✓ tools:", tools.tools.map((t) => t.name).join(", "));
assert.ok(tools.tools.every((t) => t.name.startsWith(P + "_")), "tool prefix applied");
assert.equal(client.getServerVersion()?.name, NAME);

const s = await client.callTool({ name: tool("search_skills"), arguments: { query: QUERY } });
const hits = (s.structuredContent as any).results;
assert.ok(Array.isArray(hits), "structuredContent.results present");
assert.equal(hits[0].name, TOP);
console.log("✓ search top hit:", hits[0].name, hits[0].score);

const g = await client.callTool({ name: tool("get_skill"), arguments: { name: SKILL } });
const gt = (g.content as any)[0].text as string;
assert.ok(gt.includes(`# Skill: ${SKILL}`) && gt.includes(FILE));
console.log("✓ get_skill length", gt.length);

const f = await client.callTool({ name: tool("read_skill_file"), arguments: { name: SKILL, path: FILE } });
assert.ok(((f.content as any)[0].text as string).length > 20);
console.log("✓ read_skill_file");

const bad = await client.callTool({ name: tool("get_skill"), arguments: { name: "does-not-exist" } });
assert.equal(bad.isError, true);
console.log("✓ unknown skill → isError");

const cats = await client.callTool({ name: tool("list_categories"), arguments: {} });
console.log("✓ categories:", Object.keys((cats.structuredContent as any).categories).length);
const libs = await client.callTool({ name: tool("list_libraries"), arguments: {} });
assert.equal((libs.structuredContent as any).libraries.length, 1);
console.log("✓ list_libraries");

const p = await client.getPrompt({ name: "use-skill", arguments: { skill: TOP, task: "demo task" } });
assert.ok((p.messages[0].content as any).text.includes(`<skill name="${TOP}" source="${NAME}">`));
console.log("✓ prompt use-skill");

const st = await client.callTool({ name: tool("catalog_status"), arguments: { include_warnings: true } });
const stats = st.structuredContent as any;
console.log(`✓ status skills=${stats.skills} hidden=${stats.hidden} files=${stats.files} MiB=${(stats.bytes/1048576).toFixed(1)} scanMs=${stats.scanMs} warnings=${stats.warnings.length}`);
for (const w of stats.warnings.slice(0, 15)) console.log("   warn:", w);

await client.close();
console.log("ALL OK");
