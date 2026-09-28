# Contributing

```bash
npm ci
npm run build
npm run test:all   # build, unit, nested, eras, conformance, smoke
```

- Node 20 or newer. CI runs Node 20, 22 and 24 on Linux, plus Node 24 on Windows.
- `npm test` (smoke) needs `BOB_VAULT` and is skipped without it; everything else runs on the
  bundled fixtures in `test/fixtures`.
- Add a regression test under `test/unit/` for every bug fix, using the fixtures or temp dirs with
  synthetic data only. Never commit real secrets or private vault content.
- Security-sensitive changes (paths, archives, credentials, HTTP) must be covered by a test that
  fails without the change. Report vulnerabilities per [SECURITY.md](SECURITY.md).
- Keep README and `server.json` versions in step with `package.json`.
