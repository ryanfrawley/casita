// core/host.ts
// Loads the integration instances named in config, hands each an IntegrationContext,
// and manages lifecycle: starting → running → error (with backoff) → stopped.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ConfigStore, InstanceConfig, IntegrationCatalog } from "./config.ts";
import { CoreError } from "./errors.ts";
import type { LoggerFactory } from "./log.ts";
import type { Registry } from "./registry.ts";
import type { CommandRouter } from "./router.ts";
import { createScheduler } from "./scheduler.ts";
import { checkSetting } from "./settings.ts";
import type { StateStore } from "./state.ts";
import { createStorage } from "./storage.ts";
import type {
  CommandHandler,
  DeviceId,
  DeviceSetting,
  DeviceSettingsProvider,
  EntityId,
  EventBus,
  IntegrationContext,
  IntegrationStatus,
  Logger,
  SettingValue,
} from "./types.ts";
import { errorMessage } from "./util.ts";

export interface HostDeps {
  db: Database;
  bus: EventBus;
  registry: Registry;
  states: StateStore;
  router: CommandRouter;
  config: ConfigStore;
  integrations: IntegrationCatalog;
  logFor: LoggerFactory;
  timezone: string;
  /** Retry delay after a failed setup: base, doubling, capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** How long a teardown function gets before the host moves on. */
  teardownTimeoutMs?: number;
  now?: () => number;
  /**
   * Integration ids that are never configured instances but always loaded (Casa's derived
   * sensors), so their entities are not orphaned.
   */
  alwaysLoaded?: readonly string[];
}

type Action = { schema: z.ZodType; handler: (params: unknown) => Promise<unknown> };

interface Instance {
  id: string;
  type: string;
  name: string;
  status: IntegrationStatus;
  error?: string;
  since: number;
  log: Logger;
  /** One per setup attempt; aborted on failure, reload, or stop. */
  abort?: AbortController;
  teardown?: () => void | Promise<void>;
  actions: Map<string, Action>;
  settings?: DeviceSettingsProvider;
  handlers: Map<EntityId, () => void>;
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
}

export interface InstanceInfo {
  integrationId: string;
  type: string;
  name: string;
  status: IntegrationStatus;
  error?: string;
  since: number;
  configSchema?: z.ZodType;
  actions: { name: string; schema: z.ZodType }[];
  /** Its devices may have settings: `get_device_settings` lists them. */
  deviceSettings: boolean;
}

/** A schema as JSON Schema, as the caller would write its input; `{}` when it can't be. */
export function jsonSchemaOf(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return {};
  }
}

/**
 * A provider's own failure (its transport is down, the device refused) with its message, as
 * `unavailable`: an integration can't throw a CoreError, and a bare Error reads as internal.
 */
async function fromProvider<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof CoreError) throw err;
    throw new CoreError("unavailable", errorMessage(err));
  }
}

export class IntegrationHost {
  private readonly instances = new Map<string, Instance>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: HostDeps) {
    this.log = deps.logFor({ service: "host" });
    this.now = deps.now ?? Date.now;
  }

  /** Starts every configured instance. Resolves once each has finished its first setup attempt. */
  async start(): Promise<void> {
    const { bus, registry, config } = this.deps;
    // Command handlers are keyed by entity id, so they follow a rename.
    this.offs.push(
      bus.on("entity_renamed", (e) => {
        const instance = this.instances.get(e.entity.integrationId);
        const off = instance?.handlers.get(e.oldId);
        if (!instance || !off) return;
        const handler = this.deps.router.handlerFor(e.oldId);
        off();
        instance.handlers.delete(e.oldId);
        if (handler)
          instance.handlers.set(
            e.entity.id,
            this.deps.router.registerHandler(e.entity.id, handler),
          );
      }),
      bus.on("config_changed", (e) => {
        if (e.path.startsWith("integration."))
          void this.sync(e.path.split(".").slice(1, 3).join("."));
      }),
    );

    const configured = config.instances();
    registry.markOrphans(this.loaded(configured));
    await Promise.all(configured.map((c) => this.startInstance(c)));
  }

  /** Aborts every instance and waits for teardowns (bounded by the teardown timeout). */
  async stop(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    await Promise.all([...this.instances.values()].map((i) => this.stopInstance(i, "stopped")));
  }

  list(): InstanceInfo[] {
    return [...this.instances.values()].map((i) => ({
      integrationId: i.id,
      type: i.type,
      name: i.name,
      status: i.status,
      error: i.error,
      since: i.since,
      configSchema: this.deps.integrations.get(i.type)?.configSchema,
      actions: [...i.actions].map(([name, action]) => ({ name, schema: action.schema })),
      deviceSettings: i.settings !== undefined,
    }));
  }

  /**
   * What a Casa `run` may reach: every configured instance, and the actions of each running
   * one with their parameters as JSON Schema. One not running yet still resolves by name.
   */
  runnable(): { id: string; actions?: { name: string; schema: unknown }[] }[] {
    const ids = new Set(this.deps.config.instances().map((c) => c.id));
    for (const id of this.instances.keys()) ids.add(id);
    return [...ids].map((id) => {
      const instance = this.instances.get(id);
      if (instance?.status !== "running") return { id };
      return {
        id,
        actions: [...instance.actions].map(([name, action]) => ({
          name,
          schema: jsonSchemaOf(action.schema),
        })),
      };
    });
  }

  /** A device's settings, from its integration; empty when the integration keeps none. */
  async deviceSettings(deviceId: DeviceId): Promise<DeviceSetting[]> {
    const { provider } = this.settingsOf(deviceId);
    return provider ? fromProvider(() => provider.list(deviceId)) : [];
  }

  /** Checks a value against the setting its integration describes, then has it sent. */
  async setDeviceSetting(
    deviceId: DeviceId,
    key: string,
    value: SettingValue,
  ): Promise<SettingValue> {
    const { provider } = this.settingsOf(deviceId);
    const setting = provider
      ? (await fromProvider(() => provider.list(deviceId))).find((c) => c.key === key)
      : undefined;
    if (!provider || !setting)
      throw new CoreError("not_found", `${deviceId} has no setting "${key}"`);
    const checked = checkSetting(setting, value);
    // The instance may have stopped or reloaded while the list was read; this provider is
    // then gone, and the change would go nowhere.
    if (this.settingsOf(deviceId).provider !== provider)
      throw new CoreError("unavailable", `${deviceId}'s integration restarted; try again`);
    await fromProvider(() => provider.set(deviceId, key, checked));
    return checked;
  }

  private settingsOf(deviceId: DeviceId): {
    instance: Instance;
    provider?: DeviceSettingsProvider;
  } {
    const device = this.deps.registry.getDevice(deviceId);
    if (!device) throw new CoreError("not_found", `Unknown device ${deviceId}`);
    const instance = this.instances.get(device.integrationId);
    if (!instance || device.orphaned)
      throw new CoreError("unavailable", `${device.integrationId} is not loaded`);
    // Stopped, failed or starting: its provider, if it has one, is gone or not ready.
    if (instance.status !== "running")
      throw new CoreError("unavailable", `${instance.id} is not running`);
    return { instance, provider: instance.settings };
  }

  /** Aborts the instance's signal, waits for teardown, and runs setup again with current config. */
  async reload(integrationId: string): Promise<void> {
    if (!this.instances.has(integrationId)) {
      throw new CoreError("not_found", `Unknown integration instance ${integrationId}`);
    }
    await this.sync(integrationId);
  }

  async runAction(integrationId: string, name: string, params: unknown): Promise<unknown> {
    const instance = this.instances.get(integrationId);
    if (!instance)
      throw new CoreError("not_found", `Unknown integration instance ${integrationId}`);
    const action = instance.actions.get(name);
    if (!action) throw new CoreError("not_found", `${integrationId} has no action "${name}"`);
    if (instance.status !== "running") {
      throw new CoreError("unavailable", `${integrationId} is not running`);
    }
    const parsed = action.schema.safeParse(params ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new CoreError("invalid", `Invalid parameters for ${name}: ${detail}`);
    }
    return action.handler(parsed.data);
  }

  // ───────── lifecycle ─────────

  /** Brings one instance in line with config: restart it, start it, or remove it. */
  private async sync(integrationId: string): Promise<void> {
    const configured = this.deps.config.instances();
    const existing = this.instances.get(integrationId);
    if (existing) await this.stopInstance(existing, "stopped");
    const wanted = configured.find((c) => c.id === integrationId);
    if (wanted) {
      await this.startInstance(wanted);
    } else {
      this.instances.delete(integrationId);
      this.deps.db
        .query("DELETE FROM integration_status WHERE integration_id = ?")
        .run(integrationId);
    }
    this.deps.registry.markOrphans(this.loaded(configured));
  }

  private loaded(configured: InstanceConfig[]): Set<string> {
    return new Set([...configured.map((c) => c.id), ...(this.deps.alwaysLoaded ?? [])]);
  }

  private async startInstance(config: InstanceConfig): Promise<void> {
    let instance = this.instances.get(config.id);
    if (!instance) {
      instance = {
        id: config.id,
        type: config.type,
        name: config.name,
        status: "stopped",
        since: this.now(),
        log: this.deps.logFor({ integration: config.type, instance: config.name }),
        actions: new Map(),
        handlers: new Map(),
        attempt: 0,
      };
      this.instances.set(config.id, instance);
    }
    // Invalid config is surfaced and never retried; only a config change can fix it.
    if (config.error) {
      this.setStatus(instance, "error", config.error);
      return;
    }
    await this.attempt(instance, config);
  }

  private async attempt(instance: Instance, config: InstanceConfig): Promise<void> {
    const integration = this.deps.integrations.get(instance.type);
    if (!integration) return;
    const abort = new AbortController();
    instance.abort = abort;
    this.setStatus(instance, "starting");

    try {
      const teardown = await integration.setup(
        this.createContext(instance, config.config, abort.signal),
      );
      if (abort.signal.aborted) {
        // Stopped or reloaded while setting up; the late teardown still has to run.
        await Promise.resolve(teardown?.()).catch(() => {});
        return;
      }
      instance.teardown = teardown ?? undefined;
      instance.attempt = 0;
      this.setStatus(instance, "running");
    } catch (err) {
      if (abort.signal.aborted) return;
      abort.abort();
      this.release(instance);
      this.setStatus(instance, "error", errorMessage(err));
      const base = this.deps.backoffBaseMs ?? 1000;
      const delay = Math.min(base * 2 ** instance.attempt, this.deps.backoffMaxMs ?? 60_000);
      instance.attempt++;
      instance.log.error("setup failed; retrying", { error: errorMessage(err), retryInMs: delay });
      instance.retry = setTimeout(() => void this.attempt(instance, config), delay);
    }
  }

  private async stopInstance(instance: Instance, status: IntegrationStatus): Promise<void> {
    clearTimeout(instance.retry);
    instance.retry = undefined;
    instance.attempt = 0;
    instance.abort?.abort();
    instance.abort = undefined;
    const teardown = instance.teardown;
    instance.teardown = undefined;
    if (teardown) {
      const timeoutMs = this.deps.teardownTimeoutMs ?? 5000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          teardown(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`teardown exceeded ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        instance.log.warn("teardown failed", { error: errorMessage(err) });
      } finally {
        clearTimeout(timer);
      }
    }
    this.release(instance);
    this.setStatus(instance, status);
  }

  /** Drops what an attempt registered with the core and marks its entities unavailable. */
  private release(instance: Instance): void {
    for (const off of instance.handlers.values()) off();
    instance.handlers.clear();
    instance.actions.clear();
    instance.settings = undefined;
    for (const entity of this.deps.registry.listEntities()) {
      if (entity.integrationId === instance.id)
        this.deps.states.setAvailable(instance.id, entity.id, false);
    }
  }

  private setStatus(instance: Instance, status: IntegrationStatus, error?: string): void {
    if (instance.status === status && instance.error === error) return;
    instance.status = status;
    instance.error = error;
    instance.since = this.now();
    this.deps.db
      .query(
        `INSERT INTO integration_status (integration_id, status, error, since) VALUES (?, ?, ?, ?)
         ON CONFLICT (integration_id) DO UPDATE SET status = excluded.status, error = excluded.error,
           since = excluded.since`,
      )
      .run(instance.id, status, error ?? null, instance.since);
    this.deps.bus.emit({ type: "integration_status", integrationId: instance.id, status, error });
  }

  // ───────── context ─────────

  private createContext(
    instance: Instance,
    config: unknown,
    signal: AbortSignal,
  ): IntegrationContext<unknown> {
    const { db, registry, states, router, timezone } = this.deps;
    const { id, log } = instance;
    const live = (what: string) => {
      if (signal.aborted)
        throw new CoreError("stopped", `${id} called ${what} after it was unloaded`);
    };

    return {
      instanceId: id,
      config,
      log,
      storage: createStorage(db, id, this.now),
      scheduler: createScheduler(signal, timezone, log),
      signal,

      registerDevice: (device) => {
        live("registerDevice");
        return registry.registerDevice(id, device);
      },
      registerEntity: (input, onCommand) => {
        live("registerEntity");
        const entity = registry.registerEntity(id, input);
        instance.handlers.get(entity.id)?.();
        instance.handlers.delete(entity.id);
        if (onCommand) {
          instance.handlers.set(
            entity.id,
            router.registerHandler(
              entity.id, // The router validated the command's domain against the entity before dispatch.
              onCommand as unknown as CommandHandler,
            ),
          );
        }
        return entity;
      },
      removeEntity: (entityId) => {
        live("removeEntity");
        registry.removeEntity(id, entityId);
        instance.handlers.get(entityId)?.();
        instance.handlers.delete(entityId);
      },
      removeDevice: (deviceId) => {
        live("removeDevice");
        const entityIds = registry
          .listEntities()
          .filter((e) => e.deviceId === deviceId)
          .map((e) => e.id);
        registry.removeDevice(id, deviceId);
        for (const entityId of entityIds) {
          instance.handlers.get(entityId)?.();
          instance.handlers.delete(entityId);
        }
      },
      // Late reports from a transport that is still winding down are dropped, not errors.
      reportState: (entityId, state, attributes) => {
        if (signal.aborted) return;
        try {
          states.report(id, entityId, state, attributes);
        } catch (err) {
          this.log.error("integration bug: rejected state report", {
            integration: instance.type,
            instance: instance.name,
            entityId,
            error: errorMessage(err),
          });
          throw err;
        }
      },
      setAvailable: (entityId, available) => {
        if (signal.aborted) return;
        states.setAvailable(id, entityId, available);
      },
      registerAction: (name, schema, handler) => {
        live("registerAction");
        instance.actions.set(name, { schema, handler: handler as Action["handler"] });
      },
      provideDeviceSettings: (provider) => {
        live("provideDeviceSettings");
        instance.settings = provider;
      },
      settingsChanged: (deviceId) => {
        if (signal.aborted) return;
        if (registry.getDevice(deviceId)?.integrationId !== id) return;
        this.deps.bus.emit({ type: "settings_changed", deviceId });
      },
    };
  }
}
