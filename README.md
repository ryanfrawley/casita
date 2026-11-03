# Casita

A self-hosted home automation server, written in TypeScript and run on [Bun](https://bun.sh).
One process holds a typed core, the integrations that talk to devices, a WebSocket API, and the
web app; `casita` is a command-line client of the same API. The Home page, automations and
derived sensors are written in Casa, a small declarative language with a live-preview editor in
the app.

What Casita does not do: guess. State is shown only once a device reports it, a command is
pending until the device confirms it, and an entity that cannot be observed is not created.

Status: pre-1.0, running one real house. The API, the Casa language and the config format can
still change between versions, and the changelog says when they do.

## Integrations

| `type` | What it connects | Needs |
| --- | --- | --- |
| `demo` | A fake light and a drifting temperature, for trying Casita without hardware | nothing |
| `mqtt` | Devices speaking the MQTT discovery convention (Tasmota, Shelly, DIY) | an MQTT broker |
| `zigbee2mqtt` | Zigbee devices through [zigbee2mqtt](https://www.zigbee2mqtt.io) | zigbee2mqtt and its broker |
| `zwave-js` | Z-Wave devices through a Z-Wave JS server, pairing included | zwave-js-server or Z-Wave JS UI |
| `esphome` | ESPHome devices over their native API, encrypted or not | the devices on the LAN |
| `qolsys` | A Qolsys IQ Panel (ADT Command) over its local Control4 interface | the panel's secure token |
| `open-meteo` | Weather, forecast, sun and air quality for one place | internet; no account |
| `rachio` | Rachio irrigation controllers | a Rachio API key |
| `lamarzocco` | La Marzocco espresso machines through their cloud | the app account |
| `tesla` | Tesla vehicles through the Fleet API, read-only | a Tesla developer app |
| `teslamate` | Tesla vehicles as [TeslaMate](https://docs.teslamate.org) publishes them over MQTT | TeslaMate |

Each has a README under `integrations/<type>/` with its entities, actions and setup notes, and a
commented block in `config/config.sample.toml` with every field.

## Quick start

You need Bun 1.4.2 or newer (`.bun-version` names the one the project is developed with). There
is no Node, no database server and no build step for the server.

```sh
git clone <this repository> casita
cd casita
bun install
cp config/config.sample.toml config/config.toml
```

Open `config/config.toml` and set `apiToken` under `[server]` to any string of 16 or more
characters. It is the admin credential until the first user exists, and nothing else. The sample
config already has the `demo` integration turned on, so the first start needs no hardware.

```sh
bun run web:build        # the web app, into packages/web/dist; the server serves it from there
bun run start            # http://localhost:8123
```

In a second terminal, create the first user with the bootstrap token, then sign in:

```sh
CASITA_TOKEN=<your apiToken> bun run casita user create <username> --role admin
bun run casita login     # stores a session token in ~/.config/casita/credentials
bun run casita ls        # what is in the house and what it is doing
```

Open <http://localhost:8123> and sign in with the same username and password. Once a user
exists the bootstrap token is refused everywhere, and the server logs a warning on start until
you remove `apiToken` from the config.

To add real devices, uncomment the matching `[[integration]]` block in `config/config.toml`,
fill it in, and restart. Integrations can also be added, changed and removed while the server
runs, from Integrations in the app or with `casita config` and `casita integration`.

## Configuration

`config/config.toml` is read at start (`CASITA_CONFIG` names another path). The server rewrites
the file when config is changed through the API, so comments in it are not kept.

- `[server]`: `host` (default `0.0.0.0`) and `port` (`8123`); `timezone` (an IANA name, default
  the system's); `units`, `metric` or `imperial`, which changes how readings are shown and never
  what is stored; `web = false` to serve the API alone; `dbPath` (default `data/home.db`).
- `[server.history]`: how long raw history is kept, by default and per domain or entity, and how
  often a noisy sensor is written.
- `[[integration]]`: one block per instance, with `type`, an optional `name` (default `main`), and
  the integration's own fields. Two blocks of the same type need different names.
- `[[auth.oidc]]`: an OpenID Connect provider for signing in to the web app, with the role a new
  account gets.

The sample config documents every field. `casita config get` and `casita config set` read and
write the same file through the API.

## Users and access

Users are local (username and password) or come from OIDC. Roles are `admin`, `member` and
`guest`; a grant gives a user a level (`read` or `control`) on an entity, a device, an
area or an integration, and anything a user cannot read looks to them as if it did not exist.
The CLI has `casita user`, `casita grant`, `casita token` (API tokens for scripts) and
`casita audit`; the web app has the same under Users.

A browser session is an `HttpOnly` cookie that counts only on same-origin requests. The CLI and
scripts use bearer tokens.

## Running it for real

- Run `bun run start` under a process supervisor (systemd, OpenRC, launchd) as an unprivileged
  user, from a clone of this repository. The server logs JSON lines to stdout.
- Put TLS in front of it with a reverse proxy, and set `host = "127.0.0.1"` so only the proxy
  reaches it. The proxy must pass WebSocket upgrades on `/ws`, and its idle timeout should be
  above the socket's 30-second ping.
- `config/config.toml` and `data/` are the only state. `casita backup` writes a copy of the
  database beside it and keeps the newest seven; copy `data/` and the config somewhere else.
- To update: `git pull`, `bun install --frozen-lockfile`, `bun run web:build`, restart. Schema
  migrations run on start.

## The CLI

`bun run casita <command>` from the repository, or link it: `cd packages/cli && bun link`, then
`casita` anywhere. It talks to `$CASITA_URL` (default `http://localhost:8123`) with
`$CASITA_TOKEN` or the stored login.

```sh
casita status                         # version, integrations, counts
casita entities --json                # every read command has --json
casita watch                          # state changes as they happen
casita light on light.kitchen            # waits for the device to confirm
casita light set light.kitchen --brightness 50
casita cmd cover.garage open --confirm
casita history sensor.outside --from 7d
casita page source home               # the Home page's Casa source
casita automation list
casita repl                           # raw API requests
```

`casita --help` lists everything; every API request type has a subcommand.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/core` | The engine: types, registry, state store, command router, recorder, config, scheduler, integration host, SQLite migrations, and Casa (`src/casa/`): the language, its compiler and the runtime for pages, automations and derived sensors |
| `packages/api` | The WebSocket and HTTP surface, users, sessions, grants, OIDC and the audit log; `src/schema.ts` is the wire protocol as Zod schemas |
| `packages/server` | The entrypoint: wires core, API and the integration catalog into one process |
| `packages/client` | The WebSocket client and the words for a state, shared by the CLI and the web app |
| `packages/cli` | The `casita` command |
| `packages/ui` | The design system as React components, with a gallery (`bun run ui:gallery`) |
| `packages/web` | The web app, built with Bun's bundler into `packages/web/dist` |
| `integrations/*` | One package per integration, depending on the core only through `@casita/core/types` |
| `tests/` | Integration tests that run the whole server in-process, with fakes for every transport |
| `docs/` | The original technical spec, the Casa language spec, and the web UI plan |

Each package's README says what it owns, its rules, and what it must not import;
`tests/boundaries.test.ts` enforces the imports.

## Developing

```sh
bun test                 # everything, under a minute, no network or hardware
bun run typecheck
bun run lint             # biome
bun run web:dev          # rebuild the web app on change; bun run start serves it
```

`CONTRIBUTING.md` has the checklists for adding a domain, an integration, an API request or a
screen. `CHANGELOG.md` is the history, newest first, and ends with where the implementation
departs from the spec in `docs/core-spec.md`. `DEPENDENCIES.md` lists every dependency and its
license.

## Security

Casita controls locks, alarms and garage doors, so treat it as you would any such service: keep
it off the open internet or behind TLS and a proxy, give household members `member` or `guest`
accounts with grants rather than sharing an admin, and keep `config/config.toml` private, since
it holds every integration's credentials. If you find a vulnerability, please report it privately
to the maintainer rather than in a public issue.

## License

MIT. See `LICENSE`.
