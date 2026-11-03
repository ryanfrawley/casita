// A stand-in IntegrationContext for integration unit tests. It records what the integration
// registers and reports, and lets a test send commands and run actions, without the core.

import type {
  Attributes,
  Command,
  Device,
  DeviceId,
  DeviceSettingsProvider,
  Entity,
  EntityId,
  EntityState,
  IntegrationContext,
  Logger,
  Scheduler,
} from "@casita/core/types";
import type { z } from "zod";

/** The core's rule, near enough: a slug of the name, `_2` and up when taken. */
function deviceSlug(name: string, taken: ReadonlyMap<DeviceId, unknown>): DeviceId {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed";
  let id = base;
  for (let n = 2; taken.has(id as DeviceId); n++) id = `${base}_${n}`;
  return id as DeviceId;
}

export interface TestContext<C> {
  ctx: IntegrationContext<C>;
  devices: Map<DeviceId, Device>;
  entities: Map<EntityId, Entity>;
  /** Latest state per entity, as the state store would hold it. */
  states: Map<EntityId, { state: EntityState; attributes?: Attributes; available: boolean }>;
  /** Every setAvailable call, in order. */
  availability: { entityId: EntityId; available: boolean }[];
  /** Every reportState call, in order. */
  reports: { entityId: EntityId; state: EntityState; attributes?: Attributes }[];
  logs: { level: keyof Logger; msg: string; data?: unknown }[];
  storage: Map<string, unknown>;
  /** The entity with this uniqueId; throws if it was never registered. */
  entity(uniqueId: string): Entity;
  /** The current state of the entity with this uniqueId. */
  state(
    uniqueId: string,
  ): { state: EntityState; attributes?: Attributes; available: boolean } | undefined;
  /** Delivers a command to the entity's handler, as the router would. */
  command(uniqueId: string, command: Command): Promise<void>;
  runAction(name: string, params: unknown): Promise<unknown>;
  /** What the integration passed to provideDeviceSettings, if anything. */
  readonly settings: DeviceSettingsProvider | undefined;
  /** Every settingsChanged call, in order. */
  settingsChanges: DeviceId[];
  /** Fires ctx.signal, as an unload or reload would. */
  abort(): void;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";

export function createTestContext<C>(config: C, instanceId = "test.main"): TestContext<C> {
  const controller = new AbortController();
  const { signal } = controller;
  const devices = new Map<DeviceId, Device>();
  const entities = new Map<EntityId, Entity>();
  const states: TestContext<C>["states"] = new Map();
  const reports: TestContext<C>["reports"] = [];
  const availability: TestContext<C>["availability"] = [];
  const logs: TestContext<C>["logs"] = [];
  const storage = new Map<string, unknown>();
  const handlers = new Map<EntityId, (command: Command) => Promise<void>>();
  const actions = new Map<
    string,
    { schema: z.ZodType; handler: (params: unknown) => Promise<unknown> }
  >();
  let settings: DeviceSettingsProvider | undefined;
  const settingsChanges: DeviceId[] = [];

  const log = Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (msg: string, data?: unknown) => void logs.push({ level, msg, data }),
    ]),
  ) as unknown as Logger;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  signal.addEventListener("abort", () => {
    for (const timer of timers) clearTimeout(timer);
  });
  const scheduler: Scheduler = {
    every(ms, fn) {
      const timer = setInterval(() => void fn(), ms);
      timers.add(timer);
      return () => clearInterval(timer);
    },
    after(ms, fn) {
      const timer = setTimeout(() => void fn(), ms);
      timers.add(timer);
      return () => clearTimeout(timer);
    },
    cron() {
      throw new Error("cron is not available in the test context");
    },
  };

  const byUniqueId = (uniqueId: string): Entity => {
    const entity = [...entities.values()].find((e) => e.uniqueId === uniqueId);
    if (!entity) throw new Error(`No entity with uniqueId ${uniqueId}`);
    return entity;
  };
  const owned = (id: EntityId) => {
    if (!entities.has(id)) throw new Error(`${instanceId} did not register ${id}`);
  };

  const ctx: IntegrationContext<C> = {
    instanceId,
    config,
    log,
    signal,
    scheduler,
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      set: async (key, value) => void storage.set(key, value),
      delete: async (key) => void storage.delete(key),
    },
    registerDevice(input) {
      const existing = [...devices.values()].find((d) => d.uniqueId === input.uniqueId);
      const device: Device = {
        ...existing,
        ...input,
        id: existing?.id ?? deviceSlug(input.name, devices),
        integrationId: instanceId,
      };
      devices.set(device.id, device);
      return device;
    },
    registerEntity(input, onCommand) {
      const existing = [...entities.values()].find((e) => e.uniqueId === input.uniqueId);
      let id = existing?.id;
      if (!id) {
        const base = `${input.domain}.${slug(input.slug ?? input.name)}`;
        id = base as EntityId;
        for (let n = 2; entities.has(id); n++) id = `${base}_${n}` as EntityId;
      }
      const entity = {
        id,
        uniqueId: input.uniqueId,
        domain: input.domain,
        integrationId: instanceId,
        deviceId: input.deviceId,
        name: input.name,
        capabilities: input.capabilities ?? {},
      };
      entities.set(id, entity);
      if (onCommand) handlers.set(id, onCommand as unknown as (command: Command) => Promise<void>);
      else handlers.delete(id);
      return entity;
    },
    removeEntity(id) {
      owned(id);
      entities.delete(id);
      states.delete(id);
      handlers.delete(id);
    },
    removeDevice(id) {
      if (!devices.has(id)) throw new Error(`${instanceId} did not register ${id}`);
      for (const entity of entities.values()) {
        if (entity.deviceId === id) ctx.removeEntity(entity.id);
      }
      devices.delete(id);
    },
    reportState(id, state, attributes) {
      owned(id);
      reports.push({ entityId: id, state, attributes });
      states.set(id, {
        state,
        attributes: attributes ?? states.get(id)?.attributes,
        available: true,
      });
    },
    setAvailable(id, available) {
      owned(id);
      availability.push({ entityId: id, available });
      const current = states.get(id);
      if (current) states.set(id, { ...current, available });
    },
    registerAction(name, schema, handler) {
      actions.set(name, { schema, handler: handler as (params: unknown) => Promise<unknown> });
    },
    provideDeviceSettings(provider) {
      settings = provider;
    },
    settingsChanged(id) {
      settingsChanges.push(id);
    },
  };

  return {
    ctx,
    devices,
    entities,
    states,
    reports,
    availability,
    logs,
    storage,
    entity: byUniqueId,
    state: (uniqueId) => states.get(byUniqueId(uniqueId).id),
    async command(uniqueId, command) {
      const entity = byUniqueId(uniqueId);
      const handler = handlers.get(entity.id);
      if (!handler) throw new Error(`${entity.id} is read-only`);
      await handler(command);
    },
    async runAction(name, params) {
      const action = actions.get(name);
      if (!action) throw new Error(`No action ${name}`);
      return action.handler(action.schema.parse(params));
    },
    get settings() {
      return settings;
    },
    settingsChanges,
    abort: () => controller.abort(),
  };
}
