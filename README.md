# ThirdBrain skills-mcp

Library-agnostic MCP server that serves one or many directories of **Agent Skills** (`SKILL.md`
folders, flat or nested) over the Model Context Protocol, each library under its own namespace.
Any folder of `SKILL.md` directories works: your own skills, a vendor pack, a git checkout, a zip,
or a GitHub release asset. Optionally it also serves **playbooks** and **value chains** when a
library ships them. Includes a `pull` client that syncs skills from any SEP-2640 server to disk
with digest verification, and a `pack` command that builds a distributable zip.

It implements the **MCP Skills extension ([SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640))**
for hosts that understand `skill://` resources, and a small set of **discovery tools** for hosts
that do not yet, so skills are loaded on demand instead of being copied into every agent's
skills folder. The agent flow is progressive disclosure: **search → get_skill → read_skill_file**.
Only the skill you pick enters context.

It was built for, and is exercised daily against, the ThirdBrain Business Operating Brain (BOB)
library (~400 skills). Nothing in the server depends on BOB: a library needs only `SKILL.md`
folders, and the playbook and value-chain features switch on only when the matching folders and
files are present. BOB-specific material (vault layout, measured numbers, this repository's own
MCP config) is collected in the [last section](#thirdbrain-bob-specifics).

## Quick start

```bash
git clone https://github.com/cbruyndoncx/ThirdBrain-skills-mcp.git
cd ThirdBrain-skills-mcp
npm install && npm run build
node dist/index.js --root /path/to/my-skills --name myskills     # serve one folder over stdio
node dist/index.js --root /path/to/my-skills --stats             # what would be served, as JSON
```

Register it with Claude Code (any other MCP host takes the same command line):

```bash
claude mcp add --scope user myskills -- node /path/to/ThirdBrain-skills-mcp/dist/index.js --root /path/to/my-skills --name myskills
```

The agent then has `myskills_search_skills`, `myskills_get_skill`, `myskills_read_skill_file`
and friends. `npx github:cbruyndoncx/ThirdBrain-skills-mcp --root DIR` builds and runs it without a
checkout (the package exposes the `skills-mcp` binary).

## Ways to use it

Every form below takes the same flags; the difference is only where the content comes from.

### 1. One folder of skills

```bash
skills-mcp --root /path/to/skills --name acme       # URIs skill://<skill>/SKILL.md, tools acme_*
```

`--name` sets the MCP server name and the default tool prefix. Discovery finds every folder that
holds a `SKILL.md`, up to four levels deep, so both flat (`skills/refunds/SKILL.md`) and nested
(`skills/billing/refunds/SKILL.md`) layouts work; the nested path becomes the URI
(`skill://billing/refunds/SKILL.md`) and the folder path becomes the category.

### 2. Several libraries in one server

```bash
skills-mcp --lib acme=/path/to/acme-skills --lib vendor=/path/to/vendor-skills --name skills
```

Each `--lib NS=DIR` is a namespace: URIs are `skill://acme/refunds/SKILL.md`, tools accept a bare
name when it is unique across libraries, or `vendor/refunds` when both ship one.
`skills_list_libraries` shows what is served; `library=acme` scopes search and listing.
`--root` and `--lib` cannot be mixed.

### 3. A zip instead of a folder

```bash
skills-mcp --lib vendor=/srv/packs/vendor-skills-2.7.0.zip
```

The zip is a transport container: it is verified, extracted once into a digest-keyed cache, and
served like a directory. A wrapper folder inside (as `git archive` and GitHub "Download ZIP"
produce) is fine. See [Archive libraries](#archive-libraries) for what is refused.

### 4. A published release, by URL

```bash
skills-mcp --lib vendor='https://host/vendor-skills-2.7.0.zip#sha256=fac65d24…'      # pinned
export GH_TOKEN=$(gh auth token)                                                     # private asset
skills-mcp --lib vendor='https://api.github.com/repos/OWNER/REPO/releases/assets/<id>#sha256=<hex>'
```

Consumers need no checkout and no vault. Pin the digest; a mismatch is refused. Fetched once per
process and cached by digest, so the second start is instant and offline. See
[Remote libraries](#remote-url-libraries).

### 5. Skills plus playbooks and value chains

```bash
skills-mcp --lib acme=/path/to/acme-vault          # a vault root: skills, playbooks, value chains
skills-mcp --lib acme=/path/to/acme-vault.zip      # the same, packed
```

When the root you give contains `00-CORE/Agents/skills`, and next to it `00-CORE/Playbooks` or a
`value-chains.md`, the server also serves playbooks (multi-step workflows that chain skills into an
outcome) and value chains (business journeys with ordered stages that skills and playbooks map
to). The root is the boundary: nothing above or beside it is read, so pointing at the skills
folder alone serves skills only. Conventions and tools in
[Playbooks and value chains](#playbooks-and-value-chains).

### 6. Runtime config file, hot reload, HTTP

```bash
skills-mcp --config skills.json              # libraries re-read on every rescan and on SIGHUP
skills-mcp --lib acme=DIR --http 3939        # Streamable HTTP at http://127.0.0.1:3939/mcp
```

The config file adds, removes or re-points libraries while the server runs and carries the
descriptive metadata (`title`, `source`, `version`) that clients see instead of paths. See
[Runtime config file and hardening](#runtime-config-file-and-hardening).

### 7. Pull skills to disk from any SEP-2640 server

```bash
skills-mcp pull --url http://127.0.0.1:3939/mcp --list
skills-mcp pull --url http://127.0.0.1:3939/mcp refunds vendor/onboarding --to ./skills
skills-mcp pull --all --keep-path --to ./skills --command node dist/index.js --lib acme=DIR
skills-mcp pull --with-deps --keep-path --sync --to ~/.cache/skills-mcp-client/acme acme/refunds --url …
```

A client, not a server: walks `skills/list`, reads every file with `resources/read`, verifies each
sha256 digest, refuses paths outside the skill, writes atomically. Works against this server or
any other SEP-2640 server. Details in [Pull](#pull-skills-from-any-sep-2640-server).

### 8. Build a distributable pack

```bash
skills-mcp pack --vault /path/to/acme-vault --out acme-2026.09.zip
skills-mcp --lib acme=acme-2026.09.zip                 # serve it; or upload it and use form 4
```

Copies exactly the public subset the server serves (skills, active core playbooks with their
embedded files, the value-chains file), as a deterministic zip with a `.sha256` sidecar, and prints
the pinned `--lib` line for consumers. Details in [Pack](#build-a-distributable-pack-from-a-vault).

## What it exposes

| Surface | Purpose |
|---|---|
| `capabilities.extensions["io.modelcontextprotocol/skills"]` | Declares the extension (`directoryRead: true`). |
| `skills/list` (paginated) / `skills/get` | Skill entries: `uri`, verbatim `frontmatter`, `resources[]` with `sha256` digests and sizes, and `_meta` with `io.modelcontextprotocol.skills/dependencies` (`{required, optional}`: other skills this one runs code from, see [Runtime dependencies](#runtime-dependencies)) and `.../library`. |
| `resources/list` | One `text/markdown` resource per skill (`skill://<name>/SKILL.md`), extra frontmatter under `_meta` with the `io.modelcontextprotocol.skills/` prefix. Plus one per served playbook (`playbook://<ns>/<name>`) and value chain (`value-chain://<ns>/<id>`), `_meta` under `io.thirdbrain.vault/`. |
| `resources/templates/list` | `skill://{+skillPath}/SKILL.md` and `skill://{+skillPath}/{+path}`; `playbook://{+playbookPath}`, `playbook://{+playbookPath}/{+file}` and `value-chain://{+library}/{id}` unless switched off. |
| `resources/read` | Any bundled file (text, or base64 blob for binaries); a playbook note or an attachment embedded by it; a value chain rendered as a markdown stage table. |
| `resources/directory/read` | Children of a skill directory (`inode/directory`). |
| `notifications/resources/list_changed` | Sent after a rescan detects changes. |
| Tools | `<prefix>_search_skills`, `_list_skills`, `_list_libraries`, `_list_categories`, `_get_skill`, `_read_skill_file`, `_catalog_status`, and `_list_playbooks`, `_get_playbook`, `_list_value_chains`, `_get_value_chain` (listed unless `--no-playbooks` / `--no-value-chains`; they answer empty for a library that ships none). All declare `outputSchema` and return `structuredContent`; search/list/categories take a `library` filter. |
| Prompts | `use-skill(skill, task?)` injects a skill's instructions into the conversation; `run-playbook(playbook, inputs?)` injects the `playbook-runner` skill plus a playbook. |

Tool names are the prefix (default: the server name, `-` → `_`) plus the suffix, so a server
named `acme` has `acme_search_skills`. Tools accept the bare skill `name` (when unique across all
libraries), `<namespace>/<name>`, or the full path from search results.

Browsing: `_list_categories` gives the taxonomy (from frontmatter `category`, else the folder
path between namespace and skill, else `uncategorized`) with counts; `_list_skills(category)`
and `_search_skills(query, category)` filter by it. Skills stay a flat list at the resource layer;
there is no category tree in `skill://` URIs.

## Configuration

| Flag / env | Default | Meaning |
|---|---|---|
| `--root` / `SKILLS_MCP_ROOT` | one of these required | Single un-namespaced library: a directory searched recursively for `SKILL.md` folders, or a `.zip` of one. `SKILLS_ROOT` is **not** read (it belongs to the skills' own contract). |
| `--lib NS=DIR` / `SKILLS_LIBS="a=/x,b=/y.zip"` | | Namespaced library; repeatable. Cannot be mixed with `--root`. A `.zip` path or an `https` URL of a zip (optionally `#sha256=<hex>`) is allowed. |
| `--config FILE` / `SKILLS_CONFIG` | | JSON file with libraries and global switches, re-read on every rescan and on SIGHUP. See [Runtime config file](#runtime-config-file-and-hardening). |
| `--name` / `SKILLS_NAME` | `skills`, or the namespace when there is exactly one | MCP server name; also the default tool prefix. |
| `--prefix` / `SKILLS_TOOL_PREFIX` | name with `-`→`_` | Tool-name prefix. |
| `--title` / `SKILLS_TITLE` | derived | Human title in `initialize`. |
| `--exclude` / `SKILLS_EXCLUDE` | `_archive,_audit` | Directory names skipped during discovery. |
| `--depth` / `SKILLS_DEPTH` | `4` | Max discovery depth below root. |
| `--show-disabled` / `SKILLS_HIDE_DISABLED=false` | hidden | Serve skills with `disable-model-invocation: true`, and playbooks whose `status` is not `active`. |
| `--no-scripts` / `SKILLS_NO_SCRIPTS=true` | served | Withhold executable files from every library (per library: `"noScripts": true` in the config file). |
| `--no-lint` / `SKILLS_LINT=false` | on | Disable the scan-time risk linter. |
| `--vault NS=DIR` / `SKILLS_VAULTS="acme=/vault"` | the root itself | Explicit vault directory holding a library's playbooks and value chains. By default only the library root is inspected; nothing above or beside it is read. |
| `--no-playbooks` / `SKILLS_PLAYBOOKS=false` | served | Never serve playbooks (default: served when found and a `playbook-runner` skill is served). |
| `--no-value-chains` / `SKILLS_VALUE_CHAINS=false` | served | Never serve value chains (default: served when found). |
| `--exclude-tiers T1,T2` / `SKILLS_EXCLUDE_TIERS` / `"excludeTiers"` in the config file | none | Skills and playbooks whose frontmatter `pricing-tier` is in the list (case-insensitive) are not served at all (not even to `skills/get`) and are counted in `hidden` / `playbooksHidden`; `catalog_status` and `--stats` report `tierExcluded {tiers, skills, playbooks}`. The config file value, when set, replaces the flag. |
| `--http PORT` / `SKILLS_HOST` | stdio; `127.0.0.1`, port `3939` | Streamable HTTP instead of stdio; `SKILLS_HOST` sets the bind address. |
| `SKILLS_MAX_FILE_BYTES` | 4 MiB | Files above this are not served. |
| `SKILLS_CACHE_DIR` | `~/.cache/skills-mcp` | Where `.zip` libraries are extracted and downloaded, keyed by content digest. |
| `SKILLS_MAX_DOWNLOAD_BYTES` | 256 MiB | Ceiling on bytes read from the network for a remote library. |
| `SKILLS_FETCH_TIMEOUT_MS` | `60000` | Timeout for a single HTTP request when fetching a remote library. |
| `SKILLS_FETCH_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` | | Bearer token for private archive assets. |
| `SKILLS_MAX_ARCHIVE_BYTES` | 256 MiB | Total uncompressed size an archive library may extract to. |
| `SKILLS_MAX_ARCHIVE_ENTRIES` | `8192` | Max entries in an archive library. |
| `SKILLS_RESCAN_SECONDS` | `60` | Background rescan interval (`0` disables). `<prefix>_catalog_status refresh=true` forces one. |
| `--stats` | | Print catalog statistics as JSON and exit. |

Nested libraries: a skill's URI path is its directory path below root, prefixed by the namespace
when there is one (`skill://acme/billing/refunds/SKILL.md`).

Always ignored inside skills, silently: tool and build folders (`.venv`, `venv`, `node_modules`,
`__pycache__`, `site-packages`, `.git`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `*.dist-info`,
`*.egg-info`), compiled artefacts (`.pyc`, `.pyo`, `.so`, `.dylib`, `.dll`, `.whl`) and type stubs
(`.pyi`). Also not served, but reported as one `catalog_status` warning per skill
(`<skill>: N file(s) skipped (… over SKILLS_MAX_FILE_BYTES: …; … symlink: …; … dotfile: …)`, up to
three names each): files over `SKILLS_MAX_FILE_BYTES`, symlinks, and dotfiles or dot-folders.

## Playbooks and value chains

Optional. A library may ship two more things next to its skills: **playbooks** (multi-step
workflows that chain skills into an outcome: trigger → numbered AGENT/HUMAN steps → outcome) and
**value chains** (end-to-end business journeys such as `lead-to-cash` with ordered stages, to which
skills and playbooks are mapped). The layout and note formats below are the ThirdBrain BOB vault
conventions; any library that follows them gets the same features, and a library without them is
served as skills only. The four tools, the `run-playbook` prompt and the resource templates are
always listed (turn them off with `--no-playbooks` / `--no-value-chains`), so a host that fetches
the tool list once, before the first scan finishes, still sees them; when no library ships the
content they answer with an empty list and a hint that says so.

**The root is the boundary.** The server reads only what is inside the directory, zip or URL you
give it, never folders above or beside it. So `--lib acme=<vault>/00-CORE/Agents/skills` serves
skills only; to serve playbooks and value chains, give the vault root (or a release zip of it).
The layout is recognised from what is inside the root, so the same pack works as a checked-out
folder, a local zip, or a GitHub release asset:

| Root given (directory, zip, or URL) | Skills root | Vault root |
|---|---|---|
| A skills folder (any folder without the markers below) | as given | none: skills only |
| `<vault>` (contains `00-CORE/Agents/skills`) | that subfolder | as given |
| One wrapper folder containing `00-CORE/Agents/skills` (GitHub release zips are shaped this way) | inside the wrapper | the wrapper |
| Anything else that holds `00-CORE/Playbooks` or a `value-chains.md` within four levels | as given | as given |

`--vault NS=DIR` or `"vault"` in the config file names a vault directory explicitly, the one case
where content outside the root is served, by your choice; `"vault": false` turns the extras off
for one library. Inside the vault root only these locations are read:

| Information | Source | Served as |
|---|---|---|
| Playbooks | `type: playbook` notes under `00-CORE/Playbooks/` only, the vault-shipped library. Company, personal and client playbooks (`20-COMPANY/03-PROCESSES/Playbooks/`, `10-ME/Playbooks/`, `30-CLIENTS/<id>/Playbooks/`) are private and never served; notes found in the first two are counted in a `catalog_status` warning so the operator knows. Recursive; `_archive/` and `UPGRADE/` skipped; `AGENTS.md`, `CLAUDE.md`, `_local.md` ignored. | `playbook://<ns>/<file stem>`; files embedded with `![[name]]` from the same folder (sequence diagrams) as `playbook://<ns>/<stem>/<file>` |
| Value chains | `20-COMPANY/03-PROCESSES/value-chains.md`, the canonical file: `### <id>` with **SME Label**, **Description**, **Stages** fields (bulleted `- **Stages:** …` or not), plus the `## Cross-Chain: …` / `## Meta-Chain: …` sections and the ids in its "Valid chain IDs" list that have no `###` block, which are served as **buckets** (unstaged groups such as `operating-controls` and `infrastructure`: no stages, no gaps). Else `VALUE-CHAINS.md` at the root, else any `value-chains.md` (case-insensitive) found by walking. Without one, chains are **derived** from the `value-chains` / `chain-stage` frontmatter of skills and the `value-chain` / `chain-coverage` frontmatter of playbooks. | `value-chain://<ns>/<id>` |

Paths never leave the server: `vaultPath` in playbook output is relative to the vault root, and
archive extraction directories are not shown.

**How steps are read.** Steps are the numbered items of the `## Steps` section, in the
`playbook-runner` grammar: `N (countdown). head → action (AGENT|HUMAN[ — note])`, where the head
is `skill`, `skill (route)`, `[[Playbook]]` or `script:file.py`, and bold or code decoration around
it is ignored. An item runs over its indented continuation lines up to the next item or heading
(numbered lines inside code fences or indented deeper are not items). The actor is the
parenthesis ending the item's first paragraph (`(AGENT)`, `(HUMAN + AGENT)`, `(HUMAN, 5 min)`,
`(HUMAN decides, AGENT drafts)`), else the first one inside it, else the one ending a later
paragraph. A step's skill is the head when it names a skill, else the first **served** skill the
step links to — `[[skill]]`, `[[skill/SKILL.md|…]]`, `{skills.root}/skill/…` or `skill/scripts/…`;
links to other notes (playbooks) are not skills, and embeds (`![[…]]`) are ignored. Further linked
skills are listed as `mentions`. A note without a Steps section uses its `### Phase N` /
`### Step N` headings as steps, else any numbered lines.

**Playbooks require the `playbook-runner` skill.** A playbook is executed by that skill's run
route, so a library's playbooks are served only when a skill named `playbook-runner` is served,
from the same library or, failing that, from any other library on the server. Otherwise they are
counted as `playbooksHidden` and a warning says so. Only `status: active` playbooks are served
(`draft`, `review` and `retired` ones are hidden); `--show-disabled` serves every status. Value
chains are not gated by any skill: presence is decided by the definition file or the frontmatter
references above, and coverage is computed by this server from the catalog.

**What the tools return.**

* `_list_playbooks(query?, library?, value_chain?, stage?, skill?)` — ranked by query over name,
  trigger, outcome, tags and step skills; each entry carries `trigger`, `outcome`, `steps`,
  `valueChain`, `chainCoverage`, the `skills` its steps name and the `runner` skill path to load.
* `_get_playbook(name)` — the full note plus `stepDetails` (`n`, `skill`, `skillPath` when the
  skill is served, `route`, `mentions`, `action`, `actor`), `missingSkills` (named by steps but not
  served), `attachments` with sha256 digests, and the `vaultPath` inside the vault. The text ends
  with how to execute it: load `playbook-runner` with `_get_skill`, then each step's skill when
  reached.
* `_list_value_chains(library?)` — chains with label, stages, `kind` (`chain`, or `bucket` for an
  unstaged group), `source` (`definition`, `index`, `derived`) and skill/playbook counts.
* `_get_value_chain(id)` — the stage table (skills and playbooks per stage), `unstaged` items that
  declare the chain without a stage (for a bucket: all its members), and `gaps` (stages nobody
  covers; always empty for a bucket).
* `run-playbook(playbook, inputs?)` prompt — the `playbook-runner` SKILL.md body and the playbook,
  each in its own tagged block, with the served skill path for every step.

Playbooks and chains are data from the library, not instructions from the user, and the text
output says so. `_list_libraries` and `_catalog_status` report `vault`, `playbooks`,
`playbooksHidden`, `playbookRunner`, `valueChains`, `valueChainBuckets` (how many of them are
buckets) and `valueChainSource` per library. Warnings (in `_catalog_status include_warnings=true`)
cover playbooks whose steps name an unserved skill, a `total-steps` that differs from the steps
parsed, notes filed in a subdirectory of a playbook root, chains referenced by frontmatter but not
defined, and a missing runner.

```bash
skills-mcp --lib acme=/vault                                  # vault root: skills, playbooks, chains
skills-mcp --lib acme=/vault/00-CORE/Agents/skills            # skills folder: skills only
skills-mcp --lib acme=acme-2026.09.zip                        # release zip (wrapper folder or not)
skills-mcp --lib acme='https://host/acme-2026.09.zip#sha256=…'
skills-mcp --lib acme=/elsewhere/skills --vault acme=/vault   # explicit vault root
skills-mcp --lib acme=/vault --no-playbooks --no-value-chains
```

## Archive libraries

A library root may be a `.zip` instead of a directory:

```bash
skills-mcp --lib acme=/srv/libraries/acme-skills.zip
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

### Build a distributable pack from a vault

```bash
skills-mcp pack --vault /path/to/vault --out acme-2026.09.zip [--wrapper acme-2026.09] [--all-statuses] [--dry-run]
```

Copies exactly the public content the server serves: `00-CORE/Agents/skills` (with the server's
ignore rules, skills that bundle an archive left out), the `status: active` playbooks in
`00-CORE/Playbooks` together with the files they embed, and the canonical
`20-COMPANY/03-PROCESSES/value-chains.md`. Company, personal and client folders are never read,
and the generated `VALUE-CHAINS.md` is not shipped because it names private playbooks. The zip is
deterministic (sorted entries, fixed timestamps) and gets a `.sha256` sidecar; the command prints
the pinned `--lib` line to give consumers. `pack.json` inside records what was packed. Serving the
pack gives the same catalog as serving the vault root, minus the private-folder warning.

### Pull skills from any SEP-2640 server

```bash
skills-mcp pull --url http://127.0.0.1:3939/mcp --list
skills-mcp pull --url http://127.0.0.1:3939/mcp refunds vendor/onboarding --to ./skills
skills-mcp pull --all --keep-path --to ./skills --command node dist/index.js --lib acme=DIR
skills-mcp pull --with-deps --keep-path --sync --to ~/.cache/skills-mcp-client/acme acme/refunds \
  --command node dist/index.js --lib acme=/path/to/acme-skills
```

`pull` walks `skills/list`, reads every file with `resources/read`, verifies each sha256 digest
against the manifest, refuses paths outside the skill, and writes atomically. `--keep-path` keeps
the namespace as a folder; `--force` overwrites; `--dry-run` verifies without writing. `--sync`
updates an existing folder in place: files whose sha256 already matches are kept without a network
read, changed or missing ones are fetched, and files no longer in the skill are deleted, so a
re-run on an unchanged skill costs one `skills/list` and some local hashing. Without the CLI
installed, `npx github:cbruyndoncx/ThirdBrain-skills-mcp pull ...` builds and runs it. It copies
skills only; playbooks and value chains travel as a pack (above).

`--with-deps` also pulls every skill a selected skill declares as a **required runtime dependency**
(the `_meta["io.modelcontextprotocol.skills/dependencies"].required` list, see
[Runtime dependencies](#runtime-dependencies)), transitively and from the same library, and writes
each next to it (`<to>/<ns>/<dep>/` with `--keep-path`), which is where a script importing a sibling
skill looks for it. Each added skill is logged (`deps  acme/refunds → acme/context-pack`).
Optional dependencies are not pulled. A required dependency the server does not serve in the same
library stops the pull with an error rather than leaving a closure that cannot run; pull without
`--with-deps` to fetch the skill alone. The flag is off by default, so existing invocations behave
as before.

## Runtime config file and hardening

```bash
skills-mcp --config skills.json          # re-read on every rescan (default 60 s) and on SIGHUP
```

```json
{ "libraries": [
    { "namespace": "acme", "root": "/path/to/acme-vault",
      "title": "Acme skills", "source": "acme-vault", "version": "2026.09",
      "metadata": { "channel": "stable" } },
    { "namespace": "vendor", "url": "https://host/vendor-2.7.0.zip", "sha256": "fac65d24...", "noScripts": true, "vault": false },
    { "namespace": "team", "root": "../team/skills", "vault": "../team" } ],
  "noScripts": false, "lint": true, "playbooks": true, "valueChains": true, "excludeTiers": [] }
```

`vault` is optional: a path (relative to the file) naming a vault directory explicitly when the
library root is only the skills folder, or `false` to serve that library's skills only. `playbooks`
and `valueChains` are global switches (default `true`); `excludeTiers` (an array or a comma string,
default none) is the `--exclude-tiers` list.

Libraries from the file can be added, removed or re-pointed while the server runs; libraries given
on the command line stay fixed. Relative roots resolve against the file's directory. A broken edit is
logged and the previous set is kept. Changes trigger `resources`, `tools` and `prompts`
`list_changed` notifications. `kill -HUP <pid>` forces an immediate reload.

**Library paths never leave the server.** `list_libraries`, `catalog_status`, the `initialize`
instructions and skill output show what is loaded, not where it is: the optional `title`, `source`
(the vault, repository or team the library comes from), `version` and free-form string `metadata`
from the config file, the `kind` (`directory`, `archive`, `url`), and for archive and url
libraries the sha256 of the archive currently extracted. Warnings returned by `catalog_status`
have root paths replaced by `<namespace>`. Roots still appear in the server log and in `--stats`,
which are for the operator. Metadata fields are only available in the config file; a library given
as `--lib NS=DIR` shows its namespace and kind.

The server never executes anything. Three additional layers label or withhold risky content:

| Layer | What it does | Where it shows up |
|---|---|---|
| Provenance | Lifts `origin`, `origin-repo`, `risk`, `outbound`, `outbound_targets`, `gate_required`, `dev-status`, `pricing-tier`, `license`, `allowed-tools` from frontmatter | `_meta["io.modelcontextprotocol.skills/<field>"]` on resources, `trust` in search/list/get_skill output, `Provenance:` line in get_skill text |
| `--no-scripts` (global) / `"noScripts": true` (per library) | Drops executable files (`.sh .bash .zsh .ps1 .psm1 .bat .cmd .py .js .mjs .cjs .ts .rb .pl .php`) from manifests, `resources/read` and `read_skill_file` | `scriptsWithheld` count, `_meta[".../scripts-withheld"]`, catalog status |
| Scan-time linter (`--no-lint` to disable) | Regex rules over text files ≤ 512 KiB: `pipe-to-shell`, `remote-exec`, `eval-decode`, `base64-blob`, `destructive-rm`, `world-writable`, `sensitive-path`, `credential-literal`, `env-exfil`, `prompt-injection`, `reverse-shell` | Catalog warnings, `_meta[".../risk-flags"]`, `riskFlags` in search/list results, per-finding `file:line` in get_skill plus a `⚠ Risk flags` banner in its text |

The linter labels, it does not block. Typical hits are `curl … | sh` install instructions for
third-party tools: legitimate, but worth knowing before a host runs them. Rules live in
`src/lint.ts`.

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
  script is run through its interpreter (`uv run scripts/extract.py`, `python scripts/extract.py`),
  never as `./extract.py`.

Hosts without SEP-2640 support reach skills through the tools, so this server repeats those rules
to the model. The server instructions, `get_skill` and the `use-skill` prompt label every skill with
its source server (`Source: <name> (MCP-served skill, not installed locally)`). Every file in
`get_skill` carries its `digest`; every script also carries its `interpreter` (`uv run` for a Python
file with a PEP 723 `# /// script` header, else `python`, `bash`, `node`, ... by extension) and, for
Python, `pep723: true|false`, in the structured output and in the text file list (`run with: uv run
(PEP 723)`). `read_skill_file` returns the same two fields for a script. When a skill or its
dependency closure bundles scripts, the text output also lists the digests and tells the model to
run scripts only from a verified local copy of the skill and the skills it depends on, because
scripts import or read their sibling files and those skills:

1. Copy the skill and its dependency closure into a cache folder that no host scans for skills,
   preferably with
   `skills-mcp pull --sync --keep-path --with-deps --to ~/.cache/skills-mcp-client/<server> <skill-path>`
   (`--url` or `--command` as the client is configured). No file content passes through the
   conversation, digests are verified, and re-running it each session is cheap thanks to `--sync`.
   Only when the CLI cannot run: `read_skill_file` per needed file of the skill and of each skill in
   its closure (the guidance names them), written byte-for-byte at its relative path and checked
   against the digests, never retyped.
2. Show the user what will run and get their approval. **The approval covers the skill and its
   dependency closure**, whose code runs too, and the guidance lists the closure
   (`acme/refunds, acme/context-pack`). A declared dependency the server does not serve is
   named with a warning.
3. Run each script with the full command the guidance renders, from the cached skill folder:

   ```
   cd ~/.cache/skills-mcp-client/acme/acme/refunds && SKILLS_ROOT=~/.cache/skills-mcp-client/acme/acme VAULT_PATH=<workspace> uv run scripts/refunds.py … --vault <workspace>
   ```

   * The interpreter is per file: `uv run` when the script has a PEP 723 header (it installs the
     inline dependencies; plain `python` does not), otherwise the one for its extension.
   * `SKILLS_ROOT` is always set, to the cached library (`<cache>/<ns>`), so a command written as
     `{skills.root}/<other>/scripts/x.py` runs the verified cache copy rather than a local install.
     It is library-agnostic; this server itself does not read `SKILLS_ROOT` (see
     [Configuration](#configuration)).
   * `VAULT_PATH=<workspace>` is added when the library is vault-shaped (a vault was detected) or the
     skill's text or scripts mention `VAULT_PATH` / `--vault`; `--vault <workspace>` is appended to
     a script whose source takes a `--vault` option. `<workspace>` is the user's vault or workspace,
     never the cache folder, which a script would otherwise take as its workspace.
   * Up to 8 commands are rendered (the script named after the skill first, test files left out);
     the rest follow the same form. `…` stands for the script's own arguments.

`read_skill_file` attaches a short version of these steps, with the digest and the interpreter, to
every executable file. Skill output (`get_skill`, `read_skill_file`, `use-skill`) only shows paths
relative to the skill folder, never where the skill lives on the server's disk.

### Runtime dependencies

A skill that runs another skill's code declares it in its SKILL.md body with a marker line, which
the server parses at scan time:

```
- [[context-pack/SKILL.md|context-pack]] — **runtime dependency.** Filed tasks use the pack's output.tasks.
- [[skillsmith/SKILL.md]] — **optional runtime dependency.** Used when present.
```

The link may carry an alias or not. Required dependencies form the closure: transitive, cycles
followed once, the skill itself excluded. Optional ones are reported but never pulled. They are
exposed as `_meta["io.modelcontextprotocol.skills/dependencies"] = {required, optional}` in
`skills/list`, `skills/get` and `resources/list`, and in `get_skill` as `dependencies`,
`dependencyClosure` (skill paths) and `missingDependencies` (required but not served), plus a
`Runtime dependencies:` line in its text. A required dependency that the library does not serve is
also a `catalog_status` warning.

**Dependencies resolve inside the skill's own library only; cross-library dependencies are not
supported.** An `acme` skill depending on `context-pack` is satisfied by `acme/context-pack`, never
by a `context-pack` in another namespace.

**`requires` is not a dependency list.** Frontmatter `requires` names external setup (tools, API
keys). It is still published as `_meta["io.modelcontextprotocol.skills/requires"]` for
compatibility, and `get_skill` returns it as `setup` with a `Setup (… not skills):` text line.

For skill authors this means:

* Reference scripts by path relative to the skill root, and show the interpreter in the command:
  `uv run scripts/extract.py input.pdf` (or `python scripts/extract.py`), not `./scripts/extract.py`
  or an absolute path.
* Do not rely on a script's executable bit, on symlinks, or on files outside the skill directory
  other than declared runtime dependencies, reached through `{skills.root}/<other>/` or as a sibling
  folder.
* Declare Python dependencies inline with a PEP 723 `# /// script` header, which `uv run` installs;
  a `requirements.txt` in the skill is optional. `.venv` and `node_modules` are never served.
* Declare every skill whose code yours runs with the runtime-dependency marker line above.
* Expect a host to ask the user before running anything, and write instructions that still make
  sense if the user says no.

`pull` into a cache folder, as above, keeps skills out of the host's reach as local skills. Pulled
with `--to` into a folder the host scans for skills, they become local skills instead: an explicit
install, not a cache. Pull only from servers you trust, or use `--no-scripts` on the serving side
to withhold scripts entirely.

## Spec conformance notes

* URIs are `skill://<skill-path>/<relative-path>`; the last skill-path segment equals frontmatter `name`.
  A warning is recorded when a directory name and its frontmatter `name` differ.
* `playbook://` and `value-chain://` are custom schemes, which the MCP resources spec allows
  provided they follow RFC 3986; path segments are percent-encoded and templates follow RFC 6570.
  They are separate from the SEP-2640 `skill://` scheme, and `skills/list` returns skills only.
* Digests are computed lazily and cached per file `mtime`, so `skills/list` is cheap after the first call.
* SEP-2640 limits (512 files, 16 MiB per skill) are enforced/flagged: file lists are truncated
  at 512 and oversized skills are listed in `<prefix>_catalog_status include_warnings=true`.
* `skills/get` answers for hidden (disabled) skills too, as the spec requires.
* A missing resource is a `-32602` error, as the current resources spec requires.

## Development

```bash
npm run test:unit   # 96 unit tests (in-memory MCP client, fixtures under test/fixtures)
npm run test:nested # nested-path fixture (skill://acme/billing/refunds/...)
npm test            # smoke test against a real library at $BOB_VAULT (prints SKIP when unset)
npm run test:gbl    # same smoke test against $GBL_VAULT
npm run test:all
```

The vault fixtures under `test/fixtures/vault` and `test/fixtures/vault2` are minimal vaults
(three skills, playbooks of every status, a private playbook that must never be served, a chain
file in each of the two formats); the unit tests also zip them on the fly to cover the release
layout.

```
src/config.ts       env/CLI configuration
src/frontmatter.ts  SKILL.md frontmatter parsing
src/catalog.ts      directory scan, file inventory, digests, change detection
src/archive.ts      zip-backed libraries: strict extraction, path/bomb/symlink defences, digest cache
src/remote.ts       remote libraries: https fetch, redirect/credential rules, digest verification
src/search.ts       ranked keyword search over name/description/tags/body
src/vault.ts        vault extras: playbook discovery/step parsing, value-chain definitions and coverage
src/server.ts       MCP wiring: extension methods, resources, tools, prompts
src/lint.ts         scan-time risk linter (labels, never blocks)
src/pull.ts         client: sync skills from a SEP-2640 server with digest verification
src/pack.ts         `pack`: build a distributable zip (skills, active core playbooks, chain file) from a vault
src/index.ts        entrypoint: `serve` (default; stdio or --http), `pull` and `pack`
test/unit/*.test.ts unit tests (config, frontmatter, catalog, search, server via InMemoryTransport, pull, hardening, archive, remote, vault, deps, tiers, pack)
test/smoke.ts       end-to-end test via a real MCP client (parametrised by root/name)
test/nested.mjs     nested-path + duplicate-name test against test/fixtures/nested
```

## ThirdBrain BOB specifics

Everything above applies to any skill library. This section holds what is particular to the
ThirdBrain Business Operating Brain (BOB) vault the server was built for.

**Vault layout.** A BOB vault keeps its skills at `00-CORE/Agents/skills/`, its shipped playbooks
at `00-CORE/Playbooks/`, company, personal and client playbooks at
`20-COMPANY/03-PROCESSES/Playbooks/`, `10-ME/Playbooks/` and `30-CLIENTS/<id>/Playbooks/`, and the
canonical chain definitions at `20-COMPANY/03-PROCESSES/value-chains.md`, with a generated
`VALUE-CHAINS.md` and `PLAYBOOKS.md` at the root. The playbook step grammar, the
`playbook-runner` skill, the runtime-dependency marker line and the `{skills.root}` / `VAULT_PATH`
conventions in the sections above come from BOB. The vault's own `vault-release` skill builds the
published packs; `skills-mcp pack` builds the MCP-served subset of one.

**Serving the live vault.** Point at the vault root, not the skills folder, to get playbooks and
value chains:

```bash
claude mcp add --scope user skills -- node /path/to/ThirdBrain-skills-mcp/dist/index.js \
  --lib bob=/path/to/brncx-skills \
  --lib gbl=/path/to/gbl-skills
```

This repository's `.mcp.json` does the same for one library: `node ${PWD}/dist/index.js --lib
bob=${BOB_VAULT:-/mnt/c/users/bruyn/documents/brncx-skills}`, so it works when the MCP client is
started in the repository folder after `npm run build`; set `BOB_VAULT` to point it at another
vault. The smoke tests read `BOB_VAULT` and `GBL_VAULT` the same way.

**Serving a release pack in a new vault.** Build the pack from the live vault, then reference it
from the new vault's `.mcp.json`:

```bash
skills-mcp pack --vault /path/to/brncx-skills --out bob-full-2026-09-25.zip
```

```json
{ "mcpServers": { "bob": { "command": "node",
  "args": ["/path/to/ThirdBrain-skills-mcp/dist/index.js", "--lib", "bob=/path/to/bob-full-2026-09-25.zip"] } } }
```

**Environment aliases.** `BOB_SKILLS_*` environment variables are still accepted as aliases of
`SKILLS_*`, and `BOB_SKILLS_ROOT` of `SKILLS_MCP_ROOT` (warned once as deprecated).

**Breaking change (after 1.3.0):** the root variable is `SKILLS_MCP_ROOT`; `SKILLS_ROOT` is no
longer read. BOB skills use `SKILLS_ROOT` as their own contract (the folder their scripts resolve
`{skills.root}` from), so a host exporting it for the skills and passing its environment to this
server gave the server a second, un-namespaced library: next to `--lib` it refused to start
(`--root cannot be combined with other libraries`), alone it silently served that folder.

**Measured on the live vault** (2026-09-23 unless stated; `--lib bob=<vault> --stats`):

| What | Figure |
|---|---|
| Skills served / hidden (`disable-model-invocation`) | 390 / 8 |
| Playbooks served / hidden (draft) | 86 / 4 (2026-09-25) |
| Value chains, from the canonical file | 14: 12 staged chains and the 2 buckets `operating-controls` and `infrastructure` |
| Skills declaring at least one required runtime dependency | 142 |
| `--exclude-tiers internal,private` | withholds 13 skills and 3 playbooks |
| Linter | 15 served skills flagged: 11 `curl … \| sh` install instructions, 2 that document prompt-injection phrasing, 1 test fixture with a sensitive path, 1 `env-exfil` match; a 16th, hidden skill for test fixtures |
| SEP-2640 limits | none exceeded: largest skill `nl-accounts-review` at 3.8 MiB, most files 166 |
| Files skipped (over size, symlink, dotfile) | none |
| Pack of the full vault (2026-09-25) | 398 skills, 86 playbooks, 1 chain file: 4427 files, 49 MiB, 24.9 MiB zipped; serves identically to the vault root |
| `pull --with-deps --keep-path bob/bob-marker-sweep` | writes `bob-marker-sweep` and `context-pack`; the rendered command runs from the cache with exit 0 |
