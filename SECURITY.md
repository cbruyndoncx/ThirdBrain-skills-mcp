# Security policy

## Supported versions

Only the latest published minor version receives security fixes.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/cbruyndoncx/ThirdBrain-skills-mcp/security/advisories/new).
Do not open a public issue. Include the version, a minimal reproduction using synthetic files, and
the impact. Expect an acknowledgement within a few days.

## Scope

In scope: path containment (serving, `pull`, `pack`), archive extraction, credential handling for
remote libraries, HTTP Host/Origin validation, and integrity checks (sha256 pins, manifest digests).
Out of scope: the content of skills you choose to serve, and deployments that expose the HTTP
transport without authentication (see the README hardening section).
