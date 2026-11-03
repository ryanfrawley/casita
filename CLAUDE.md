# Casita

Bun monorepo; the server runs from TypeScript source, only the web UI is built. Dev checks,
commit message format, and how to add a domain, integration, or API request are in
`CONTRIBUTING.md`; setup and configuration are in `README.md`. This file is what an agent can't
learn from the code.

## Running and deploying

- `bun run start` is the whole server. There is no build step for it; `bun run web:build` builds
  the web app into `packages/web/dist/`, which the server serves when it exists.
- Deployment is whatever the operator chooses: a git clone plus a process supervisor is enough.
  There is no deploy pipeline in this repo. A maintainer's own deploy notes belong in
  `CLAUDE.local.md`, which is gitignored, never here.
- Before claiming a change works, run `bun test`; it needs no network or hardware.

## State that survives a deploy

- `config/config.toml` (gitignored) is read at start and rewritten by the server when config is
  set through the API, so comments in it are not preserved. `config/config.sample.toml` is the
  template and documents every integration's fields.
- `data/` (gitignored) holds the SQLite database and its backups.

## Secrets

`config/config.toml` holds real API keys and is gitignored; never commit it or paste its keys
into commits, tests, or fixtures. Fixtures are synthetic (`*.synthetic.*`) and must stay so:
no real coordinates, serials, MAC addresses, keys or account names.
