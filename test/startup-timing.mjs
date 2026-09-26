import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import fs from "node:fs";

// Usage: node test/startup-timing.mjs [SERVER ARGS...]   (run `npm run build` first)
// With no arguments the server is started with `--config $SKILLS_CONFIG` when that is set, else
// with `--lib bob=$BOB_VAULT`. When neither is set, or the path is missing, it prints SKIP and
// exits 0 — timing is only meaningful against a real library; the unit tests use fixtures.
let args = process.argv.slice(2);
if (!args.length) {
  const { SKILLS_CONFIG, BOB_VAULT } = process.env;
  const target = SKILLS_CONFIG || BOB_VAULT;
  if (!target || !fs.existsSync(target)) {
    console.log(`SKIP: ${target ? `${target} not found` : "no server arguments and neither $SKILLS_CONFIG nor $BOB_VAULT is set"}`);
    process.exit(0);
  }
  args = SKILLS_CONFIG ? ["--config", SKILLS_CONFIG] : ["--lib", `bob=${BOB_VAULT}`];
}

const t0 = Date.now();
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js", ...args], stderr: "ignore" }));
console.log("initialize answered after", Date.now() - t0, "ms");
// The tool prefix follows --name / --prefix, or the namespace when one library is served.
const { tools } = await c.listTools();
const listLibraries = tools.find((t) => t.name.endsWith("_list_libraries"))?.name;
if (!listLibraries) throw new Error("server exposes no *_list_libraries tool");
const l = await c.callTool({ name: listLibraries, arguments: {} });
console.log("first tool call answered after", Date.now() - t0, "ms →", l.structuredContent.libraries.map(x => `${x.namespace}:${x.skills}`).join(" "));
await c.close();
