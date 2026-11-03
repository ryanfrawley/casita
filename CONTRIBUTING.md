# Contributing

## Checks

```sh
bun test                              # everything, under 30 seconds, no network or hardware
bun run typecheck                     # the server and CLI, then the browser packages
bunx biome check --error-on-warnings .
```

Commit messages are `area: short imperative summary` (`router: add button.press`).

## Adding a domain or capability

A domain or capability touches every layer. Work through all of these:

- [ ] `packages/core/src/types.ts`: the state type, its place in `EntityState` and `DOMAINS`, its
      commands in `Command`, and any new field in `Capabilities`.
- [ ] `packages/core/src/router.ts`: `normalize` (clamping, defaults), `validate` (capability and
      range checks), and `satisfies` (how a state report confirms each command).
- [ ] `packages/core/src/router.test.ts`: a normalization row and an error-code case for each new rule.
- [ ] `packages/core/src/recorder.ts`: `measure`, if the state has a numeric or boolean reading to roll up.
- [ ] `packages/api/src/schema.ts`: `commandSchema`. It must still satisfy `z.ZodType<Command>`.
- [ ] `packages/cli/src/format.ts`: `summarize`, so `casita entities` and `casita watch` can show it.
- [ ] `packages/client/src/present.ts`: `present`, the words the CLI dashboard and the web app show.
- [ ] `packages/web/src/model.ts`: `DOMAIN_LABEL`, `GROUP_NAME`, and `historyView` if it has a history.
- [ ] Each integration that can supply it, with a fixture and a test.
- [ ] `CHANGELOG.md`.

## Adding an integration

- A package under `integrations/` exporting `defineIntegration({ id, name, version, configSchema, setup })`.
- It imports from the core only through `@casita/core/types`; `tests/boundaries.test.ts` enforces this.
- A fake transport under `test/`, and at least: discovers a device from a fixture, reports state on
  a transport message, delivers a command, marks entities unavailable on disconnect, cleans up on abort.
- Fixtures under `tests/fixtures/<integration>/`, named `*.synthetic.*` until recorded from real devices.
- Add it to the catalog in `packages/server/src/main.ts` and to `DEPENDENCIES.md` if it brings packages.

## Changing the web app

- Wording for a state belongs in `packages/client`; a layout or validation rule in
  `packages/web/src/model.ts`, `forms.ts` or `access.ts`, as a pure function with a test. Screens
  hold neither.
- A component comes from `packages/ui`. Its CSS is the design system's; change the design system
  and port the change, don't edit the copy.
- Nothing is shown ahead of the house: send the command, show pending, and let the state change
  when the device reports it.
- A page is a `Page` in `app.tsx`; its path may name a part (`/edit/:id`, matched by
  `routes.ts`), and `hidden: true` keeps it out of the navigation.
- Home is a Casa page (`packages/core/src/casa/`, spec in `docs/casa-page-language.md`). A new
  built-in is an entry in `builtins.ts` (its properties and types) and a renderer in
  `packages/web/src/casa/builtins.tsx`; a new function is an entry in `functions.ts`. Every
  diagnostic code has a fixture in `compile.test.ts`.
- An automation is a Casa `automation` declaration (`casa/automations.ts` stores it,
  `casa/runtime.ts` runs it). A new trigger or statement is grammar in `parser.ts`, a check in
  `check.ts`, and a case in `runtime.ts`; a new "New automation" template is an entry in
  `packages/web/src/automations.ts`, and its test compiles every template.
- A derived sensor is a Casa `sensor` declaration (`casa/sensors.ts` stores it,
  `casa/derived.ts` computes it and reports it as an entity of `casa.sensors`). Its `value`
  is checked with `inputsOnly` in `check.ts`; a new output type is a case in `SENSOR_TYPES`
  there and in `stateOf` in `derived.ts`. "New sensor" templates are in
  `packages/web/src/sensors.ts`.

## Adding an API request

Schema entry in `packages/api/src/schema.ts`, handler in `packages/api/src/server.ts`, a line in
`ADMIN_ONLY` if it is admin-only (and in the list in `tests/permissions.test.ts`), and a subcommand
in `packages/cli/src/main.ts`, and a use in `packages/web` (`tests/web-parity.test.ts` checks).
