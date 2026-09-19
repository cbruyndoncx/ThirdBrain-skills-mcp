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
| `--root` / `SKILLS_ROOT` | one of these required | Single un-namespaced library: a directory searched recursively for `SKILL.md` folders, or a `.zip` of one. |
| `--lib NS=DIR` / `SKILLS_LIBS="a=/x,b=/y.zip"` | | Namespaced library; repeatable. Cannot be mixed with `--root`. A `.zip` root is allowed. |
| `--name` / `SKILLS_NAME` | `skills` | MCP server name; also the default tool prefix. |
| `--prefix` / `SKILLS_TOOL_PREFIX` | name with `-`→`_` | Tool-name prefix. |
| `--title` / `SKILLS_TITLE` | derived | Human title in `initialize`. |
| `--exclude` / `SKILLS_EXCLUDE` | `_archive,_audit` | Directory names skipped during discovery. |
| `--depth` / `SKILLS_DEPTH` | `4` | Max discovery depth below root. |
| `--show-disabled` / `SKILLS_HIDE_DISABLED=false` | hidden | Serve skills with `disable-model-invocation: true`. |
| `SKILLS_MAX_FILE_BYTES` | 4 MiB | Files above this are not served. |
| `SKILLS_CACHE_DIR` | `~/.cache/skills-mcp` | Where `.zip` libraries are extracted and downloaded, keyed by content digest. |
| `SKILLS_MAX_DOWNLOAD_BYTES` | 256 MiB | Ceiling on bytes read from the network for a remote library. |
| `SKILLS_FETCH_TIMEOUT_MS` | `60000` | Timeout for a single HTTP request when fetching a remote library. |
| `SKILLS_FETCH_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | | Bearer token for private archive assets. |
| `SKILLS_MAX_ARCHIVE_BYTES` | 256 MiB | Total uncompressed size an archive library may extract to. |
| `SKILLS_MAX_ARCHIVE_ENTRIES` | `8192` | Max entries in an archive library. |
| `SKILLS_RESCAN_SECONDS` | `60` | Background rescan interval (`0` disables). `<prefix>_catalog_status refresh=true` forces one. |
| `--stats` | | Print catalog statistics as JSON and exit. |

`BOB_SKILLS_*` environment variables are still accepted as aliases.

Nested libraries: a skill's URI path is its directory path below root, prefixed by the namespace
when there is one (`skill://acme/billing/refunds/SKILL.md`, `skill://bob/ab-test-setup/SKILL.md`).
Tools accept the bare `name` (when unique across all libraries), `<namespace>/<name>`, or the full path.

Always ignored inside skills: `.venv`, `node_modules`, `__pycache__`, `*.dist-info`, `.git`,
dotfiles, and compiled artefacts (`.pyc`, `.so`, `.whl`, ...).

## Archive libraries

A library root may be a `.zip` instead of a directory:

```bash
skills-mcp --lib bob=/srv/libraries/bob-skills.zip
skills-mcp --root ./my-skills.zip
```

The archive is a transport container, not served content. On the first scan it is extracted into
`SKILLS_CACHE_DIR/<sha256-of-zip>/`, and discovery, linting, digests and URIs then run over ordinary
files — nothing downstream knows an archive was involved. Because the cache is keyed by content
digest, a rescan of an unchanged archive costs a single `stat`; replacing the archive extracts the
new one and prunes the extraction it replaced.

Skills inside the archive are laid out exactly as in a directory library, so a wrapper directory
(as produced by `git archive` or GitHub's "Download ZIP") is fine — discovery descends into it.

**Archives may not appear inside a library.** A bundled `payload.zip` would be served as an opaque
base64 blob that the risk linter cannot read, so any skill containing one is refused and reported:

```
sneaky: bundles archive file(s) (notes.tgz, payload.zip); skills may not contain archives, skill not served
```

This applies to directory libraries too, and covers `.zip .tar .tgz .tar.gz .gz .bz2 .xz .7z .rar
.jar .war .apk .iso .dmg .cab` — renaming a zip to `.tgz` does not get past it. The count appears in
`--stats` as `archiveSkillsRejected`. One bad skill is withheld; the rest of the library still serves.

### Remote (URL) libraries

A library may also be an `https` URL of a `.zip`, so a published release can be served without
checking anything out:

```bash
# pinned to a digest (recommended)
skills-mcp --lib sales='https://host/pack-sales-free-v2.7.0.zip#sha256=fac65d24...'

# or in the config file
{"libraries": [{"namespace": "sales", "url": "https://host/pack.zip", "sha256": "fac65d24..."}]}
```

GitHub release assets work directly, including private ones — export `GH_TOKEN` and use the asset
API URL:

```bash
export GH_TOKEN=$(gh auth token)
skills-mcp --lib sales="https://api.github.com/repos/OWNER/REPO/releases/assets/<id>#sha256=<hex>"
```

**Integrity.** The archive is verified before extraction: against the `sha256` pinned in config, or
failing that a `<url>.sha256` sidecar next to the asset. A mismatch is refused outright rather than
served. Pinning is stronger than the sidecar, since the sidecar travels the same wire as the zip.

**Caching.** Downloads are keyed by content digest, the same key the extractor uses. A pinned URL
that has already been fetched never touches the network again — the second start of the server
above scans in ~80 ms. A remote library is fetched once per process; change the URL or the pin to
pick up a new version.

**Failure handling.** If a refresh fails but a previous extraction is still cached, the cached copy
keeps being served and a warning is recorded — a transient DNS blip during a background rescan will
not empty a live library.

**What is refused:**

| Check | Why |
|---|---|
| Any scheme but `https`, on the initial URL **and every redirect** | No plaintext downgrade mid-chain |
| More than 5 redirects | Redirect loops |
| `Authorization` on a cross-host redirect | A token must not follow a redirect to another host. GitHub relies on this: it redirects asset URLs to a signed object store that must be called *without* the header |
| `content-length` over the cap, or the body exceeding it mid-stream | A lying or absent `content-length` cannot smuggle a huge body onto disk |
| A digest that does not match the pin or sidecar | Tampering or corruption |

Query strings and fragments are stripped from anything logged, so credentials in a signed URL do
not reach a log line.

### What is rejected in an archive

The archive is treated as untrusted input. Extraction refuses, before writing anything to disk:

| Check | Why |
|---|---|
| Entry paths containing `..`, absolute paths, drive letters, backslashes | Path traversal ("zip slip") |
| Symlink entries | A link to `~/.ssh/id_rsa` would otherwise be served verbatim |
| Encrypted entries, compression methods other than stored/deflate, zip64 | Unparseable or unsupported |
| Nested archives | Hide content from the linter |
| More than `SKILLS_MAX_ARCHIVE_ENTRIES` entries | Resource exhaustion |
| Entries over `SKILLS_MAX_FILE_BYTES × 16`, or a total over `SKILLS_MAX_ARCHIVE_BYTES` | Decompression bombs |
| Compression ratio over 100:1 *for entries above 1 MiB* | Bombs, without flagging ordinary repetitive content |

The byte budget is enforced **while inflating**, not from the sizes declared in the central
directory, since those are attacker-controlled and may lie. A failed extraction leaves no partial
tree behind, and extracted files are always written non-executable (`0644`).

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

## Bundled scripts

Skills may ship scripts (`scripts/extract.py`), and this server serves them like any other file.
What happens on the receiving side is up to the host; SEP-2640 sets the rules:

* **Fetched on demand, verified, cached.** Hosts SHOULD cache skill files locally as they are read,
  not in bulk, and MUST verify each file against its `sha256` digest from `skills/list` /
  `skills/get`. The cache must be writable only by the host (or re-hashed on every use), live
  outside every local skill-discovery path, and be separated per server.
* **Cached is not local.** A cached script keeps its MCP origin, even after a restart or after the
  server is disconnected. It never gains the trust of a filesystem skill.
* **No execution without approval.** Hosts MUST NOT run a script from an MCP-served skill, or any
  command its instructions direct the model to run, without explicit per-skill user approval. That
  approval is bound to the skill's file set and digests; any change revokes it.
* **No executable bits.** Files travel one by one as resources, without mode bits or symlinks, so a
  script is run through its interpreter (`python scripts/extract.py`), never as `./extract.py`.

Hosts without SEP-2640 support reach skills through the tools, so this server repeats those rules
to the model. The server instructions, `get_skill` and the `use-skill` prompt label every skill with
its source server (`Source: <name> (MCP-served skill, not installed locally)`). When a skill bundles
scripts, the model is told to get the user's approval, check the digest and use an interpreter.
`read_skill_file` attaches the same note, with the digest, to every executable file. Skill output
(`get_skill`, `read_skill_file`, `use-skill`) only shows paths relative to the skill folder, never
where the skill lives on the server's disk.

For skill authors this means:

* Reference scripts by path relative to the skill root, and show the interpreter in the command:
  `python scripts/extract.py input.pdf`, not `./scripts/extract.py` or an absolute path.
* Do not rely on a script's executable bit, on symlinks, or on files outside the skill directory.
* Declare dependencies in `SKILL.md` (or a `requirements.txt` in the skill), since `.venv` and
  `node_modules` are never served.
* Expect a host to ask the user before running anything, and write instructions that still make
  sense if the user says no.

`pull` is an explicit install, not a spec cache: files written with `--to` into a folder the host
scans for skills become local skills. Pull only from servers you trust, or use `--no-scripts` on
the serving side to withhold scripts entirely.

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
src/archive.ts      zip-backed libraries: strict extraction, path/bomb/symlink defences, digest cache
src/remote.ts       remote libraries: https fetch, redirect/credential rules, digest verification
src/search.ts       ranked keyword search over name/description/tags/body
src/server.ts       MCP wiring: extension methods, resources, tools, prompt
src/lint.ts         scan-time risk linter (labels, never blocks)
src/pull.ts         client: sync skills from a SEP-2640 server with digest verification
src/index.ts        entrypoint: `serve` (default; stdio or --http) and `pull`
test/unit/*.test.ts unit tests (config, frontmatter, catalog, search, server via InMemoryTransport, pull, hardening, archive, remote)
test/smoke.ts       end-to-end test via a real MCP client (parametrised by root/name)
test/nested.mjs     nested-path + duplicate-name test against test/fixtures/nested
```
