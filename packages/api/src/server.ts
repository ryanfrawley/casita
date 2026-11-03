// The API server: one WebSocket endpoint for reads, writes, and live events, plus a small
// HTTP surface. Permissions are enforced here (the read filter) and in the router policy.

import {
  type AreaId,
  type AutomationStore,
  type AutomationSummary,
  type Bus,
  CommandError,
  type CommandPolicy,
  type CommandRouter,
  type CommandSource,
  type ConfigStore,
  CoreError,
  type CoreEvent,
  type Device,
  type DeviceId,
  type Entity,
  type EntityId,
  errorMessage,
  type HandlerStatus,
  type IntegrationHost,
  jsonSchemaOf,
  type Logger,
  type PageRuntime,
  type PageStore,
  type Recorder,
  type Registry,
  type SensorRuntime,
  type SensorStore,
  type SensorSummary,
  type StateRecord,
  type StateStore,
} from "@casita/core";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import type { AuditAction, Auth, Principal, Session, User } from "./auth/auth.ts";
import type { OidcProvider } from "./auth/oidc.ts";
import { atLeast, type Level, type Role } from "./auth/permissions.ts";
import {
  ADMIN_ONLY,
  authRequestSchema,
  CLOSE,
  ERROR_CODES,
  type ErrorCode,
  loginRequestSchema,
  PROTOCOL_VERSION,
  type Request,
  type RequestOf,
  type RequestType,
  requestSchema,
  type ServerMessage,
  serverMessageSchema,
} from "./schema.ts";
import { cookieToken, sameOrigin, serveWeb, sessionCookie } from "./web.ts";

/** One line of the Automations page: a stored automation, or a page whose handlers run. */
export interface AutomationRow extends AutomationSummary {
  kind: "automation" | "page";
  status: HandlerStatus;
  error?: string;
  lastRunAt?: number;
}

/** One line of the Sensors list: a stored derived sensor, its entity and its status. */
export interface SensorRow extends SensorSummary {
  /** The entity it is reported as; unset until the runtime has registered it. */
  entityId?: string;
  status: HandlerStatus;
  error?: string;
  lastRunAt?: number;
}

export interface ApiDeps {
  bus: Bus;
  registry: Registry;
  states: StateStore;
  router: CommandRouter;
  host: IntegrationHost;
  config: ConfigStore;
  auth: Auth;
  recorder: Recorder;
  automations: AutomationStore;
  sensors: SensorStore;
  pages: PageStore;
  /** Where the pages' and automations' handlers run, for their status and runs. */
  runtime: PageRuntime;
  /** Where the derived sensors are computed, for their entities and status. */
  sensorRuntime: SensorRuntime;
  /** Writes a copy of the database and returns its path. */
  backup: () => Promise<string>;
  log: Logger;
  version: string;
  hostname?: string;
  port: number;
  /** OIDC providers by name, from `[[auth.oidc]]`. */
  oidc?: ReadonlyMap<string, { provider: OidcProvider; defaultRole: Role }>;
  /** How long a new socket has to send its auth message. */
  authTimeoutMs?: number;
  /** Login attempts allowed per IP per minute. */
  loginRateLimit?: number;
  /** A client whose unsent data exceeds this is disconnected rather than blocking the bus. */
  maxSendBufferBytes?: number;
  /** The built web app's directory; left out, the server answers only the API. */
  webDir?: string;
  now?: () => number;
}

export interface Api {
  readonly port: number;
  /** Closes every socket and stops listening. */
  stop(): Promise<void>;
}

/**
 * The first router policy: a user-issued command needs `control` on the entity.
 * Automations and the system pass; restrict those with further policies.
 */
export function requirePermission(auth: Auth, registry: Registry): CommandPolicy {
  return ({ entity, source }) => {
    if (source.kind !== "user") return;
    const user = auth.getUser(source.userId);
    const level = user && !user.disabled ? auth.levelFor(user, target(registry, entity)) : "none";
    if (level !== "control")
      throw new CommandError("forbidden", `Not permitted to control ${entity.id}`);
  };
}

const target = (registry: Registry, entity: Entity) => ({
  id: entity.id,
  domain: entity.domain,
  areaId: registry.areaOf(entity),
});

class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const forbidden = () => new ApiError("forbidden", "Not permitted");

/** What the server sends; the typed form of ServerMessage's loose event and snapshot payloads. */
type Outbound =
  | Exclude<ServerMessage, { type: "snapshot" | "event" }>
  | { type: "snapshot"; subscriptionId: number; states: StateRecord[] }
  | { type: "event"; subscriptionId: number; event: CoreEvent };

type Subscription = { events?: Set<string>; entityIds?: Set<string> };
type SocketData = {
  ip: string;
  /** The session cookie's token, kept only when the upgrade came from our own page. */
  cookieToken?: string;
  connection?: Connection;
};
type Socket = ServerWebSocket<SocketData>;

type Handlers = { [T in RequestType]: (request: RequestOf<T>) => unknown };

class Connection {
  principal?: Principal;
  private readonly subscriptions = new Map<number, Subscription>();
  private nextSubscriptionId = 1;
  /** Resolved permission level per entity; dropped whenever anything it depends on changes. */
  private readonly levels = new Map<EntityId, Level>();
  private readonly handlers: Handlers;
  /** Set by a handler that has more to send once its reply is on the wire. */
  private afterReply?: () => void;

  constructor(
    private readonly ws: Socket,
    private readonly deps: ApiDeps,
    private readonly startedAt: number,
  ) {
    this.handlers = this.createHandlers();
  }

  // ───────── inbound ─────────

  async receive(raw: string | Buffer): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      message = undefined;
    }

    if (!this.principal) {
      const auth = authRequestSchema.safeParse(message);
      const token = auth.success ? (auth.data.token ?? this.ws.data.cookieToken) : undefined;
      const principal = token ? this.deps.auth.authenticate(token) : null;
      if (!principal) {
        this.ws.close(CLOSE.unauthorized, "Authentication required");
        return;
      }
      this.principal = principal;
      this.send({
        type: "auth_ok",
        version: PROTOCOL_VERSION,
        units: this.deps.config.server.units,
      });
      return;
    }

    const id = z.object({ id: z.number().int() }).safeParse(message);
    if (!id.success) return; // nothing to address a reply to
    if (!this.deps.auth.isSessionValid(this.principal.sessionId)) {
      this.ws.close(CLOSE.unauthorized, "Session ended");
      return;
    }
    try {
      const request = requestSchema.parse(message);
      if (ADMIN_ONLY.has(request.type) && this.user.role !== "admin") throw forbidden();
      const handler = this.handlers[request.type] as (r: Request) => unknown;
      this.send({ id: request.id, ok: true, result: (await handler(request)) ?? {} });
      const afterReply = this.afterReply;
      this.afterReply = undefined;
      afterReply?.();
    } catch (err) {
      this.send({ id: id.data.id, ok: false, error: this.toError(err) });
    }
  }

  private toError(err: unknown): { code: ErrorCode; message: string } {
    if (err instanceof ApiError || err instanceof CommandError)
      return { code: err.code, message: err.message };
    if (err instanceof z.ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
        .join("; ");
      return { code: "bad_request", message: detail };
    }
    if (err instanceof CoreError && (ERROR_CODES as readonly string[]).includes(err.code)) {
      return { code: err.code as ErrorCode, message: err.message };
    }
    this.deps.log.error("request failed", { error: errorMessage(err) });
    return { code: "internal", message: "Internal error" };
  }

  // ───────── outbound ─────────

  private send(message: Outbound): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.getBufferedAmount() > (this.deps.maxSendBufferBytes ?? 4 * 1024 * 1024)) {
      this.deps.log.warn("disconnecting slow client", { ip: this.ws.data.ip });
      // Not close(): a close frame would queue behind the very data the client is not reading.
      this.ws.terminate();
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /** Streams one bus event to each matching subscription, if this user may see it. */
  deliver(event: CoreEvent): void {
    if (!this.principal) return;
    if (
      event.type === "entity_added" ||
      event.type === "entity_updated" ||
      event.type === "entity_renamed" ||
      event.type === "entity_removed" ||
      event.type === "device_updated" ||
      event.type === "device_renamed"
    ) {
      this.levels.clear();
    }
    if (this.subscriptions.size === 0 || !this.maySee(event)) return;

    const entityIds = eventEntityIds(event);
    for (const [subscriptionId, sub] of this.subscriptions) {
      if (sub.events && !sub.events.has(event.type)) continue;
      if (sub.entityIds && !entityIds.some((id) => sub.entityIds?.has(id))) continue;
      this.send({ type: "event", subscriptionId, event });
    }
  }

  /** Called when grants, the user's role, or the session change. */
  authChanged(): void {
    if (!this.principal) return;
    this.levels.clear();
    const { auth } = this.deps;
    const user = auth.getUser(this.principal.user.id);
    if (!user || user.disabled || !auth.isSessionValid(this.principal.sessionId)) {
      this.ws.close(CLOSE.unauthorized, "Session ended");
      return;
    }
    this.principal = { ...this.principal, user };
  }

  // ───────── permissions ─────────

  private get user(): User {
    if (!this.principal) throw new ApiError("auth", "Not authenticated");
    return this.principal.user;
  }

  private get source(): CommandSource {
    return { kind: "user", userId: this.user.id, sessionId: this.principal?.sessionId ?? "" };
  }

  private level(entity: Entity): Level {
    let level = this.levels.get(entity.id);
    if (!level) {
      level = this.deps.auth.levelFor(this.user, target(this.deps.registry, entity));
      this.levels.set(entity.id, level);
    }
    return level;
  }

  private canRead = (entity: Entity): boolean => atLeast(this.level(entity), "read");

  private canSeeDevice(device: Device): boolean {
    if (this.user.role === "admin") return true;
    return this.deps.registry
      .listEntities()
      .some((e) => e.deviceId === device.id && this.canRead(e));
  }

  private maySee(event: CoreEvent): boolean {
    const { registry, auth } = this.deps;
    switch (event.type) {
      case "state_changed":
      case "command_issued":
      case "command_failed": {
        const entity = registry.getEntity(event.entityId);
        return !!entity && this.canRead(entity);
      }
      case "entity_added":
      case "entity_updated":
      case "entity_renamed":
        return this.canRead(event.entity);
      case "entity_removed":
        // Already gone from the registry, so resolve from the event's copy without caching.
        return atLeast(auth.levelFor(this.user, target(registry, event.entity)), "read");
      case "device_added":
      case "device_updated":
      case "device_renamed":
      case "device_removed":
        return this.canSeeDevice(event.device);
      case "config_changed":
        // Everyone shows readings in the system's units, so everyone hears when they change.
        // A change to the whole block may be one too.
        return this.user.role === "admin" || ["server.units", "server", ""].includes(event.path);
      case "area_added":
      case "area_updated":
      case "area_removed":
      case "page_changed":
      case "theme_changed":
      case "components_changed":
      case "integration_status":
        return true;
      case "automation_changed":
      case "automation_status":
      case "sensor_changed":
        // A status error names the entities the automation waits on.
        return this.user.role === "admin";
      case "settings_changed":
        // Device settings are an admin's to read.
        return this.user.role === "admin";
    }
  }

  /** The entity if this user can read it; otherwise indistinguishable from one that does not exist. */
  private readable(id: string): Entity {
    const { registry } = this.deps;
    const entity = registry.getEntity(id as EntityId);
    if (entity && this.canRead(entity)) return entity;
    const renamedTo = registry.aliasTarget(id as EntityId);
    const renamed = renamedTo && registry.getEntity(renamedTo);
    throw new ApiError(
      "not_found",
      renamed && this.canRead(renamed)
        ? `${id} was renamed to ${renamedTo}`
        : `Unknown entity ${id}`,
    );
  }

  /** `userId` if given and permitted, else the caller. Only admins may act on other users. */
  private ownerOrAdmin(userId: string | undefined): string {
    if (userId === undefined || userId === this.user.id) return this.user.id;
    if (this.user.role !== "admin") throw forbidden();
    return userId;
  }

  private ownedSession(id: string, kind: Session["kind"]): Session {
    const session = this.deps.auth.getSession(id);
    const mine = session?.userId === this.user.id;
    if (!mine && this.user.role !== "admin") throw forbidden();
    if (!session || session.kind !== kind) throw new ApiError("not_found", `Unknown ${kind} ${id}`);
    return session;
  }

  /** Every stored automation with its live status, then each page that has handlers. */
  private listAutomations(): AutomationRow[] {
    const { automations, pages, runtime } = this.deps;
    const rows = automations.list().map((a) => this.automationRow(a));
    for (const { pageId, handlers } of pages.handlers()) {
      if (!handlers.length) continue;
      const page = pages.getPage(pageId);
      const live = runtime.status(`page:${pageId}`);
      rows.push({
        id: pageId,
        kind: "page",
        name: page?.name ?? pageId,
        enabled: true,
        handlers: handlers.length,
        entities: [],
        devices: [],
        status: live?.status ?? "stopped",
        error: this.user.role === "admin" ? live?.error : undefined,
        lastRunAt: live?.lastRunAt,
        updatedAt: page?.updatedAt ?? 0,
        updatedBy: page?.updatedBy,
      });
    }
    return rows;
  }

  private sensorRow(s: SensorSummary): SensorRow {
    const live = this.deps.sensorRuntime.status(s.id);
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      type: s.type,
      entities: s.entities,
      entityId: live?.entityId,
      status: live?.status ?? "stopped",
      error: this.user.role === "admin" ? live?.error : undefined,
      lastRunAt: live?.lastRunAt,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
    };
  }

  private automationRow(a: AutomationSummary): AutomationRow {
    const live = this.deps.runtime.status(`automation:${a.id}`);
    return {
      id: a.id,
      kind: "automation",
      name: a.name,
      enabled: a.enabled,
      handlers: a.handlers,
      entities: a.entities,
      devices: a.devices,
      status: live?.status ?? "stopped",
      // The error names the entities it waits on, which a member may not see.
      error: this.user.role === "admin" ? live?.error : undefined,
      lastRunAt: live?.lastRunAt,
      updatedAt: a.updatedAt,
      updatedBy: a.updatedBy,
    };
  }

  private audit(action: AuditAction, auditTarget?: string, detail?: unknown): void {
    this.deps.auth.audit({
      actorUserId: this.user.id,
      action,
      target: auditTarget,
      detail,
      ip: this.ws.data.ip,
    });
  }

  // ───────── requests ─────────

  private createHandlers(): Handlers {
    const {
      registry,
      states,
      router,
      host,
      config,
      auth,
      recorder,
      pages,
      automations,
      sensors,
      runtime,
    } = this.deps;
    const now = this.deps.now ?? Date.now;

    return {
      ping: () => ({ time: now() }),
      get_status: () => ({
        version: this.deps.version,
        protocol: PROTOCOL_VERSION,
        uptimeMs: now() - this.startedAt,
        units: config.server.units,
        integrations: host
          .list()
          .map(({ integrationId, status, error }) => ({ integrationId, status, error })),
        entities: registry.listEntities().filter(this.canRead).length,
        devices: registry.listDevices().filter((d) => this.canSeeDevice(d)).length,
      }),
      get_me: () => ({ user: this.user, sessionId: this.principal?.sessionId }),

      subscribe: (r) => {
        const subscriptionId = this.nextSubscriptionId++;
        const sub: Subscription = {
          events: r.events && new Set(r.events),
          entityIds: r.entityIds && new Set(r.entityIds),
        };
        // The reply goes first, then the snapshot; only then can the subscription see events.
        this.afterReply = () => {
          const visible = states.all().filter((s) => {
            const entity = registry.getEntity(s.entityId);
            return (
              entity && this.canRead(entity) && (!sub.entityIds || sub.entityIds.has(s.entityId))
            );
          });
          this.send({ type: "snapshot", subscriptionId, states: visible });
          this.subscriptions.set(subscriptionId, sub);
        };
        return { subscriptionId };
      },
      unsubscribe: (r) => {
        this.subscriptions.delete(r.subscriptionId);
      },

      get_states: (r) => {
        if (r.entityIds) {
          return r.entityIds.map((id) => this.readable(id)).flatMap((e) => states.get(e.id) ?? []);
        }
        return states.all().filter((s) => {
          const entity = registry.getEntity(s.entityId);
          return entity && this.canRead(entity);
        });
      },
      get_entities: (r) =>
        registry
          .listEntities()
          .filter(
            (e) =>
              this.canRead(e) &&
              (!r.domain || e.domain === r.domain) &&
              (!r.areaId || registry.areaOf(e) === r.areaId) &&
              (!r.deviceId || e.deviceId === r.deviceId),
          )
          .map((e) => ({
            ...e,
            effectiveRetention: recorder.policyFor(e),
            // What a client needs to lay an entity out: its room (own or its device's), and
            // whether it takes commands at all.
            effectiveAreaId: registry.areaOf(e),
            controllable: router.handlerFor(e.id) !== undefined,
            // What this user may do with it: `read` shows it, `control` may command it.
            level: this.level(e),
          })),
      get_history: (r) =>
        recorder.history(this.readable(r.entityId).id, r.from, r.to, {
          limit: r.limit,
          resolution: r.resolution,
          includePrevious: r.includePrevious,
        }),
      backup: async () => ({ path: await this.deps.backup() }),
      get_devices: (r) =>
        registry
          .listDevices()
          .filter((d) => this.canSeeDevice(d) && (!r.areaId || d.areaId === r.areaId)),
      get_areas: () => registry.listAreas(),

      send_command: (r) => {
        const entity = this.readable(r.entityId);
        return router.send(entity.id, r.command, this.source, { confirm: r.confirm });
      },
      send_area_command: (r) => {
        if (!registry.getArea(r.areaId as AreaId))
          throw new ApiError("not_found", `Unknown area ${r.areaId}`);
        return router.sendToArea(
          r.areaId as AreaId,
          r.command,
          this.source,
          { confirm: r.confirm },
          this.canRead,
        );
      },

      update_entity: (r) => {
        const { entityId, newId, ...patch } = r;
        let entity = registry.updateEntity(entityId as EntityId, {
          name: patch.name,
          areaId: patch.areaId as AreaId | null | undefined,
          hidden: patch.hidden,
          disabled: patch.disabled,
          icon: patch.icon,
          retention: patch.retention,
          deviceClass: patch.deviceClass,
        });
        if (newId !== undefined) entity = registry.renameEntity(entity.id, newId as EntityId);
        return entity;
      },
      update_device: (r) => {
        const { deviceId, newId, ...patch } = r;
        let device = registry.updateDevice(deviceId as DeviceId, {
          name: patch.name,
          areaId: patch.areaId as AreaId | null | undefined,
          icon: patch.icon,
        });
        if (newId !== undefined) device = registry.renameDevice(device.id, newId as DeviceId);
        return device;
      },
      delete_entity: (r) => registry.deleteEntity(r.entityId as EntityId),
      delete_device: (r) => registry.deleteDevice(r.deviceId as DeviceId),
      get_device_settings: async (r) => ({
        settings: await host.deviceSettings(r.deviceId as DeviceId),
      }),
      set_device_setting: async (r) => {
        const value = await host.setDeviceSetting(r.deviceId as DeviceId, r.key, r.value);
        this.audit("device_setting_set", r.deviceId, { key: r.key, value });
        return { key: r.key, value };
      },
      create_area: (r) => registry.createArea(r.name),
      update_area: (r) => registry.updateArea(r.areaId as AreaId, { name: r.name, icon: r.icon }),
      delete_area: (r) => registry.deleteArea(r.areaId as AreaId),

      get_page: (r) => {
        const page = pages.getPage(r.pageId);
        if (!page) throw new ApiError("not_found", `Unknown page ${r.pageId}`);
        return page;
      },
      list_pages: () => pages.listPages(),
      get_page_source: (r) => pages.getSource(r.pageId),
      check_page: (r) => ({ diagnostics: pages.check(r.source, r.pageId) }),
      save_page: (r) => {
        const result = pages.save(r.pageId, r.source, this.user.username);
        if (result.ok) this.audit("page_saved", r.pageId);
        return result;
      },
      revert_page: (r) => {
        const result = pages.revert(r.pageId, r.version, this.user.username);
        if (result.ok) this.audit("page_saved", r.pageId, { revertedTo: r.version });
        return result;
      },
      list_themes: () =>
        pages
          .listThemes()
          // The source is the admin's; viewers need only the css and the names.
          .map((theme) => (this.user.role === "admin" ? theme : { ...theme, source: undefined })),
      save_theme: (r) => {
        const result = pages.saveTheme(r.themeId, r.source, this.user.username);
        if (result.ok) this.audit("theme_saved", r.themeId);
        return result;
      },
      get_components_source: () => pages.getComponents(),
      check_components: (r) => ({ diagnostics: pages.checkComponents(r.source) }),
      save_components: (r) => {
        const result = pages.saveComponents(r.source, this.user.username);
        if (result.ok) this.audit("components_saved", "shared");
        return result;
      },

      get_automations: () => this.listAutomations(),
      get_automation_source: (r) => automations.getSource(r.automationId),
      check_automation: (r) => ({ diagnostics: automations.check(r.source) }),
      save_automation: (r) => {
        const result = automations.save(r.automationId, r.source, this.user.username);
        if (result.ok) this.audit("automation_saved", r.automationId);
        return result;
      },
      revert_automation: (r) => {
        const result = automations.revert(r.automationId, r.version, this.user.username);
        if (result.ok) this.audit("automation_saved", r.automationId, { revertedTo: r.version });
        return result;
      },
      delete_automation: (r) => {
        automations.delete(r.automationId);
        this.audit("automation_deleted", r.automationId);
        return { ok: true };
      },
      set_automation_enabled: (r) => {
        const record = automations.setEnabled(r.automationId, r.enabled);
        this.audit("automation_enabled", r.automationId, { enabled: r.enabled });
        return this.automationRow(record);
      },

      get_sensors: () => sensors.list().map((s) => this.sensorRow(s)),
      get_sensor_source: (r) => sensors.getSource(r.sensorId),
      check_sensor: (r) => ({ diagnostics: sensors.check(r.source) }),
      save_sensor: (r) => {
        const result = sensors.save(r.sensorId, r.source, this.user.username);
        if (result.ok) this.audit("sensor_saved", r.sensorId);
        return { ...result, sensor: result.sensor && this.sensorRow(result.sensor) };
      },
      revert_sensor: (r) => {
        const result = sensors.revert(r.sensorId, r.version, this.user.username);
        if (result.ok) this.audit("sensor_saved", r.sensorId, { revertedTo: r.version });
        return { ...result, sensor: result.sensor && this.sensorRow(result.sensor) };
      },
      delete_sensor: (r) => {
        sensors.delete(r.sensorId);
        this.audit("sensor_deleted", r.sensorId);
      },
      set_sensor_enabled: (r) => {
        const record = sensors.setEnabled(r.sensorId, r.enabled);
        this.audit("sensor_enabled", r.sensorId, { enabled: r.enabled });
        return this.sensorRow(record);
      },
      get_automation_runs: (r) => {
        if (!automations.get(r.automationId))
          throw new ApiError("not_found", `Unknown automation ${r.automationId}`);
        return runtime.runs(`automation:${r.automationId}`);
      },
      test_automation: async (r) => {
        if (!automations.get(r.automationId))
          throw new ApiError("not_found", `Unknown automation ${r.automationId}`);
        this.audit("automation_tested", r.automationId, {
          line: r.line,
          pretend: r.pretend,
        });
        try {
          return await runtime.test(`automation:${r.automationId}`, {
            line: r.line,
            pretend: r.pretend,
          });
        } catch (err) {
          throw new ApiError("invalid", errorMessage(err));
        }
      },

      get_integrations: () =>
        host.list().map((i) => ({
          ...i,
          configSchema: this.user.role === "admin" ? toJsonSchema(i.configSchema) : undefined,
          actions: i.actions.map((a) => ({ name: a.name, schema: toJsonSchema(a.schema) })),
        })),
      integration_action: (r) => host.runAction(r.integrationId, r.action, r.params),
      reload_integration: (r) => host.reload(r.integrationId),
      get_config: (r) => ({ path: r.path ?? "", value: config.get(r.path) ?? null }),
      set_config: async (r) => {
        await config.set(r.path, r.value);
        this.audit("config_set", r.path);
        return { path: r.path, value: config.get(r.path) ?? null };
      },

      list_users: () => auth.listUsers(),
      create_user: async (r) => {
        const user = await auth.createUser(r);
        this.audit("user_created", user.id, { username: user.username, role: user.role });
        return user;
      },
      update_user: async (r) => {
        const { userId, id: _id, type: _type, ...patch } = r;
        const user = await auth.updateUser(userId, patch);
        this.audit("user_updated", userId, {
          ...patch,
          password: patch.password ? "(changed)" : undefined,
        });
        return user;
      },
      delete_user: (r) => {
        auth.deleteUser(r.userId);
        this.audit("user_deleted", r.userId);
      },
      update_me: async (r) => {
        const user = await auth.updateUser(this.user.id, { displayName: r.displayName });
        this.audit("user_updated", user.id, { displayName: r.displayName });
        return user;
      },

      list_grants: (r) => auth.listGrants(r),
      set_grant: (r) => {
        const { id: _id, type: _type, ...input } = r;
        const grant = auth.setGrant({ ...input, createdBy: this.user.id });
        this.audit("grant_set", grant.id, input);
        return grant;
      },
      delete_grant: (r) => {
        const grant = auth.deleteGrant(r.grantId);
        this.audit("grant_deleted", grant.id, grant);
      },

      list_tokens: (r) => auth.listSessions(this.ownerOrAdmin(r.userId), "api"),
      create_token: (r) => {
        const { token, session } = auth.issueToken(this.ownerOrAdmin(r.userId), "api", r.name);
        this.audit("token_created", session.id, { name: r.name, userId: session.userId });
        return { token, ...session };
      },
      revoke_token: (r) => {
        const session = this.ownedSession(r.tokenId, "api");
        auth.revokeSession(session.id);
        this.audit("token_revoked", session.id, { userId: session.userId });
      },
      list_sessions: (r) => auth.listSessions(this.ownerOrAdmin(r.userId), "session"),
      revoke_session: (r) => {
        auth.revokeSession(this.ownedSession(r.sessionId, "session").id);
      },

      get_audit: (r) => auth.listAudit(r),
    };
  }
}

const eventEntityIds = (event: CoreEvent): string[] => {
  if ("entityId" in event) return [event.entityId];
  if (event.type === "entity_renamed") return [event.oldId, event.entity.id];
  if ("entity" in event) return [event.entity.id];
  return [];
};

const toJsonSchema = (schema: z.ZodType | undefined): unknown =>
  schema ? jsonSchemaOf(schema) : undefined;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const httpError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

export function createApi(deps: ApiDeps): Api {
  const { auth, bus, host, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const connections = new Set<Connection>();
  const loginAttempts = new Map<string, number[]>();

  const offBus = bus.onAny((event) => {
    for (const connection of connections) connection.deliver(event);
  });
  const offAuth = auth.onChange(() => {
    for (const connection of connections) connection.authChanged();
  });

  /** Who is asking: a bearer token, or the session cookie of a page this server served. */
  const caller = (req: Request_) => {
    const header = req.headers.get("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    // A cookie alone is enough to read; anything that changes state must also come from our page.
    const cookie = req.method === "GET" || sameOrigin(req) ? cookieToken(req) : undefined;
    const token = bearer ?? cookie;
    return token ? { principal: auth.authenticate(token), viaCookie: !bearer } : undefined;
  };

  /** States of OIDC logins begun from the web app, which end in a cookie and a redirect. */
  const browserLogins = new Set<string>();

  const rateLimited = (ip: string): boolean => {
    const cutoff = now() - 60_000;
    if (loginAttempts.size > 1000) {
      for (const [key, attempts] of loginAttempts) {
        if ((attempts.at(-1) ?? 0) <= cutoff) loginAttempts.delete(key);
      }
    }
    const recent = (loginAttempts.get(ip) ?? []).filter((at) => at > cutoff);
    recent.push(now());
    loginAttempts.set(ip, recent);
    return recent.length > (deps.loginRateLimit ?? 5);
  };

  async function login(req: Request_, ip: string): Promise<Response> {
    if (rateLimited(ip))
      return httpError(429, "rate_limited", "Too many login attempts; try again in a minute");
    const body = loginRequestSchema.safeParse(await req.json().catch(() => undefined));
    if (!body.success) return httpError(400, "bad_request", "Expected { username, password }");
    const result = await auth.login(body.data.username, body.data.password);
    if (!result) {
      auth.audit({ action: "login_failed", target: body.data.username.toLowerCase(), ip });
      // Deliberately the same for an unknown user and a wrong password.
      return httpError(401, "auth", "Invalid username or password");
    }
    auth.audit({ actorUserId: result.user.id, action: "login", ip });
    if (!body.data.cookie) return json(result);
    return Response.json(
      { user: result.user },
      { headers: { "Set-Cookie": sessionCookie(req, result.token) } },
    );
  }

  /** `start` redirects to the identity provider; `callback` finishes the login and issues a session. */
  async function oidcLogin(
    name: string,
    step: string,
    req: Request_,
    ip: string,
  ): Promise<Response> {
    const url = new URL(req.url);
    const entry = deps.oidc?.get(name);
    if (!entry) return httpError(404, "not_found", "No such identity provider");
    // A login begun from the web app ends back in it, signed in or told why not.
    const state = url.searchParams.get("state") ?? "";
    const browser = step === "callback" && browserLogins.delete(state);
    const back = (failed: boolean, cookie?: string) =>
      new Response(null, {
        status: 302,
        headers: {
          Location: failed ? "/?login=failed" : "/",
          ...(cookie ? { "Set-Cookie": cookie } : {}),
        },
      });
    try {
      if (step === "start") {
        if (rateLimited(ip))
          return httpError(429, "rate_limited", "Too many login attempts; try again in a minute");
        const login = await entry.provider.startLogin();
        if (url.searchParams.has("web")) {
          // Abandoned logins would otherwise collect here.
          if (browserLogins.size >= 1000) browserLogins.clear();
          browserLogins.add(login.state);
        }
        return Response.redirect(login.redirectUrl, 302);
      }
      const identity = await entry.provider.completeLogin(url.searchParams);
      const user = await auth.userForIdentity(identity, identity.claims, entry.defaultRole);
      if (!user) {
        auth.audit({ action: "login_failed", target: `${name}:${identity.subject}`, ip });
        return browser ? back(true) : httpError(401, "auth", "This account is disabled");
      }
      auth.audit({ actorUserId: user.id, action: "login", detail: { provider: name }, ip });
      const { token } = auth.issueToken(user.id, "session");
      return browser ? back(false, sessionCookie(req, token)) : json({ token, user });
    } catch (err) {
      if (browser) {
        if (!(err instanceof CoreError))
          log.error("oidc login failed", { provider: name, error: errorMessage(err) });
        return back(true);
      }
      if (err instanceof CoreError) {
        const status = err.code === "auth" ? 401 : err.code === "unavailable" ? 502 : 400;
        return httpError(status, err.code === "auth" ? "auth" : "bad_request", err.message);
      }
      log.error("oidc login failed", { provider: name, error: errorMessage(err) });
      return httpError(500, "internal", "Internal error");
    }
  }

  /** Raw history as CSV, streamed. Same read filter as the WebSocket API. */
  function historyCsv(url: URL, user: User): Response {
    const entity = deps.registry.getEntity((url.searchParams.get("entityId") ?? "") as EntityId);
    if (!entity || !atLeast(auth.levelFor(user, target(deps.registry, entity)), "read")) {
      return httpError(404, "not_found", "Unknown entity");
    }
    const from = Number(url.searchParams.get("from") ?? 0);
    const to = Number(url.searchParams.get("to") ?? now());
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return httpError(400, "bad_request", "from and to are epoch milliseconds");
    }
    const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
    const { records } = deps.recorder.history(entity.id, from, to, { resolution: "raw" });
    const rows = records as StateRecord[];
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("time,entity_id,available,state,attributes\n");
        for (const r of rows) {
          controller.enqueue(
            `${[
              new Date(r.updatedAt).toISOString(),
              r.entityId,
              r.available,
              quote(JSON.stringify(r.state)),
              quote(JSON.stringify(r.attributes ?? {})),
            ].join(",")}\n`,
          );
        }
        controller.close();
      },
    });
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${entity.id}.csv"`,
      },
    });
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: deps.hostname,
    port: deps.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ip = srv.requestIP(req)?.address ?? "unknown";
      const route = `${req.method} ${url.pathname}`;

      if (url.pathname === "/ws") {
        // The cookie counts only for a socket opened by our own page; see sameOrigin.
        const token = sameOrigin(req) ? cookieToken(req) : undefined;
        return srv.upgrade(req, { data: { ip, cookieToken: token } })
          ? undefined
          : httpError(400, "bad_request", "Expected a WebSocket");
      }
      if (route === "GET /health") {
        const integrations = host
          .list()
          .map(({ integrationId, status, error }) => ({ integrationId, status, error }));
        return json({ status: "ok", integrations });
      }
      if (route === "POST /api/auth/login") return login(req, ip);
      const oidcRoute = /^\/api\/auth\/oidc\/([^/]+)\/(start|callback)$/.exec(url.pathname);
      if (req.method === "GET" && oidcRoute)
        return oidcLogin(oidcRoute[1] ?? "", oidcRoute[2] ?? "", req, ip);
      if (route === "GET /api/auth/providers") {
        // What a login page offers, before anyone is signed in.
        return json({ oidc: [...(deps.oidc?.keys() ?? [])].map((name) => ({ name })) });
      }
      if (deps.webDir && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        return (
          (await serveWeb(deps.webDir, url.pathname)) ?? httpError(404, "not_found", "No such file")
        );
      }

      // Everything below runs as a user.
      const who = caller(req);
      if (!who?.principal) return httpError(401, "auth", "Authentication required");
      const { principal } = who;
      if (route === "POST /api/auth/logout") {
        const session = auth.getSession(principal.sessionId);
        if (session?.kind === "session") auth.revokeSession(session.id);
        auth.audit({ actorUserId: principal.user.id, action: "logout", ip });
        return Response.json(
          {},
          who.viaCookie ? { headers: { "Set-Cookie": sessionCookie(req, null) } } : undefined,
        );
      }
      if (route === "GET /api/history.csv") return historyCsv(url, principal.user);
      if (route === "GET /api/schema") {
        return json({
          version: PROTOCOL_VERSION,
          auth: toJsonSchema(authRequestSchema),
          requests: toJsonSchema(requestSchema),
          messages: toJsonSchema(serverMessageSchema),
        });
      }
      return httpError(404, "not_found", "No such route");
    },
    websocket: {
      open(ws) {
        const connection = new Connection(ws, deps, startedAt);
        ws.data.connection = connection;
        connections.add(connection);
        // A socket that never authenticates does not get to stay open.
        setTimeout(() => {
          if (!connection.principal) ws.close(CLOSE.unauthorized, "Authentication timed out");
        }, deps.authTimeoutMs ?? 10_000).unref();
      },
      message(ws, raw) {
        void ws.data.connection?.receive(raw);
      },
      close(ws) {
        if (ws.data.connection) connections.delete(ws.data.connection);
      },
    },
  });

  log.info("api listening", { address: server.hostname, port: server.port });
  return {
    port: server.port ?? deps.port,
    async stop() {
      offBus();
      offAuth();
      await server.stop(true);
    },
  };
}

// The DOM Request type, which `Request` from ./schema.ts shadows in this file.
type Request_ = globalThis.Request;
