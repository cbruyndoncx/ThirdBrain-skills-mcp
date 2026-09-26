#!/usr/bin/env node
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, reloadConfigFile } from "./config.js";
import { Catalog } from "./catalog.js";
import { createServer } from "./server.js";
import { parsePullArgs, pull } from "./pull.js";
import { parsePackArgs, pack } from "./pack.js";

let tag = "skills-mcp";
const log = (...a: unknown[]) => process.stderr.write(`[${tag}] ${a.join(" ")}\n`);

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "pull") {
    const o = parsePullArgs(argv.slice(1));
    const r = await pull(o);
    if (!o.list) log(`done: ${r.skills.length} skill(s), ${r.written} file(s) written, ${r.skipped} skipped${o.dryRun ? " (dry run)" : ""}`);
    return;
  }
  if (argv[0] === "pack") { await pack(parsePackArgs(argv.slice(1))); return; }
  const cfg = loadConfig(argv[0] === "serve" ? argv.slice(1) : argv);
  tag = cfg.serverName;
  // Libraries given on the CLI/env are fixed; those from --config are re-read on every rescan and on SIGHUP.
  const fileLibs = new Set((cfg.configFile ? (await import("./config.js")).readConfigFile(cfg.configFile).libraries : []).map((l) => l.namespace));
  const cliLibs = cfg.libraries.filter((l) => !fileLibs.has(l.namespace));
  const reload = async (why: string) => {
    try {
      if (reloadConfigFile(cfg, cliLibs)) log(`config reloaded (${why}): libraries=${cfg.libraries.map((l) => l.namespace || "(root)").join(",")} noScripts=${cfg.noScripts} lint=${cfg.lint}`);
    } catch (e) { log(`config reload failed (${why}), keeping previous libraries: ${(e as Error).message}`); }
    await cat.scan();
  };
  const cat = new Catalog(cfg);
  const t0 = Date.now();
  // Start scanning now but do not block the transport: initialize answers immediately and
  // the first request waits for the catalog (large libraries on slow disks take 10-30 s).
  const initial = cat.scan();
  initial.then(() => { const st = cat.getStats(); log(`libraries=${cfg.libraries.map((l) => `${l.namespace || "(root)"}:${l.root}${l.noScripts || cfg.noScripts ? "(no-scripts)" : ""}`).join(",")} lint=${cfg.lint} flagged=${st.flaggedSkills} withheld=${st.scriptsWithheld} skills=${st.skills} hidden=${st.hidden} files=${st.files} bytes=${(st.bytes / 1048576).toFixed(1)}MiB playbooks=${st.playbooks} valueChains=${st.valueChains} scan=${Date.now() - t0}ms warnings=${st.warnings.length}`); });

  if (cfg.statsOnly) {
    await initial;
    process.stdout.write(JSON.stringify(cat.getStats(), null, 2) + "\n");
    return;
  }
  initial.catch((e) => { log("fatal: initial scan failed:", e?.message ?? e); process.exit(1); });

  if (cfg.rescanSeconds > 0) {
    const timer = setInterval(() => reload("interval").catch((e) => log("rescan failed:", e.message)), cfg.rescanSeconds * 1000);
    timer.unref();
  }
  process.on("SIGHUP", () => { reload("SIGHUP").catch((e) => log("rescan failed:", e.message)); });

  if (cfg.http) {
    const { port, host } = cfg.http;
    const srv = http.createServer(async (req, res) => {
      if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
      // Stateless: one server+transport per request; the catalog is shared.
      const server = createServer(cfg, cat);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      let body: unknown = undefined;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw ? JSON.parse(raw) : undefined;
      }
      await transport.handleRequest(req, res, body);
    });
    srv.listen(port, host, () => log(`listening on http://${host}:${port}/mcp`));
    return;
  }

  const server = createServer(cfg, cat);
  await server.connect(new StdioServerTransport());
  log("ready on stdio");
}

main().catch((e) => { log("error:", process.env.SKILLS_DEBUG ? (e?.stack ?? e) : (e?.message ?? e)); process.exit(1); });
