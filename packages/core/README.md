# @casita/core

The engine: everything the system knows and every path state and commands take.

## Owns

- `src/types.ts`: the public contract. Integrations depend on this file only.
- Event bus, registry (devices, entities, areas, rename aliases), state store.
- Command router: resolve, availability, normalize, validate, policies, per-entity queue, confirm.
- Recorder: batched history writes, rollups, retention; database backup.
- Config store (`config.toml`), scheduler, integration host.
- Casa (`src/casa/`): the page language, its compiler, the page, theme and automation stores,
  and the runtime that arms every server handler.
- SQLite schema: `src/db/migrations/`, numbered files, never edited after release.

## Rules

- State flows up, commands flow down. Only the state store writes state; only the router dispatches commands.
- Each service is a class with an explicit dependency object. No globals, no container.
- Errors crossing a module boundary are `CoreError` or `CommandError`, each with a `code`.

## Must not import

- `@casita/api`, `@casita/cli`, `@casita/server`, or anything under `integrations/`.
- Node-only APIs. Use Bun built-ins (`bun:sqlite`, `Bun.file`, `Bun.Glob`).
