# Web UI plan

Status: all ten phases are built; see `CHANGELOG.md` for what each added and where it departs
from this plan. Left open: an automated browser test, tiles in place of rows on a phone, and the
request console that would stand in for `casita repl`.

Goal: a working web application, served by the Casita server, that does everything the `casita`
CLI does and looks like the Casita design system. Built in ten phases; the first four produce the
whole design system as a package, the rest build the app on it.

Design source: the "Casita" design system artifact
(a private Claude artifact of the maintainer, version `1791169322-80db`, last changed
2026-10-05). Read its `project/README.md` first; it is the brand book. It holds 23 colour tokens in
two themes (Day, Night), 8 text styles, 6 spacing steps, 3 radii, 2 shadows, 3 logos, 76 Lucide
icons, and 40 React 18 reference components in `components/bundle.js` + `bundle.css` (class prefix
`ca-`). Its own instruction for consumers: "port them, keep the class names and token use."

## What exists today

- The API is ready for a UI. One WebSocket (`/ws`) carries 40 request types and live events;
  schemas are in `packages/api/src/schema.ts`. HTTP has login, OIDC, logout, `history.csv`, `schema`.
- The spec lists the web UI as post-milestone-1 work, built "against the API … without touching
  the core". This plan touches `packages/api` and `packages/server` in two small places (below) and
  the core not at all.
- The CLI is the only client. Its dashboard (`dash`) and one-shot commands hold the logic for how
  state reads to a person (`present.ts`, `units.ts`, `format.ts`), mixed with terminal styling.

## Three problems to solve before any screen

1. **The wire schema does not bundle for a browser.** `schema.ts` imports `DOMAINS` and
   `retentionPolicySchema` from `@casita/core`, whose index re-exports the database, logger and
   host. `DOMAINS` is in `types.ts` (safe); `retentionPolicySchema` is in `config.ts` (not). Fix:
   move `retentionPolicySchema` into a side-effect-free core module and have `schema.ts` import
   only from that and `@casita/core/types`. A test bundles `schema.ts` for the browser target and
   fails if `bun:sqlite`, `pino` or `node:` modules appear.
2. **A browser cannot log in safely or with OIDC.** The server accepts only `Authorization: Bearer`,
   and the OIDC callback answers with JSON, which leaves a browser on a page of JSON. Fix: login
   and the OIDC callback also set an `HttpOnly; SameSite=Strict` session cookie; `/ws` and the HTTP
   routes accept it; `/ws` checks `Origin` when authenticating by cookie; the OIDC callback
   redirects to `/` when the flow began in a browser. Bearer tokens keep working for the CLI.
3. **Presentation logic would be written twice.** Fix: a new `packages/client` holding the
   WebSocket client and the terminal-free halves of `present.ts`, `units.ts` and `format.ts`
   (state words, tones, unit conversion, car grouping). The CLI and the web app both import it, so
   "On · 60%" and "Turning on…" are decided in one place.

## Packages

| Package | Holds | May import |
| --- | --- | --- |
| `packages/client` (new) | `CasitaClient`, state words, units, groupings | `@casita/api/schema` |
| `packages/ui` (new) | tokens, fonts, icons, logos, every component, the gallery | `react` only |
| `packages/web` (new) | store, routes, screens, build script | `@casita/ui`, `@casita/client`, `@casita/api/schema` |
| `packages/api` | cookie auth, static file route | unchanged rules |
| `packages/server` | passes the built web directory to the API | unchanged rules |

`packages/ui` knows nothing about the API; `packages/web` never reaches the core. Both rules go in
`tests/boundaries.test.ts`.

## Stack

- React 18 and react-dom (MIT), TypeScript, plain CSS with the design system's `ca-` classes.
- Bun's bundler and dev server (`Bun.build`, HTML entry). No Vite, no CSS framework.
- No router or state library: a small history router and one store read with
  `useSyncExternalStore`. The store is a pure reducer over server messages, like `dash.ts` is a
  pure function over `DashData`.
- Tests with `bun test`: reducers and formatters as plain unit tests, components rendered with
  `react-dom/server` and asserted on markup; `happy-dom` (MIT, dev) for the few that need events
  and focus.
- New entries in `DEPENDENCIES.md`: react, react-dom, @types/react, @types/react-dom, happy-dom.

## Phases

Every phase ends with `bun test`, `tsc` and `biome` green, tests for the new code, and a
`CHANGELOG.md` entry.

### Phase 0 — Foundations

- Fix problem 1 (browser-safe schema) with its bundle test.
- Scaffold `packages/client`, `packages/ui`, `packages/web` with tsconfigs that add `DOM` and
  `react-jsx`; extend the boundary test; add `bun run web:dev` and `web:build`.
- Extract `packages/client` from the CLI (problem 3). The CLI's tests must pass unchanged.
- Done when: an empty React page builds, and the CLI runs on `@casita/client`.

### Phase 1 — Design system: tokens, type, assets

- Vendor `tokens.json` into `packages/ui`; generate `tokens.css` from it (Day on `:root`, Night
  under `[data-theme="dark"]` and `prefers-color-scheme`), with a test that the generated file is
  current and that every text pair the token notes name meets 4.5:1.
- Text styles as classes; fonts (Fraunces, Figtree, JetBrains Mono) self-hosted as woff2.
- The three logos and the icon set: icon paths as a typed map (`ICON_NAMES`, `DOMAIN_ICON`,
  `DEVICE_ICON`, `WEATHER_ICON`), app icon as favicon and PWA icon.
- Base CSS: focus ring, reduced motion, the hatch pattern for unavailable.
- The gallery: a dev-only page listing tokens, type, icons and (from phase 2) every component in
  both themes. It is the review surface for the port.
- Done when: the gallery's foundations pages match the artifact's in Day and Night.

### Phase 2 — Design system: base components

Port to TSX, keeping class names, props (`index.d.ts` is the contract) and keyboard behaviour; move
each component's CSS out of `bundle.css` beside it.

- Actions: `Icon`, `Button`, `IconButton`, `Menu`
- Forms: `TextField`, `Select`, `Combobox`, `Checkbox`, `Toggle`, `Slider`, `Stepper`,
  `SegmentedControl`, `Pill` / `PillGroup`
- Overlays: `Dialog`, `Sheet`, `Toast` / `ToastRegion` / `useToasts`
- Navigation: `SideNav`, `Tabs`
- Status: `Badge`, `StatusDot`, `EmptyState`, `Skeleton`
- Content: `DataTable`, `Timestamp` (+ `formatTime`, `formatDuration`), `CopyChip`, `CodeView`,
  `RangeBar`
- Done when: each has a gallery entry reproducing its `preview.html`, a test for its states, and
  keyboard and focus tests for the overlays, `Menu`, `Combobox`, `Tabs` and `Slider`.

### Phase 3 — Design system: charts, Casita components, exemplars

- Charts: `ChartFrame`, `ChartLegend`, `TimeSeriesChart`, `TimeSeriesCard`, `TimeAxis`,
  `StateTimeline`, `StateHistoryCard`, `LevelMeter`. Scale and tick maths as pure, tested
  functions; gaps hatched, never interpolated.
- Casita components: `EntityTile`, `EntityRow`, `DeviceCard` / `DeviceSection`, `Area` (masonry
  grid), `IntegrationRow`.
- Exemplars: `Thermostat`, `SceneButton`, `Forecast`.
- Done when: the gallery covers all 40 components and a side-by-side check against the artifact's
  previews finds no visual difference in either theme. **The design system is complete here.**

### Phase 4 — Server support and the live store

- Fix problem 2 (cookie session, `Origin` check, OIDC redirect), with tests in `tests/api.test.ts`
  and `tests/oidc.test.ts`.
- The API serves the built app: `GET /` and unknown non-`/api` paths return `index.html`, hashed
  assets are cached, and a content security policy allows only same-origin scripts and `/ws`.
  `[server] web = false` turns it off.
- The store: connect, authenticate, `subscribe` with snapshot, apply events, reconnect with
  backoff, follow `server.units`. Commands are tracked as pending from send until the confirmed
  result; nothing is shown optimistically.
- Done when: a test drives the store against the real server with the demo integration (through
  `tests/harness.ts`) and sees snapshot, an event, a confirmed command, a failed command and a
  reconnect.

### Phase 5 — Shell, login, Home

- Login page (password and OIDC buttons), logout, the `SideNav` shell with the nine sections, Day
  / Night switch, connection state, `Toast` region, page-level `EmptyState` and `Skeleton`s.
- Home, matching `casita dash`: one `Area` per room with `DeviceCard`s, thermostat, locks,
  vehicles, irrigation zones, recent events. Controls for all eight domains. An entity's detail
  `Sheet` shows its history for the last hour, 24 hours or 7 days.
- Permissions as the design says: unreadable entities are absent, read-only ones say "View only".
- Covers CLI: `login`, `logout`, `whoami`, `status`, `dash`, `ls`, `sensors`, `car`, `light`,
  `switch`, `lock`, `cmd`, `area cmd`, `watch`, `state`.
- Done when: every dashboard behaviour in `dash.test.ts` has a counterpart on Home, shown working
  in a browser against the demo integration.

### Phase 6 — Entities, Devices, Areas

- `DataTable` lists with `PillGroup` filters, search, ids as `CopyChip`s, detail in a `Sheet`.
- Edit: rename, change id, area, hidden, disabled, retention; delete with a naming `Dialog`;
  orphaned entities shown and removable; area add, rename, remove.
- Covers CLI: `entities`, `devices`, `rename`, `entity set`, `device set`, `area list|add|rm`.

### Phase 7 — History

- Entity picker (`Combobox`), range, resolution; `TimeSeriesCard` for numeric entities with the
  target as a stepped second series, `StateHistoryCard` for stateful ones; CSV download.
- Covers CLI: `history`, the `history.csv` route.

### Phase 8 — Integrations, Automations, Settings

- Integrations: `IntegrationRow`s, reload, and a form for each integration action generated from
  its JSON Schema (permit join, inclusion, Rachio and Tesla actions).
- Automations: list, last run and errors, reload.
- Settings: units, time zone and history retention as forms; the full config as a path-addressed
  editor validated against the config schema; backup; an About block from `get_status`; the
  protocol schema in a `CodeView`.
- Covers CLI: `integrations`, `integration action|reload`, `automations`, `automation reload`,
  `config get|set`, `schema`, `backup`.

### Phase 9 — Users and access

- One page as the design lays it out: users on the left, the selected user's grants on the right,
  each grant a scope with a None / Read / Control `SegmentedControl` and the resolved level.
- Create, disable, change role, reset password, remove; API tokens (shown once, in a `CopyChip`);
  sessions with revoke; the audit log as a table.
- Covers CLI: `user *`, `grant *`, `token *`, `audit`, plus `list_sessions` / `revoke_session`.

### Phase 10 — Parity, access, small screens

- A parity test: every `RequestType` in the schema is sent somewhere in `packages/web`, the same
  rule the CLI README states for subcommands.
- Accessibility pass: keyboard through every screen, focus return from overlays, live regions for
  pending and errors, contrast in both themes, `prefers-reduced-motion`.
- Phone and wall-tablet layouts (one-column areas, `EntityTile` grids, 44px targets), PWA manifest.
- A browser smoke test of login → toggle a light → see it confirmed, against the demo integration.
- READMEs for the three new packages, `CONTRIBUTING.md` checklist lines for the web UI.

## Not mirrored, and why

- `casita repl`: a terminal convenience. If wanted, a request console under Settings is a small
  addition after phase 8.
- Scenes, the alarm, weather and appliance cards: the core has nothing behind them yet
  (`CHANGELOG.md` says the same of the CLI). `SceneButton` and `Forecast` are still ported in
  phase 3 so the design system is whole, but no screen uses them.

## Decisions taken here; say if you want them changed

| Decision | Chosen | Alternative |
| --- | --- | --- |
| Session in the browser | HttpOnly cookie (needs the phase 4 server change) | Token in `localStorage`: no server change, but readable by any script on the page, and OIDC still needs a redirect |
| Fonts | Self-hosted woff2, so the wall tablet works with no internet. All three are OFL, which needs an entry under Exceptions in `DEPENDENCIES.md` | Google Fonts, as the design system loads them: no licence entry, but the UI depends on the internet |
| Build tool | Bun's bundler, per the spec's "Bun built-ins first" | Vite: better dev experience, a large dependency tree |
| Phone and tablet layouts | Last (phase 10); the design names desktop admin as the first surface | Earlier, if the wall tablet matters more than admin |

## Order and size

Phases 0 to 3 depend only on each other and deliver the design system. Phase 4 can run alongside
phases 2 and 3. Phases 6 to 9 are independent of each other once phase 5 lands. Rough relative
size: phases 2, 3 and 5 are the large ones; 0, 1, 7 and 10 are small.
