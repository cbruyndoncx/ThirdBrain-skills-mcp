# ThirdBrain skills-mcp

Library-agnostic MCP server that serves one or many directories of **Agent Skills** (`SKILL.md`
folders, flat or nested) over the Model Context Protocol, each library under its own namespace. Part of the ThirdBrain Business Operating Brain (BOB) tooling.
Built for the ThirdBrain BOB library (~400 skills) and verified against the GBL library (~400 skills).
Includes a `pull` client that syncs skills from any SEP-2640 server to disk with digest verification.

It implements the **MCP Skills extension ([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640))**
for hosts that understand `skill://` resources, and a small set of **discovery tools** for hosts
that do not yet, so skills are loaded on demand instead of being copied into every agent's
skills folder.

## What it exposes

| Surface | Purpose |
|---|---|
| `capabilities.extensions["io.modelcontextprotocol/skills"]` | Declares the extension (`directoryRead: true`). |
| `skills/list` (paginated) / `skills/get` | Skill entries: `uri`, verbatim `frontmatter`, `resources[]` with `sha256` digests and sizes. |
| `resources/list` | One `text/markdown` resource per skill (`skill://<name>/SKILL.md`), extra frontmatter under `_meta` with the `io.modelcontextprotocol.skills/` prefix. |
| `resources/templates/list` | `skill://{+skillPath}/SKILL.md` and `skill://{+skillPath}/{+path}`. |
| `resources/read` | Any bundled file (text, or base64 blob for binaries). |
| `resources/directory/read` | Children of a skill directory (`inode/directory`). |
| `notifications/resources/list_changed` | Sent after a rescan detects changes. |
| Tools | `<prefix>_search_skills`, `_list_skills`, `_list_libraries`, `_list_categories`, `_get_skill`, `_read_skill_file`, `_catalog_status`. All declare `outputSchema` and return `structuredContent`; search/list/categories take a `library` filter. |
| Prompt | `use-skill(skill, task?)` injects a skill's instructions into the conversation. |

The agent flow is progressive disclosure: **search → get_skill → read_skill_file**. Only the
skill you pick enters context.

## Install

```bash
git clone https://github.com/cbruyndoncx/ThirdBrain-skills-mcp.git
cd ThirdBrain-skills-mcp
npm install
npm run build
npm run test:unit   # 34 unit tests (in-memory MCP client, fixtures under test/fixtures)
npm test            # smoke test against the BOB library
npm run test:gbl    # same test against the GBL library
npm run test:nested # nested-path fixture (skill://acme/billing/refunds/...)
npm run test:all
```

### One server, several libraries (recommended)

```bash
claude mcp add --scope user skills -- node /path/to/ThirdBrain-skills-mcp/dist/index.js \
  --lib bob=/mnt/d/OBS/brncx-skills/00-CORE/Agents/skills \
  --lib gbl=/mnt/d/OBS/gbl-skills/00-CORE/Agents/skills
```

Each `--lib NS=DIR` becomes a namespace: URIs are `skill://bob/ab-test-setup/SKILL.md`,
tools accept a bare name when it is unique across libraries, or `bob/period-in-review` when the same
name exists in several. `skills_list_libraries` shows what is served; `library=bob` scopes search
and listing. The project `.mcp.json` uses this form.

### One library, un-namespaced

```bash
node dist/index.js --root /path/to/skills --name bob     # URIs: skill://<skill>/..., tools bob_*
```

`--name` sets the MCP server name and the tool prefix. Running several single-library instances
side by side also works (different `--name` per instance).

Streamable HTTP instead of stdio:

```bash
node dist/index.js --lib bob=DIR --http 3939   # endpoint: http://127.0.0.1:3939/mcp (stateless)
```

### Pull skills from any SEP-2640 server

```bash
node dist/index.js pull --url http://127.0.0.1:3939/mcp --list
node dist/index.js pull --url http://127.0.0.1:3939/mcp ab-test-setup gbl/period-in-review --to ./skills
node dist/index.js pull --all --keep-path --to ./skills --command node dist/index.js --lib bob=DIR
```

`pull` walks `skills/list`, reads every file with `resources/read`, verifies each sha256 digest
against the manifest, refuses paths outside the skill, and writes atomically. `--keep-path` keeps
the namespace as a folder; `--force` overwrites; `--dry-run` verifies without writing.

## Configuration

| Flag / env | Default | Meaning |
|---|---|---|
| `--root` / `SKILLS_ROOT` | one of these required | Single un-namespaced library, searched recursively for `SKILL.md` folders. |
| `--lib NS=DIR` / `SKILLS_LIBS="a=/x,b=/y"` | | Namespaced library; repeatable. Cannot be mixed with `--root`. |
| `--name` / `SKILLS_NAME` | `skills` | MCP server name; also the default tool prefix. |
| `--prefix` / `SKILLS_TOOL_PREFIX` | name with `-`→`_` | Tool-name prefix. |
| `--title` / `SKILLS_TITLE` | derived | Human title in `initialize`. |
| `--exclude` / `SKILLS_EXCLUDE` | `_archive,_audit` | Directory names skipped during discovery. |
| `--depth` / `SKILLS_DEPTH` | `4` | Max discovery depth below root. |
| `--show-disabled` / `SKILLS_HIDE_DISABLED=false` | hidden | Serve skills with `disable-model-invocation: true`. |
| `SKILLS_MAX_FILE_BYTES` | 4 MiB | Files above this are not served. |
| `SKILLS_RESCAN_SECONDS` | `60` | Background rescan interval (`0` disables). `<prefix>_catalog_status refresh=true` forces one. |
| `--stats` | | Print catalog statistics as JSON and exit. |

`BOB_SKILLS_*` environment variables are still accepted as aliases.

Nested libraries: a skill's URI path is its directory path below root, prefixed by the namespace
when there is one (`skill://acme/billing/refunds/SKILL.md`, `skill://bob/ab-test-setup/SKILL.md`).
Tools accept the bare `name` (when unique across all libraries), `<namespace>/<name>`, or the full path.

Always ignored inside skills: `.venv`, `node_modules`, `__pycache__`, `*.dist-info`, `.git`,
dotfiles, and compiled artefacts (`.pyc`, `.so`, `.whl`, ...).

## Runtime config file and hardening

```bash
node dist/index.js --config skills.json          # re-read on every rescan (default 60 s) and on SIGHUP
```

```json
{ "libraries": [
    { "namespace": "bob", "root": "/mnt/d/OBS/brncx-skills/00-CORE/Agents/skills" },
    { "namespace": "gbl", "root": "../gbl-skills/00-CORE/Agents/skills", "noScripts": true } ],
  "noScripts": false, "lint": true }
```

Libraries from the file can be added, removed or re-pointed while the server runs; libraries given
on the command line stay fixed. Relative roots resolve against the file's directory. A broken edit is
logged and the previous set is kept. Changes trigger `resources`, `tools` and `prompts`
`list_changed` notifications. `kill -HUP <pid>` forces an immediate reload.

The server never executes anything. Three additional layers label or withhold risky content:

| Layer | What it does | Where it shows up |
|---|---|---|
| Provenance | Lifts `origin`, `origin-repo`, `risk`, `outbound`, `outbound_targets`, `gate_required`, `dev-status`, `pricing-tier`, `license`, `allowed-tools` from frontmatter | `_meta["io.modelcontextprotocol.skills/<field>"]` on resources, `trust` in search/list/get_skill output, `Provenance:` line in get_skill text |
| `--no-scripts` (global) / `"noScripts": true` (per library) | Drops executable files (`.sh .bash .zsh .ps1 .bat .cmd .py .js .mjs .cjs .ts .rb .pl .php`) from manifests, `resources/read` and `read_skill_file` | `scriptsWithheld` count, `_meta[".../scripts-withheld"]`, catalog status |
| Scan-time linter (`--no-lint` to disable) | Regex rules over text files ≤ 512 KiB: `pipe-to-shell`, `remote-exec`, `eval-decode`, `base64-blob`, `destructive-rm`, `world-writable`, `sensitive-path`, `credential-literal`, `env-exfil`, `prompt-injection`, `reverse-shell` | Catalog warnings, `_meta[".../risk-flags"]`, `riskFlags` in search/list results, per-finding `file:line` in get_skill plus a `⚠ Risk flags` banner in its text |

The linter labels, it does not block. On BOB + GBL (786 skills) it flags 28, almost all
`curl … | sh` install instructions for third-party tools; those are legitimate but worth knowing
before a host runs them. Rules live in `src/lint.ts`.

## Spec conformance notes

* URIs are `skill://<skill-path>/<relative-path>`; the last skill-path segment equals frontmatter `name`.
  A warning is recorded when a directory name and its frontmatter `name` differ.
* Digests are computed lazily and cached per file `mtime`, so `skills/list` is cheap after the first call.
* SEP-2640 limits (512 files, 16 MiB per skill) are enforced/flagged: file lists are truncated
  at 512 and oversized skills are listed in `bob_catalog_status include_warnings=true`.
  In BOB, `visual-narrative`, `period-in-review` and `workflow-video` exceed 16 MiB because of
  bundled media; strict hosts may refuse them, all others load fine.
* `skills/get` answers for hidden (disabled) skills too, as the spec requires.

## Layout

```
src/config.ts       env/CLI configuration
src/frontmatter.ts  SKILL.md frontmatter parsing
src/catalog.ts      directory scan, file inventory, digests, change detection
src/search.ts       ranked keyword search over name/description/tags/body
src/server.ts       MCP wiring: extension methods, resources, tools, prompt
src/lint.ts         scan-time risk linter (labels, never blocks)
src/pull.ts         client: sync skills from a SEP-2640 server with digest verification
src/index.ts        entrypoint: `serve` (default; stdio or --http) and `pull`
test/unit/*.test.ts unit tests (config, frontmatter, catalog, search, server via InMemoryTransport, pull, hardening)
test/smoke.ts       end-to-end test via a real MCP client (parametrised by root/name)
test/nested.mjs     nested-path + duplicate-name test against test/fixtures/nested
```
