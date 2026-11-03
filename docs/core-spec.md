<!-- Exported 2026-11-02 from the Claude Doc "Home Automation Core — Technical Spec v1". The
     spec was written before the code and is kept as it stood: where the build departs from it,
     "Where the implementation departs from the spec" in CHANGELOG.md is authoritative, and the
     code wins over both. "Automations are TypeScript modules" was later replaced by Casa
     automations (see docs/casa-page-language.md). -->

# Home Automation Core — Technical Spec v1

Oct 3, 2026 · Ryan Frawley

## Overview and goals

Build a home automation core in TypeScript on Bun that replaces Home Assistant with no dependency on it: a typed entity model, a single-writer state store, an event bus, a command router, a recorder, an integration host, and a WebSocket/HTTP API, driven for now by a CLI. The owner will build their own UI later against the API, so the API is a first-class deliverable, not an afterthought.

**Goals for milestone 1**

- Control and observe real devices through four integrations: generic MQTT (Tasmota, Shelly), zigbee2mqtt, Z-Wave JS, and ESPHome.
- Expose everything through a typed WebSocket API with live state streaming, plus a small HTTP surface.
- Provide a CLI that exercises every API operation, so the system is fully usable headless.
- Persist registry, config, integration data, and state history in one SQLite database.
- Run automations written as plain TypeScript modules with hot reload.

**Guiding principles** (apply these when the spec is silent)

1. State flows up, commands flow down. Integrations report state; the core never guesses it. Commands pass through the command router only.
2. The state store is the only writer. An integration may report state only for entities it registered.
3. Integrations see a context object, never core internals. The contract in `core/types.ts` is the whole surface.
4. Types replace YAML. Entity state and commands are discriminated unions; integration config is a Zod schema; config forms and validation derive from those.
5. Prefer small, dependency-light code. Use Bun built-ins (server, WebSocket, SQLite, test runner) before adding packages.
6. Treat Home Assistant and its device libraries as reference documentation for protocols, never as code to copy.

## Non-goals and constraints

Milestone 1 ships no UI, no cloud integrations, no Matter, no Bluetooth, no Zigbee radio stack of its own, and no Home Assistant compatibility of any kind.

**Out of scope for milestone 1**

- Web or mobile UI. The API and CLI must be good enough that the UI can be built without touching the core.
- Matter, Bluetooth, HomeKit, Thread, and direct Zigbee or Z-Wave radio access. Zigbee and Z-Wave go through zigbee2mqtt and Z-Wave JS respectively.
- Cloud integrations (Hue cloud, Sonos, Ecobee, etc.). The integration contract must make them easy to add later.
- Scenes, groups, and areas as command targets beyond the simple `sendToArea` fan-out.
- Custom roles and OIDC group-to-role mapping; only the three fixed roles ship (see Users, roles, and permissions). The `CommandSource` type must carry a `userId` on every user-issued command so policies can act on it.
- Importing Home Assistant config, entity ids, or YAML.

**Hard constraints**

- Runtime is Bun (latest stable). No Node-only APIs; use `Bun.serve`, `bun:sqlite`, `Bun.file`, and `bun test`.
- TypeScript strict mode, `noUncheckedIndexedAccess` on, ESM only.
- Integrations import only from `core/types.ts` and their own dependencies. A lint rule must enforce this.
- The process must run on a Raspberry Pi 4 class machine: steady-state under 200 MB RSS with all four integrations loaded.
- Shutdown must be clean: every integration's `AbortSignal` fires, pending SQLite writes flush, and the process exits within 5 seconds on SIGTERM.
- Licenses: all dependencies must be MIT, BSD, Apache 2.0, or ISC. Note any exception in `DEPENDENCIES.md` before adding it.

## Tech stack and repository layout

One Bun workspace monorepo, one process at runtime, one SQLite file on disk.

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Bun, latest stable | Pin in `.bun-version` and `package.json` `engines` |
| Language | TypeScript 5.x strict, ESM | Shared `tsconfig.base.json` |
| HTTP + WebSocket | `Bun.serve` | No framework; a small router helper is fine |
| Validation / schemas | `zod` | Config, API messages, CLI args |
| Database | `bun:sqlite` | WAL mode; migrations as numbered SQL files |
| MQTT client | `mqtt` (MQTT.js) | Used by the generic MQTT and zigbee2mqtt integrations |
| Z-Wave | `@zwave-js/server` client via WebSocket | Do not embed `zwave-js` in-process in milestone 1 |
| ESPHome | Own implementation of the native API | Protobuf via `protobufjs`; the `.proto` is in the ESPHome repo |
| Logging | `pino` | JSON to stdout; `LOG_LEVEL` env var |
| Tests | `bun test` | Unit tests beside code; integration tests under `tests/` |
| Lint / format | `biome` | One config at the root; includes the import-boundary rule |
| CLI | `commander` | Thin client over the WebSocket API |

**Repository layout**

```
/
  package.json              workspaces: packages/*, integrations/*
  biome.json
  tsconfig.base.json
  packages/
    core/                   types, registry, state store, bus, router, recorder, config, scheduler, host
      src/types.ts          the public contract (already drafted)
      src/router.ts         command router (already drafted)
      src/db/migrations/    001_init.sql, ...
    api/                    Bun.serve app: WebSocket protocol, HTTP routes, auth
    cli/                    `hac` binary
    server/                 entrypoint: wires core + api + integrations, handles signals
  integrations/
    mqtt/                   generic MQTT (Tasmota, Shelly)
    zigbee2mqtt/
    zwave-js/
    esphome/
  automations/              user automation modules, loaded at runtime (gitignored sample provided)
  config/
    config.toml             server + integration instance config (see Config store)
  tests/                    integration tests with fakes (MQTT broker, Z-Wave JS server)
  data/                     runtime: home.db (gitignored)
```

The two drafted files, `core/types.ts` and `core/router.ts`, are the starting point and are normative where this document does not override them. Where the two disagree, this document wins; update the files.

## Domain model

Everything the system knows is a device, an entity on a device, or a state record for an entity. The full type definitions live in `core/types.ts`; this section states the rules those types must obey.

**Identifiers**

- `EntityId` is `<domain>.<slug>`, lowercase, `[a-z0-9_]` only, globally unique. The integration proposes the slug from the device name; the registry resolves collisions by appending `_2`, `_3`.
- Entity ids are stable across restarts. Each entity also carries a `uniqueId` (integration id + the integration's own stable key, such as the Zigbee IEEE address or Z-Wave node id plus endpoint) that is used to re-attach the same registry row after a rename. Add `uniqueId: string` to `Entity` and `Device`.
- Users may rename an entity id through the API. The registry keeps the old id as an alias for 30 days so automations get a clear error rather than silent breakage.

**Domains in milestone 1**

| Domain | State fields | Commands |
| --- | --- | --- |
| `light` | `on`, `brightness` 0 to 1, `colorTempK`, `rgb` | `turn_on` (with optional brightness, colorTempK, rgb, transitionMs), `turn_off` |
| `switch` | `on` | `turn_on`, `turn_off`, `toggle` |
| `sensor` | `value`, `unit`, `deviceClass` | none |
| `binary_sensor` | `on`, `deviceClass` | none |
| `climate` | `mode`, `currentTemp`, `targetTemp` | `set_mode`, `set_target` |
| `cover` | `position` 0 to 1, `motion` | `open`, `close`, `stop`, `set_position` |
| `lock` | `locked`, `jammed` | `lock`, `unlock` |
| `button` | none (stateless) | `press` |

Add `button` to `types.ts`. A button entity emits a `state_changed` with `pressedAt` set to the current time; its state record is `{ domain: "button", pressedAt?: number }`.

**Capabilities** describe what an entity can do and are set at registration. The router validates every command against them; the UI reads them to decide which controls to show. An integration must not advertise a capability it cannot honor.

**State records** carry `available`, `changedAt`, and `updatedAt`. `changedAt` moves only when `state` differs by deep equality; `updatedAt` moves on every report. A report identical to the current state is still recorded as a heartbeat (updates `updatedAt`, emits no event).

**Attributes.** Each entity may also carry a free-form `attributes: Record<string, unknown>` for integration-specific extras (link quality, last seen, firmware). Attributes are stored and streamed but never validated and never part of `state`; automations should not depend on them for logic.

**Areas** are a flat list of named rooms or zones. Devices and entities may belong to one area; an entity inherits its device's area unless overridden.

## Core services

The core is eight small services in one process, connected through the event bus. Each is a class with an explicit constructor dependency list; there is no global container or decorator-based DI.

**Event bus** (`core/bus.ts`). A typed wrapper over `EventTarget` or a hand-rolled listener map. `emit` is synchronous and never throws: a listener that throws is logged and the remaining listeners still run. Listeners that return promises are not awaited. Provide `on(type, handler)` returning an unsubscribe function and `once(type, filter?)` returning a promise for tests.

**Registry** (`core/registry.ts`). Owns devices, entities, and areas. Backed by SQLite; the in-memory maps are the read path and are loaded fully at startup. Responsibilities: id allocation and collision handling, `uniqueId` re-attachment, rename with alias, area assignment, disabled and hidden flags. Emits `device_*` and `entity_*` events. Entities registered by an integration that is no longer loaded remain in the registry as `orphaned` so the UI can show and delete them.

**State store** (`core/state.ts`). In-memory map of `EntityId` to `StateRecord`. The only entry point is `report(integrationId, entityId, state, attributes?)`; it rejects reports for entities the integration does not own. It deep-compares, updates timestamps, and emits `state_changed` only on a real change. On startup it restores the last known state from the recorder with `available: false` until an integration reports again, so clients see a reasonable picture immediately.

**Command router** (`core/router.ts`). As drafted: resolve, availability, normalize, validate, policies, per-entity latest-wins queue, dispatch with timeout, optional confirmation. Default timeouts: 10 s handler, 5 s confirmation. Add a `button.press` path (no state check beyond availability).

**Recorder** (`core/recorder.ts`). Subscribes to `state_changed`, `command_issued`, and `command_failed`, and writes them to SQLite in batches (flush every 1 s or 200 rows). Provides `history(entityId, from, to, limit)` and `lastKnown()` for startup. Applies retention nightly (see Persistence).

**Config store** (`core/config.ts`). Reads `config/config.toml` at startup, validates the `server` section and each `[[integration]]` block against the integration's Zod schema, and exposes typed config. Writes go through `set(path, value)` which validates, rewrites the file atomically (write temp, rename), and emits `config_changed`. The UI will later edit config through the API, never by editing files; design the API-facing shape now (JSON Schema derived from Zod via `zod-to-json-schema`).

**Scheduler** (`core/scheduler.ts`). `every`, `after`, and `cron` built on `setTimeout` plus the `croner` package. Cron expressions and the retention schedule evaluate in server.timezone (an IANA name such as America/Los\_Angeles; default is the system time zone); the server logs the effective zone at startup and refuses to start on an unknown name. Every handle is tied to an `AbortSignal` so unloading an integration or automation cancels its timers.

**Integration host** (`core/host.ts`). Loads integrations named in config, builds an `IntegrationContext` for each instance, and manages lifecycle: `starting`, `running`, `error`, `stopped`. On `setup()` rejection or an uncaught error in the integration's async work, the host marks it `error`, logs, and retries with exponential backoff (1 s, 2 s, 4 s, capped at 60 s). Reloading an instance aborts its signal, waits up to 5 s for teardown, and runs `setup()` again. Multiple instances of one integration (two MQTT brokers) are allowed; `integrationId` in the registry is `<integration>.<instanceName>`. Integrations run in-process in milestone 1; the context must contain only serializable calls so a worker-thread host can replace it later.

**Automation engine** (`core/automations.ts`). Scans `automations/*.ts`, imports each with `import()` plus a cache-busting query string, calls `setup(api)`, and keeps the cleanup function. A file watcher (`fs.watch`) reloads a changed file: run cleanup, abort its signal, re-import, re-run setup. Errors in an automation are logged with the automation id and never crash the process. The `AutomationApi` in `types.ts` is the whole surface; add `signal: AbortSignal` to it.

## Integration contract

An integration is a module that exports `defineIntegration({ id, name, version, configSchema, setup })` and depends on nothing in the core except `core/types.ts`.

**Lifecycle**

1. The host validates the instance config against `configSchema`. Invalid config means the instance is never started and the error is surfaced through `integration_status`.
2. `setup(ctx)` is called once. It should connect, discover devices, register them, and return. Long-running work (socket listeners, polling) is started inside `setup` and must stop when `ctx.signal` aborts.
3. `setup` may return a teardown function. The host calls it on unload after aborting the signal; it has 5 s before the host moves on.
4. The integration calls `ctx.reportState` whenever the device reports, including on reconnect. It calls `ctx.setAvailable(id, false)` when it loses the device or its transport.

**Context rules**

- `registerDevice` and `registerEntity` are idempotent on `uniqueId`: calling them again with the same key updates name, model, and capabilities and returns the existing id. Integrations should call them on every discovery, not only the first.
- `registerEntity` takes the command handler. An entity with no handler is read-only; the router rejects commands to it with `unsupported`.
- A command handler must resolve once the command has been handed to the transport, and reject with an `Error` whose message is user-readable if that fails. It must not wait for the device to confirm; the router handles confirmation.
- `ctx.storage` is a private key-value namespace per instance (`integration_storage` table). Use it for tokens, pairing keys, and discovery caches. Never write files.
- `ctx.log` is a child logger with `integration` and `instance` bound; integrations never import `pino` directly.
- Reporting state for an entity the instance did not register throws. The host also logs it as a bug.

**Discovery and config.** Each integration decides how it discovers devices; most in milestone 1 discover from their transport (MQTT topics, Z-Wave JS node list, ESPHome entity list). Static config is for transport details only (broker URL, server address, credentials). Devices are never hand-listed in config.

**Testing an integration.** Every integration ships a fake transport under `integrations/<name>/test/` and at least these tests: discovers a device from a fixture, reports state on a transport message, delivers a command to the transport, marks entities unavailable on disconnect, and cleans up on abort.

**Adding a new domain or capability** is a change to `core/types.ts`, the router's normalize and validate functions, the `satisfies` matcher, the API schema, and the CLI. Keep a checklist in `CONTRIBUTING.md`.

## Integrations in scope

Four integrations ship in milestone 1, in this order: generic MQTT, zigbee2mqtt, ESPHome, Z-Wave JS. The first two share one MQTT connection layer.

**Shared MQTT layer** (`integrations/mqtt-shared/`). A thin wrapper over MQTT.js: connect with reconnect, subscribe with a per-topic handler map, publish, and an `onConnectionChange` hook. Both MQTT integrations take `brokerUrl`, `username`, `password`, and `clientId` in config. Loss of the broker connection marks every entity of that instance unavailable; reconnect re-subscribes and waits for fresh reports.

**Generic MQTT** (`integrations/mqtt/`). Supports the MQTT discovery convention that originated in Home Assistant (`<prefix>/<component>/<id>/config`) because Tasmota, Shelly, and many DIY devices publish it, and because it is an open convention, not a dependency on HA. Milestone 1 maps `light`, `switch`, `sensor`, `binary_sensor`, `cover`, and `button` components. The discovery payload fields to honor: `name`, `unique_id`, `state_topic`, `command_topic`, `availability_topic`, `payload_on`/`payload_off`, `brightness_*`, `value_template` (support only the `{{ value_json.<path> }}` form; anything else is logged and the entity is skipped), `device` block for device metadata, and `unit_of_measurement`. The `discoveryPrefix` config field defaults to `hac`, so nothing in the system refers to Home Assistant by default; devices that publish under `homeassistant/` (the factory default on Tasmota and Shelly) must be pointed at the new prefix, or the field set to `homeassistant` on that instance.

**zigbee2mqtt** (`integrations/zigbee2mqtt/`). Talks to zigbee2mqtt over its own MQTT topics, not HA discovery, because the `bridge/devices` payload carries full capability metadata (`exposes`). On start, subscribe to `<base>/bridge/devices` and `<base>/bridge/state`; build devices and entities from `exposes` (light, switch, cover, lock, climate, numeric and binary sensors). Subscribe to `<base>/<friendly_name>` for state and `<base>/<friendly_name>/availability`. Commands publish JSON to `<base>/<friendly_name>/set` (brightness scaled 0 to 254, color temperature in mireds, transitions in seconds). Handle renames by `ieee_address` as the `uniqueId`. Config: shared MQTT fields plus `baseTopic` (default `zigbee2mqtt`). Permit-join and pairing are exposed through an integration-level action (see API) that publishes to `bridge/request/permit_join`.

**ESPHome** (`integrations/esphome/`). Implements the ESPHome native API client: plaintext TCP on port 6053 with the frame format `0x00, varint length, varint type, protobuf body`, and Noise encryption (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) when a key is configured. Message types to support: `HelloRequest/Response`, `ConnectRequest/Response` (password), `DeviceInfoRequest/Response`, `ListEntities*` for light, switch, sensor, binary sensor, cover, button, and `ListEntitiesDoneResponse`, `SubscribeStatesRequest` and the matching `*StateResponse` messages, `*CommandRequest` for the supported domains, `PingRequest/Response`, and `DisconnectRequest`. Devices are listed in config (`[[integration.esphome.devices]]` with `host`, `port`, `encryptionKey`, `password`) or found via mDNS `_esphomelib._tcp` when `discover = true`. Reconnect with backoff; `uniqueId` is the device's MAC from `DeviceInfoResponse` plus the entity key. Generate the TypeScript protobuf types from `api.proto` in the ESPHome repository and commit the generated file with the source commit hash noted.

**Z-Wave JS** (`integrations/zwave-js/`). Client for the `zwave-js-server` WebSocket protocol (`@zwave-js/server`, schema version pinned in code). On connect, send `initialize` with the schema version, then `start_listening` to receive the full node dump; build devices per node and entities per value id, mapping command classes: Binary Switch → `switch`, Multilevel Switch → `light` (brightness) or `cover` (by device class), Door Lock → `lock`, Thermostat Mode/Setpoint → `climate`, Multilevel Sensor → `sensor`, Binary Sensor and Notification (motion, door) → `binary_sensor`, Central Scene → `button` per scene. Subscribe to `node value updated`, `node dead`, `node alive`, and `node ready` events. Commands use `node.set_value` with the value id. `uniqueId` is `<homeId>-<nodeId>-<endpoint>-<commandClass>-<property>`. Config: `serverUrl` (default `ws://localhost:3000`). Inclusion and exclusion are integration-level actions.

**Integration-level actions.** Some operations are not entity commands: permit join, start inclusion, heal network, rescan. Add to the contract `ctx.registerAction(name, schema, handler)` and expose them through the API as `integration.action` with the Zod schema converted to JSON Schema for the future UI.

## Users, roles, and permissions

Every request runs as a user with a role, and permissions are enforced in exactly two places: the API read filter and the first router policy. Nothing is anonymous except `GET /health`.

**Users and identity.** Local username and password is the first identity provider; OIDC is the second, behind the same interface.

- `users` table: `id`, `username` (unique, lowercase), `display_name`, `password_hash` (argon2id via `Bun.password`; null for OIDC-only users), `role`, `disabled`, `created_at`, `updated_at`.
- `user_identities` table: `provider`, `subject`, `user_id`, `created_at`; PK `(provider, subject)`. Local users have a row with `provider = "local"`.
- `IdentityProvider` interface in `packages/api/src/auth/`: `authenticate(credentials) → userId | null` for local, and `startLogin()` / `completeLogin(callbackParams) → { provider, subject, claims }` for OIDC. The server picks a provider by name; adding one is a new file plus a config block.
- OIDC config: `[[auth.oidc]]` with `name`, `issuer`, `clientId`, `clientSecret`, `redirectUrl`, `defaultRole` (default `guest`). Flow is Authorization Code with PKCE using discovery from `issuer`. A new subject creates a user with `defaultRole`; an admin promotes them. Group-to-role mapping is deferred.
- Bootstrap: `server.apiToken` in `config.toml` acts as an admin credential only while the `users` table is empty. Once the first admin exists the server ignores it and logs a warning on every start until it is removed from config.

**Sessions and tokens.** One `sessions` table serves both: `id`, `user_id`, `token_hash` (SHA-256 of the bearer token), `kind` (`session` or `api`), `name`, `expires_at`, `last_used_at`, `created_at`. Session tokens expire after 30 days, sliding on use. API tokens are created by the user for scripts and the CLI, never expire, and are revoked explicitly. The WebSocket `auth` message and the HTTP `Authorization: Bearer` header accept either kind. Login attempts are rate limited to 5 per minute per IP; failures return the same error for unknown user and wrong password.

**Roles.** Three fixed roles in milestone 1. Custom roles later will be named grant sets, so grants below are keyed on a `subject` that can be a user or a role.

| Role | Default on every entity | Manage users, roles, grants | Config, integrations, actions | Areas, renames, metadata |
| --- | --- | --- | --- | --- |
| `admin` | control | yes | yes | yes |
| `member` | control | no | no | no |
| `guest` | none | no | no | no |

**Grants.** A grant sets a permission level for a subject on a scope. Table `grants`: `id`, `subject_kind` (`user` or `role`), `subject_id`, `scope_kind` (`entity`, `area`, `domain`), `scope_id`, `level` (`none`, `read`, `control`), `created_by`, `created_at`; unique on `(subject_kind, subject_id, scope_kind, scope_id)`.

Resolution for a user and an entity, first match wins:

1. User grant on the entity.
2. User grant on the entity's area.
3. User grant on the entity's domain.
4. Role grant on the entity, then area, then domain.
5. The role default from the table above.

So a member can be denied `lock` as a domain, a guest can be given `control` on one room, and an admin-created role grant such as `guest` + `domain:sensor` = `read` lets every guest see sensors. The resolver is a pure function `resolveLevel(user, grants, entity) → Level`, unit tested against a table of cases, and cached per connection.

**Enforcement.**

- API read filter: `get_entities`, `get_devices` (a device is visible if any of its entities is), `get_states`, `get_history`, and `subscribe` return only entities at `read` or above. The snapshot and the event stream are filtered per connection; the visible set is recomputed when grants change, the user's role changes, or an entity is added or moved. A user who loses all access to an entity receives no further events for it and no notice.
- Router policy: the first policy registered is `requirePermission`, which resolves the level for `source.userId` and rejects with `forbidden` when it is below `control`. `CommandSource` becomes `{ kind: "user", userId, sessionId } | { kind: "automation", automationId } | { kind: "system" }`.
- Admin-only request types: everything under users, grants, tokens of other users, `set_config`, `reload_integration`, `integration_action`, `update_entity`, `update_device`, `delete_*`, areas. Members and guests get `forbidden` with no detail about the target.
- Automations run as `{ kind: "automation" }` with control on every entity and no management rights; the lock example policy shows how to restrict them further.
- Integrations report state as `{ kind: "system" }`; this path has no permission check and is not reachable from the API.

**Audit.** Table `audit`: `id`, `at`, `actor_user_id`, `action` (`login`, `login_failed`, `logout`, `user_created`, `user_updated`, `user_deleted`, `grant_set`, `grant_deleted`, `token_created`, `token_revoked`, `config_set`), `target`, `detail` (JSON), `ip`. Commands are already audited in `commands.source`. Retained 365 days; readable by admins through `get_audit`.

**API additions.** HTTP: `POST /api/auth/login` (`username`, `password` → token and user), `POST /api/auth/logout`, `GET /api/auth/oidc/<name>/start`, `GET /api/auth/oidc/<name>/callback`. WebSocket: `get_me`, `list_users`, `create_user`, `update_user` (`role`, `disabled`, `displayName`, `password`), `delete_user`, `list_grants`, `set_grant`, `delete_grant`, `list_tokens`, `create_token`, `revoke_token`, `list_sessions`, `revoke_session`, `get_audit`. A user may manage only their own tokens and sessions unless admin.

**CLI additions.** `hac login` (prompts, stores a session token in `~/.config/hac/credentials`), `hac logout`, `hac whoami`, `hac user list|create|set-role|disable|enable|reset-password|rm`, `hac grant list [--user|--role]`, `hac grant set <user|role:name> <entity|area|domain>:<id> <none|read|control>`, `hac grant rm <id>`, `hac token create --name|list|revoke`, `hac audit [--since]`.

**Tests.** A guest sees no ungranted entity in `get_states`, `subscribe`, or `history`; a member with a `domain:lock` deny grant gets `forbidden` on `lock.unlock` and still controls lights; a role grant applies to every user with that role; every admin-only request type rejects a member; an expired session is refused; a revoked API token is refused within one second; the OIDC callback links an identity using a fake provider; the bootstrap token stops working once an admin exists.

**Implementation placement.** Local users, sessions, roles, grants, and both enforcement points land as step 4a, right after the API server basics and before the first MQTT integration, so every later feature is built with permissions on. OIDC lands with step 11.

## API

One WebSocket endpoint carries all reads, writes, and live events; a small HTTP surface covers health, history export, and anything a browser needs before it has a socket. Every message is validated with Zod on both sides, and the schemas are exported from `packages/api/src/schema.ts` so the CLI and the future UI share them.

**Transport.** `ws://host:8123/ws` (port configurable). JSON text frames. Authenticate with the first message `{ type: "auth", token }`; any other first message closes the socket with code 4401. Tokens are per-user session or API tokens (see Users, roles, and permissions); the bootstrap admin token lives in `config.toml` (`server.apiToken`). HTTP routes take the same token as `Authorization: Bearer`.

**Message envelope.** Requests: `{ id: number, type: string, ...params }`. Responses: `{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }`. Events pushed by the server: `{ type: "event", event: CoreEvent }` with no `id`. Error codes are the `CommandErrorCode` set plus `auth`, `bad_request`, `not_found`, `internal`.

**Request types**

| Type | Params | Result |
| --- | --- | --- |
| `subscribe` | `events?: string[]`, `entityIds?: string[]` | `{ subscriptionId }`; omitted filters mean everything |
| `unsubscribe` | `subscriptionId` | `{}` |
| `get_states` | `entityIds?` | `StateRecord[]` plus `attributes` |
| `get_entities` | `domain?`, `areaId?`, `deviceId?` | `Entity[]` |
| `get_devices` | `areaId?` | `Device[]` |
| `get_areas` |  | `Area[]` |
| `send_command` | `entityId`, `command`, `confirm?` | `CommandResult` |
| `send_area_command` | `areaId`, `command`, `confirm?` | `CommandResult[]` with per-entity errors |
| `update_entity` | `entityId`, `name?`, `newId?`, `areaId?`, `hidden?`, `disabled?` | `Entity` |
| `update_device` | `deviceId`, `name?`, `areaId?` | `Device` |
| `delete_entity` / `delete_device` | id | `{}` (orphaned rows only) |
| `create_area` / `update_area` / `delete_area` | `name`, `id` | `Area` |
| `get_history` | `entityId`, `from`, `to`, `limit?` | `StateRecord[]` oldest first, max 10,000 rows |
| `get_integrations` |  | status, instance name, config schema (JSON Schema), actions |
| `integration_action` | `integrationId`, `action`, `params` | action result |
| `get_config` / `set_config` | `path`, `value` | validated config; `set_config` may trigger an integration reload |
| `reload_integration` | `integrationId` | `{}` |
| `get_automations` / `reload_automation` | `automationId` | status and last error |
| `ping` |  | `{ time }` |

**Event streaming.** After `subscribe`, the server first sends a `snapshot` message with current `StateRecord`s for the filtered set, then streams events in order. Events are never coalesced; a slow client is disconnected when its send buffer exceeds 4 MB rather than blocking the bus.

**HTTP routes.** `GET /health` (no auth; returns integration statuses), `GET /api/history.csv?entityId&from&to` (streams CSV), `GET /api/schema` (returns the JSON Schema for every request and event type, used by the UI and for docs).

**Compatibility.** The protocol carries `{ type: "auth" }` → `{ type: "auth_ok", version: 1 }`. Breaking changes bump `version`; the CLI refuses to talk to a server with a different major version.

## CLI

The `hac` command is a thin client over the WebSocket API and the only user interface in milestone 1; every API request type has a matching subcommand, and nothing in the CLI talks to the core directly.

**Connection.** `HAC_URL` and `HAC_TOKEN` environment variables, overridable with `--url` and `--token`. A missing token prints a one-line hint and exits 2.

**Commands**

| Command | Behavior |
| --- | --- |
| `hac status` | Server version, uptime, integration statuses, entity and device counts |
| `hac entities [--domain] [--area] [--json]` | Table of entities with current state summary |
| `hac devices [--area] [--json]` | Table of devices with manufacturer, model, entity count |
| `hac state <entityId>` | Full state record and attributes |
| `hac watch [entityId...]` | Streams `state_changed` events as one line each until Ctrl-C; `--json` for raw events |
| `hac cmd <entityId> <action> [--key value ...] [--confirm]` | Sends a command; flags map to command fields (`--brightness 0.5`); prints the `CommandResult` |
| `hac area cmd <areaId> <domain> <action> [...]` | Fan-out command with a per-entity result table |
| `hac rename <entityId> <newId>` | Renames; prints the alias note |
| `hac entity set <entityId> --name --area --hidden --disabled` | Updates entity metadata |
| `hac area list` / `hac area add <name>` / `hac area rm <id>` | Area management |
| `hac history <entityId> [--from] [--to] [--csv]` | Prints history |
| `hac integrations` | Status table |
| `hac integration action <id> <action> [--key value ...]` | Runs an integration action such as `permit_join` |
| `hac integration reload <id>` | Reloads one instance |
| `hac config get <path>` / `hac config set <path> <value>` | Reads or writes config; values parsed as JSON when possible |
| `hac automations` / `hac automation reload <id>` | Lists automations with last error; reloads one |
| `hac schema` | Dumps the JSON Schema from `/api/schema` |

**Conventions.** Human-readable tables by default, `--json` on every read command for scripting. Exit codes: 0 success, 1 server-side error (the error code is printed), 2 usage or connection error. `hac cmd` with `--confirm` exits 1 when the result is `unconfirmed`. Entity ids accept a unique prefix (`hac state light.kit` resolves `light.kitchen_ceiling` when it is the only match).

**Interactive mode.** `hac repl` opens one socket and accepts the same commands without the `hac` prefix, with tab completion over entity ids. Nice to have; implement last.

## Persistence

One SQLite database, `data/home.db`, in WAL mode, holds the registry, config history, integration storage, and state history; the config file remains the source of truth for config.

**Tables** (migration `001_init.sql`; later changes are new numbered files, never edits)

| Table | Columns | Notes |
| --- | --- | --- |
| `areas` | `id`, `name`, `created_at` |  |
| `devices` | `id`, `unique_id`, `integration_id`, `name`, `manufacturer`, `model`, `firmware`, `area_id`, `via_device_id`, `orphaned`, `created_at`, `updated_at` | unique on `(integration_id, unique_id)` |
| `entities` | `id`, `unique_id`, `integration_id`, `device_id`, `domain`, `name`, `capabilities` (JSON), `area_id`, `hidden`, `disabled`, `orphaned`, `created_at`, `updated_at` | unique on `(integration_id, unique_id)` |
| `entity_aliases` | `old_id`, `entity_id`, `expires_at` | 30-day rename aliases |
| `states` | `id` (rowid), `entity_id`, `state` (JSON), `attributes` (JSON), `available`, `changed_at`, `updated_at` | one row per `state_changed`; index on `(entity_id, changed_at)` |
| `last_states` | `entity_id` (PK), `state`, `attributes`, `available`, `changed_at`, `updated_at` | upserted on every report; read at startup |
| `commands` | `id`, `entity_id`, `command` (JSON), `source` (JSON), `status`, `error`, `latency_ms`, `issued_at` | audit log |
| `integration_storage` | `integration_id`, `key`, `value` (JSON), `updated_at` | PK `(integration_id, key)` |
| `integration_status` | `integration_id`, `status`, `error`, `since` | current status, for `/health` after restart |

**Writes.** The recorder batches inserts in one transaction per flush. All other services write synchronously through prepared statements; `bun:sqlite` is fast enough that a write per registry change is fine.

**Retention and downsampling.** Retention is a policy resolved per entity: the entity's own setting, else its domain's, else the default. A policy has a `raw` window in days plus optional rollup tiers, each with its own window.

```toml
[server.history]
defaultDays = 30          # raw retention when nothing more specific applies
minIntervalMs = 0         # skip raw sensor writes closer than this

[server.history.domains.lock]
raw = 90

[server.history.entities."sensor.living_room_temp"]
raw = 7
minute = 90
hour = 730
```

Entity-level policies are also settable through `update_entity` (`retention` field, stored as JSON in `entities.retention`); the config file holds domain and default policies. The effective policy for an entity is returned by `get_entities`.

Rollups live in `state_rollups`: `entity_id`, `period` (`minute`, `hour`, `day`), `bucket_start`, `samples`, and per bucket `min`, `max`, `mean`, `last` for numeric states; for boolean states (`on`, `locked`) `last`, `changes`, and `on_seconds`; for other state shapes `last` only. A rollup job runs every 5 minutes for the minute tier, hourly for the hour tier, and daily for the day tier, each computed from the tier below (or raw) and upserted by `(entity_id, period, bucket_start)` so reruns are idempotent. Nightly at 03:00 in `server.timezone` the retention job deletes raw rows past their `raw` window and rollup rows past their tier window, then runs `PRAGMA wal_checkpoint(TRUNCATE)`; `commands` rows are kept 90 days and `audit` rows 365.

`get_history` gains `resolution: "raw" | "minute" | "hour" | "day"` (default `raw`). When the requested resolution is no longer available for part of the range, the server returns the finest tier that is and names it in the result; it never silently mixes tiers. `hac history --resolution hour` exposes the same.

**Backups.** `hac config get` is enough to reproduce config; the database is backed up by copying the file while the server runs `VACUUM INTO 'data/backup-<date>.db'` via `hac backup`. Keep the last 7.

## Testing, quality, and conventions

Every core service and every integration has tests that run with `bun test` in under 30 seconds total, with no network, no real broker, and no hardware.

**Unit tests** sit beside the code as `*.test.ts`. Required coverage, by service:

- Event bus: listener isolation (a throwing listener does not stop others), unsubscribe.
- Registry: id slugging and collision, `uniqueId` re-attachment after rename, alias expiry, orphaning on integration removal.
- State store: no event on identical report, `changedAt` versus `updatedAt`, ownership rejection, startup restore as unavailable.
- Router: every error code reachable by a test; latest-wins supersession; confirmation success and timeout; normalization table (toggle, brightness 0, clamping, transition stripping); one policy that rejects.
- Recorder: batching, `historyMinIntervalMs` skipping, retention deletes the right rows.
- Config store: invalid config rejected with a path, atomic rewrite, reload trigger.
- Host: backoff on failing `setup`, abort on reload, two instances of one integration.
- Automation engine: hot reload runs cleanup before re-setup; an automation that throws is isolated.

**Integration tests** under `tests/` boot the real server against fakes: an in-process MQTT broker (`aedes`) for the two MQTT integrations, a fake Z-Wave JS server speaking the WebSocket protocol from recorded fixtures, and a fake ESPHome device implementing the plaintext native API. Each test drives the system only through the CLI or the WebSocket API, never by importing core modules. Minimum scenarios: discover, control, observe state change, lose transport, recover transport, restart server and see restored state.

**Fixtures.** Record real payloads from the owner's devices once available and check them in under `tests/fixtures/<integration>/`. Until then, build fixtures from the public protocol documentation and mark them `synthetic` in the file name.

**Conventions**

- Biome for lint and format; CI fails on warnings. A custom lint rule (or a `tests/boundaries.test.ts` that parses imports) fails the build if any file under `integrations/` imports from `packages/core/src` other than `types.ts`.
- Errors thrown across module boundaries are `Error` subclasses with a `code` string; never throw strings or plain objects.
- Logs are structured. Every log line from an integration carries `integration` and `instance`; every router log carries `entityId`.
- No `any`. `unknown` plus Zod at every boundary (API, config, transport payloads).
- Commit messages: `area: short imperative summary` (`router: add button.press`).
- Each package has a `README.md` that states what it owns and what it must not import; keep it under 40 lines.

**Definition of done for milestone 1.** All tests green, `bun run start` boots with the four integrations configured against the fakes, `hac watch` shows live state, `hac cmd` controls an entity with `--confirm`, memory under 200 MB after one hour, clean shutdown under 5 seconds.

## Implementation order

Build in the order below, with the users and permissions work as step 4a between the API server and the first integration; each step ends with its tests green and a short note in `CHANGELOG.md`. Steps 1 to 5 produce a usable system with one integration, which is the first thing to run against real hardware.

1. Repo scaffold: workspace, Biome, base tsconfig, `bun test` wiring, the import-boundary check, `core/types.ts` and `core/router.ts` moved into `packages/core` with the additions this spec calls for (`uniqueId`, `button`, `attributes`, `signal` on `AutomationApi`, `registerAction`).
2. Event bus, registry, state store, with SQLite migrations and the `last_states` restore path.
3. Config store and integration host, with a trivial `demo` integration (a fake light and sensor that changes every few seconds) used for development and API tests.
4. API server: auth, envelope, `subscribe` with snapshot, `get_*`, `send_command`. Then the CLI commands that cover them (`status`, `entities`, `state`, `watch`, `cmd`).
5. Shared MQTT layer and the generic MQTT integration against `aedes`; run it against a real Tasmota or Shelly device.
6. Recorder with batching, `get_history`, `hac history`, retention job.
7. zigbee2mqtt integration; real-device test; `permit_join` action and the `integration_action` API path.
8. Automation engine with hot reload, `get_automations`, `reload_automation`, and two sample automations (motion light, time-based).
9. ESPHome native API: plaintext first, Noise encryption second, mDNS discovery last.
10. Z-Wave JS client: node dump mapping, value updates, `set_value`, inclusion and exclusion actions.
11. Remaining API and CLI surface: rename with alias, areas, device and entity metadata, config get and set, reload, `/api/schema`, `hac backup`.
12. Hardening: shutdown path, memory soak test for one hour, slow-client disconnect, error-code coverage, README per package, `CONTRIBUTING.md` checklist.

**After milestone 1** (not in scope, listed so designs leave room): web UI against the API, Matter via matter.js, Bluetooth, cloud integrations, custom roles and OIDC group mapping, scenes and groups, worker-thread isolation for integrations.

## Decisions made and open questions

These decisions are settled; the agent should not relitigate them. The open questions need an answer from the owner before the step that depends on them.

**Decisions**

| Decision | Choice | Why |
| --- | --- | --- |
| Runtime | Bun, not Node | Built-in SQLite, server, WebSocket, and test runner; fewer dependencies |
| Zigbee and Z-Wave | External zigbee2mqtt and Z-Wave JS server | Thousands of supported devices for free; no radio stack to maintain |
| ESPHome | Own native API client | Small, documented protocol; avoids an MQTT hop and gets entity metadata |
| Generic MQTT | Honor the HA discovery convention | It is the de facto standard that devices already speak; no HA code or dependency involved |
| State | Device-confirmed only, never optimistic | Honest UI; `confirm` flag gives automations certainty when they need it |
| Command queueing | Per-entity, latest-wins | Protects slow radios from slider spam; preserves order |
| Config | TOML file plus typed API, no YAML | Validated once by Zod; file and API stay in sync |
| Automations | TypeScript modules with hot reload | Real language, real types; no custom DSL |
| Integration isolation | In-process now, worker-ready contract | Keeps milestone 1 small without closing the door |
| Auth | Local users, fixed roles, scoped grants; OIDC behind the same interface | Permissions must be on from the first integration; custom roles later reuse the grant model; `CommandSource.userId` carries the actor on every command |

**Open questions**

- [ ] Target hardware for the first deployment (Pi 4, Pi 5, a mini PC)? Affects whether the 200 MB budget is tight or generous.
- [ ] Which real devices are available for fixture recording in step 5 (Tasmota or Shelly model), step 7 (Zigbee devices), step 9 (ESPHome boards), and step 10 (Z-Wave devices)?
