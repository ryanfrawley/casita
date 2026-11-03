# @casita/client

What every client of the API shares: the WebSocket client, and how state reads to a person.

## Owns

- `src/client.ts`: `CasitaClient`, used by the CLI, the web app, and the integration tests.
- `src/present.ts`: the words for a state ("On · 40%", "Jammed"), its tone, and the vehicles
  among the entities. No colors: the CLI and the web app each map a tone to their own.
- `src/units.ts`: the unit system readings are shown in.

## Rules

- Runs in a browser and under Bun: no `Bun.*`, no `node:` modules, no terminal codes.
- The words for a state are decided here and nowhere else.

## Must not import

- Anything in the workspace except `@casita/api/schema`. `tests/boundaries.test.ts` enforces this.
