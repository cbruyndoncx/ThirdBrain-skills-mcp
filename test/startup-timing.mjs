import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t0 = Date.now();
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js", "--config", "/home/cb/TOOLBOX/MCP/skills.json"], stderr: "ignore" }));
console.log("initialize answered after", Date.now() - t0, "ms");
const l = await c.callTool({ name: "skills_list_libraries", arguments: {} });
console.log("first tool call answered after", Date.now() - t0, "ms →", l.structuredContent.libraries.map(x => `${x.namespace}:${x.skills}`).join(" "));
await c.close();
