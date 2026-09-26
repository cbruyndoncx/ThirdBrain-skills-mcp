# Code, documentation, and registry readiness review

Reviewed 2026-09-26 at commit `f25ec14` (version 1.5.0), on Node 24.21.0/Linux.

**Historical review of version 1.5.0.** The findings below describe the state at commit `f25ec14`.
The current worktree contains fixes targeted at all numbered findings, plus focused regression
coverage and a candidate `server.json` for version 1.5.1. The original evidence and triggers are
kept here so the changes can be audited. Public package and registry publication remain separate
release actions.

## Verified checks

| Check | Result |
| --- | --- |
| Clean locked dependency install and TypeScript build | Passed |
| `npm run test:unit` | 96 passed, 0 failed |
| `npm run test:nested` | Passed |
| `npm run test:eras` | Legacy, pinned modern, and automatic negotiation passed |
| `npm run test:conformance` | Modern enumeration 32/32, manifest 6/6, directory 7/7; legacy 30/30, 6/6, 7/7 |
| `npm test` | Explicitly skipped: no `BOB_VAULT` supplied |
| `npm pack --dry-run --ignore-scripts --json` | Includes compiled CLI, README, license, and package metadata; 29 files |
| Public npm metadata for `thirdbrain-skills-mcp` | Returned E404 at review time |

The initial installed dependencies were stale. A clean install resolved the initial missing-module build errors. Dependency downloads and socket-based tests required execution outside the restricted sandbox. The official conformance suite was fetched at the repository's pinned commit into `/tmp/thirdbrain-review-conformance`.

Additional reproductions used only synthetic files, a fake token, mocked archive responses, and local fixture servers. Their scripts are available for this workspace session at `/tmp/thirdbrain-review.mjs` and `/tmp/thirdbrain-review-extra.mjs`. No real secrets were used. Windows execution, Node 20 compatibility, and the live BOB/GBL vaults were not tested.

## Priority 1 — resolve before submission

### 1. HTTP accepts untrusted Origin and Host headers

Location: [src/index.ts:60](src/index.ts#L60).

The HTTP route passes requests directly to the SDK handler without Origin or Host validation. A local reproduction sent `Origin: http://untrusted.example` and `Host: untrusted.example`; `initialize` returned HTTP 200 with server information. This leaves the local HTTP server exposed to DNS rebinding scenarios. Binding to loopback alone does not provide the missing validation.

Add an explicit allowlist before the handler, using the SDK's Origin/Host helpers, and verify rejection on both protocol paths. The [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) requires rejection of invalid Origins. Document authentication requirements when operators change `SKILLS_HOST` to expose private libraries beyond loopback.

### 2. Ambient GitHub credentials are sent to arbitrary library hosts

Locations: [src/config.ts:388](src/config.ts#L388), [src/catalog.ts:648](src/catalog.ts#L648), [src/remote.ts:81](src/remote.ts#L81).

Configuration automatically selects `GH_TOKEN` or `GITHUB_TOKEN`, and every remote library fetch receives that token. The fetcher treats whichever host begins the request as authorized. Redirect stripping works, but does not prevent disclosure to an unrelated initial host. A public vendor URL can therefore receive an ambient GitHub credential merely because it is present in the server environment.

The mocked vendor request received `Authorization: Bearer FAKE_REVIEW_TOKEN`. Scope credentials to explicit library origins; restrict automatic GitHub token use to intended GitHub endpoints. Test mixed public/private libraries and sidecar requests as well as redirects.

### 3. Playbook attachments escape the library through symlinks

Locations: [src/vault.ts:426](src/vault.ts#L426), [src/pack.ts:146](src/pack.ts#L146).

Attachment checks reject path separators but use `stat`, which follows symlinks. A playbook embedding `![[leak.txt]]`, where `leak.txt` points outside the vault, exposes the external target as a resource. The same attachment is copied into distributable packs. Reproductions recovered `OUTSIDE_FIXTURE_MARKER` both from the catalog attachment and from a newly packed/extracted library.

Apply a shared filesystem containment policy to serving and packing: reject symlinks, validate resolved ancestors, and protect the actual file read. Also audit conventional vault directory and chain-file probes, which use following `stat` calls. The README's claim that the root is the boundary is currently too strong.

### 4. `pull --sync` can write and delete outside its destination

Location: [src/pull.ts:119](src/pull.ts#L119), especially writes at line 158 and stale-file removal at line 167.

The lexical prefix check does not account for existing symlinks. With `<destination>/beta` linked to a separate temporary directory, pulling the ordinary `beta` fixture with `--sync` wrote `SKILL.md` outside the destination. Stale-file enumeration also follows a symlink used as the skill root, making deletion outside the destination possible. Linked parent directories can affect `--force` writes too.

Reject symlinked destination components and use safe exclusive temporary-file creation with containment checks for writes and deletions. Resource paths also need platform-independent validation: the current slash-only check permits decoded backslashes, which become separators on Windows. That Windows case was identified statically, not executed.

### 5. Remote SHA-256 pins are not enforced across cache reuse

Locations: [src/catalog.ts:638](src/catalog.ts#L638), [src/remote.ts:161](src/remote.ts#L161), [src/archive.ts:304](src/archive.ts#L304).

Two separate paths weaken the pin:

- The in-process remote cache is keyed only by URL. After a successful scan, changing the configured pin to 64 zeroes and rescanning still served the old archive; no new fetch or mismatch occurred. This contradicts the source comment that changing the pin picks up a new version.
- A cached download is accepted by filename and `stat` alone. Replacing its bytes with a marker still returned `cached: true` and the original claimed digest. Extraction computes a new digest but never compares it with the requested pin. Existing extracted trees are also reused without checking their contents.

Key remote state by URL and expected digest, reject incompatible fallback state, and revalidate cached data or enforce a documented immutable, private cache design. Never return a verification result based only on a digest-shaped filename.

### 6. Hot reload can reverse an explicit CLI restriction

Location: [src/config.ts:246](src/config.ts#L246).

Start with `--no-scripts` and a config containing `"noScripts": false`: startup correctly withholds scripts, but the first reload assigns `false` and re-enables them. The reproduction changed `cfg.noScripts` from `true` to `false`. Similar unconditional assignments affect the playbook/value-chain switches.

Preserve CLI/environment overrides separately and recompute effective configuration with the same precedence at startup and reload. Add regression coverage around the policy that clients actually observe after a reload.

## Priority 2 — correctness and release reliability

### 7. One server deletes another server's active archive cache

Locations: [src/catalog.ts:436](src/catalog.ts#L436), [src/archive.ts:332](src/archive.ts#L332).

The default cache is shared, but each catalog prunes it using only that catalog's known digests. Scanning archive B after archive A with the same cache removed A's still-referenced files. Requests against A can then fail until another scan, and simultaneous extraction can lose its temporary tree. The unit tests explicitly isolate caches to avoid this collision.

Use leases/ownership and safe garbage collection, isolate caches per server, or stop automatically deleting other digests during scans. Do not delete active temporary directories based solely on their prefix.

### 8. Attachment serving bypasses content restrictions

Locations: [src/vault.ts:426](src/vault.ts#L426), [src/catalog.ts:559](src/catalog.ts#L559).

Attachments receive only a filename and size check. A playbook embedding `run.py` still exposes that script with global `noScripts=true`, as reproduced. Dotfiles and archive extensions also lack the filtering applied to skill files, and attachments are not passed through the skill linter. Thus users can receive content that the hardening documentation leads them to expect is withheld or inspected.

Apply the relevant library policy to attachments, or explicitly narrow the contract and provide equivalent protection for this surface. Cover both resources/read and pack output.

### 9. Invalid skill metadata is published through the extension

Locations: [src/catalog.ts:706](src/catalog.ts#L706), [src/catalog.ts:724](src/catalog.ts#L724), [src/server.ts:165](src/server.ts#L165).

A directory named `wrong` with frontmatter `name: different` and no description is still published as `skill://wrong/SKILL.md`, with that invalid frontmatter. Warnings and display fallbacks do not repair the extension entry. An oversized `SKILL.md` is filtered from the file inventory but still parsed and can produce an entry without its required root resource. Arbitrary truncation at 512 files can also produce an unusable partial bundle.

Validate before publication and withhold invalid skills with actionable warnings. The [stable Skills specification](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx) requires matching URI/name, required frontmatter, and a complete manifest including `SKILL.md`. Its size ceilings are host support guarantees; exceeding them is a SHOULD NOT, not a blanket MUST violation. Report that distinction accurately rather than treating truncation as proof of conformance.

### 10. Pulling duplicate names silently merges their destinations

Location: [src/pull.ts:117](src/pull.ts#L117).

With both fixture libraries, `pull --all --sync` without `--keep-path` reported four skills (`a/alpha`, `a/shared`, `b/beta`, `b/shared`) but created only three directories. Both `shared` skills target the same location; the later sync overwrites/deletes the earlier skill's files. Without sync, the second skill is skipped instead.

Preflight destination collisions and fail with guidance to use `--keep-path`, or preserve full identity by default. The stable specification explicitly allows repeated names at different paths.

### 11. Empty configuration reload is not atomic

Location: [src/config.ts:244](src/config.ts#L244).

Reloading `{"libraries":[]}` clears `cfg.libraries`, then throws while reading `next[0].root`. The reproduction leaves zero libraries after the error. The entrypoint nevertheless logs that it is keeping previous libraries, then scans the mutated configuration. This contradicts the README's rollback guarantee and can empty a running server.

Validate the complete next configuration before mutating live state. Decide explicitly whether an empty library set is supported; either commit it safely or reject it without changing the old state. Also reject missing roots before converting them with `String(l.root)`.

### 12. Content changes do not reliably trigger notifications

Locations: [src/catalog.ts:600](src/catalog.ts#L600), [src/catalog.ts:516](src/catalog.ts#L516).

Skill change detection compares SKILL.md mtime, file count, and total size, ignoring supporting-file paths and mtimes. Replacing a supporting file's three bytes with different three bytes, and advancing its mtime, produced zero change notifications. Playbook attachment changes similarly compare only attachment count. Hosts relying on notification-driven refresh can retain stale manifests.

Compare a fingerprint of all served resource identities and content versions, including hidden entries where applicable. Include library metadata and value-chain content that is advertised as refreshable.

### 13. Disabling extras can also hide skills in wrapped vaults

Locations: [src/catalog.ts:432](src/catalog.ts#L432), [src/vault.ts:179](src/vault.ts#L179).

When both extras are disabled, `detectLayout` is called with `false` and skips skill-root normalization as well. A wrapped pack's `release/00-CORE/Agents/skills/<skill>` exceeds the default discovery depth. The fixture pack served zero skills with `--no-playbooks --no-value-chains`.

Separate locating the skills directory from enabling vault extras. Test wrapped and unwrapped vaults with every opt-out combination.

### 14. Pull's integrity validation is incomplete

Locations: [src/pull.ts:41](src/pull.ts#L41), [src/pull.ts:153](src/pull.ts#L153).

Static inspection: manifest digests accept any string, an empty digest skips verification, and returned byte length is never compared with the declared size. The manifest also lacks completeness/duplicate-resource checks. The stable Skills specification requires both size and digest verification on reads; the README describes the client as digest-verifying without these qualifications.

Validate static manifests before writing, require properly formatted digests, and check both returned size and hash. Treat dynamic content as an explicit separate policy rather than silently presenting it as verified. Also qualify the claim of support for “any” SEP-2640 server: `skillPathOf` strips only `skill://`, although the extension permits other URI schemes.

### 15. “Deterministic zip” is not the actual pack contract

Locations: [src/pack.ts:234](src/pack.ts#L234), [test/unit/pack.test.ts:40](test/unit/pack.test.ts#L40), README pack sections.

`pack.json` embeds the current timestamp, so identical inputs produced different archive hashes in the reproduction. The test labeled deterministic excludes that manifest and compares extracted source files, not archives.

Either use a reproducible build timestamp, such as an explicit input/SOURCE_DATE_EPOCH, or describe deterministic ordering and preserved source bytes without claiming byte-identical archives.

## Registry submission route

There are two relevant destinations:

1. **Official MCP Registry:** publish metadata for this installable server. For the npm route, the [official package requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx) require public npm distribution and a package `mcpName` matching the registry identity. The [publishing guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx) describes `server.json`, namespace authentication, validation, and publication. The repository currently has no `server.json` or `mcpName`; its unscoped package returned E404. GitHub-based `npx` usage in the README does not supply the npm registry artifact.
2. **Skills working-group implementations list:** a separate, community-maintained list in the official extension repository. It currently invites a PR adding a short row. ThirdBrain was not present in the inspected [implementations list](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/implementations.md). Inclusion is separate from registry publication and does not constitute certification.

For an npm submission after the fixes:

- Choose an identity such as `io.github.cbruyndoncx/thirdbrain-skills-mcp` and add the same `mcpName` to the published package.
- Add `server.json` with the chosen identity, release/package version, public npm identifier, repository, stdio transport, and a required `SKILLS_MCP_ROOT` setting or equivalent package argument. The server requires a library; registry-installed clients need a way to configure it.
- Use a built public npm package. Test the actual tarball in an empty directory before publication, including the binary. The current `main: "index.js"` names an absent file: remove it for a CLI-only package or define a deliberate import entry point.
- Validate the manifest with the current publisher CLI, authenticate for the namespace, publish, and verify the resulting public registry record. These are future release steps; none were performed in this review.
- Optionally submit the working-group row describing the server as a community implementation and linking its reproducible conformance evidence.

## Documentation and maintenance follow-up

The README's usage-first layout and explicit separation of BOB conventions are useful. Before release, align its boundary, verification, reload, and determinism claims with the fixes above. Keep the measured conformance table, while explaining that those scenarios do not cover every input or security boundary.

Add a minimal fixture-based quick start so users can exercise the server without a private vault. Describe the HTTP trust model, credential scoping, cache ownership, and the difference between hiding disabled skills (still available via `skills/get`) and excluding tiers (withheld). Label runtime dependency markers and playbooks as project conventions rather than extension requirements.

The repository has no CI workflow, security reporting policy, or contributor guide. These are maintenance recommendations, not official registry prerequisites. A useful release gate would run the existing fixture tests, the pinned skills scenarios, targeted regressions for the findings above, and a packaged-install check on the minimum supported Node version and a current version. Add Windows coverage if continuing to promise portable CLI behavior.

This document records the original review. See the worktree diff and current test results for the
remediation; publishing the package and registry entry remains a release action.
