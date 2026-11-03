# @casita/server

The entrypoint: one process that wires core, API, and integrations together.

## Owns

- `src/app.ts`: `createApp`, the composition root, also used by the integration tests.
- `src/main.ts`: the integration catalog, signal handling, and the shutdown deadline.

## Rules

- `requirePermission` is registered on the router before anything else.
- Shutdown order: API, page and automation handlers, integrations, recorder flush, database.
- SIGTERM must end the process within 5 seconds.

## Must not import

- Nothing is off limits here, but no logic lives here either: this package only wires.
