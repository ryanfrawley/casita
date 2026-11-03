# @casita/cli

The `casita` command: a thin client over the WebSocket API.

## Owns

- `src/main.ts`: every subcommand, including `casita repl`.
- `src/format.ts`: tables, state summaries, flag parsing.
- `src/oneshot.ts`: the human one-shot commands (`light`, `switch`, `lock`, `ls`, `car`, `sensors`).
- `src/dash.ts`, `src/dash-run.ts`: the dashboard; layout is a pure function, I/O is separate.
- `src/chart.ts`: the ASCII history chart in a sensor's detail view.
- `src/present.ts`, `src/style.ts`: terminal styling for how state reads; the words come from
  `@casita/client`, as does `CasitaClient`.

## Rules

- Every API request type has a subcommand; nothing here reaches the core directly.
- Tables by default, `--json` on every read command.
- Exit codes: 0 success, 1 server-side error (the code is printed), 2 usage or connection error.
  The one-shot commands add 3: the device did not do what was asked.

## Must not import

- `@casita/core` (types included), `@casita/server`, or anything under `integrations/`.
  Only `@casita/api/schema` and `@casita/client`.
