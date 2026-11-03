// casa/derived.ts
// Runs every derived sensor: an entity of the `casa.sensors` integration whose state is a
// Casa expression over its inputs, computed whenever one of them changes. One registration
// per sensor, made on start and again when it changes, reporting through the state store as
// an integration does.

import type { LoggerFactory } from "../log.ts";
import type {
  Area,
  BinarySensorClass,
  Device,
  Entity,
  EntityId,
  EntityInput,
  EntityState,
  EventBus,
  SensorClass,
  StateRecord,
} from "../types.ts";
import { errorMessage } from "../util.ts";
import type { CSensor } from "./compiled.ts";
import { type Env, evaluate, stateValue, tracking } from "./eval.ts";
import type { HandlerStatus } from "./runtime.ts";
import type { SensorStore } from "./sensors.ts";
import { type Host, isAbsent, isEntity, type Value } from "./values.ts";

/** The integration id derived sensors report under; never a configured instance. */
export const SENSOR_INTEGRATION = "casa.sensors";

export interface SensorRuntimeDeps {
  sensors: SensorStore;
  bus: EventBus;
  states: {
    get(id: EntityId): StateRecord | undefined;
    report(integrationId: string, id: EntityId, state: EntityState): void;
    setAvailable(integrationId: string, id: EntityId, available: boolean): void;
  };
  registry: {
    registerEntity(integrationId: string, input: EntityInput): Entity;
    removeEntity(integrationId: string, id: EntityId): void;
    getEntity(id: EntityId): Entity | undefined;
    listEntities(): Entity[];
    listDevices(): Device[];
    listAreas(): Area[];
  };
  logFor: LoggerFactory;
  timezone: string;
  now?: () => number;
}

export interface SensorInfo {
  sensorId: string;
  /** The entity the sensor is reported as. */
  entityId: string;
  status: HandlerStatus;
  error?: string;
  lastRunAt?: number;
}

interface Live {
  id: string;
  entityId: EntityId;
  compiled: CSensor;
  enabled: boolean;
  /** Entity ids a computation read, as well as those the inputs name. */
  deps: Set<string>;
  status: HandlerStatus;
  error?: string;
  lastRunAt?: number;
}

const domainOf = (sensor: CSensor): "sensor" | "binary_sensor" =>
  sensor.type === "Bool" ? "binary_sensor" : "sensor";

export class SensorRuntime {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];
  private readonly log;

  constructor(private readonly deps: SensorRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.logFor({ service: "casa", source: SENSOR_INTEGRATION });
  }

  start(): void {
    for (const sensor of this.deps.sensors.list()) this.register(sensor.id);
    const { bus } = this.deps;
    this.offs.push(
      bus.on("sensor_changed", (e) => this.register(e.sensorId)),
      bus.on("state_changed", (e) => {
        for (const live of this.live.values()) {
          if (live.enabled && live.deps.has(e.entityId)) this.compute(live);
        }
      }),
      // An input that goes or comes back changes what a sensor can read.
      bus.on("entity_removed", () => this.recompute()),
      bus.on("entity_renamed", () => this.recompute()),
      bus.on("device_renamed", () => this.recompute()),
      bus.on("entity_added", (e) => {
        if (e.entity.integrationId !== SENSOR_INTEGRATION) this.recompute();
      }),
    );
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.live.clear();
  }

  /** Every sensor's entity and status, for the API and the tests. */
  list(): SensorInfo[] {
    return [...this.live.values()].map((l) => this.info(l));
  }

  status(id: string): SensorInfo | undefined {
    const live = this.live.get(id);
    return live ? this.info(live) : undefined;
  }

  /** Registers the stored sensor as an entity, or drops the entity when the store lost it. */
  register(id: string): void {
    const record = this.deps.sensors.get(id);
    const current = this.live.get(id);
    if (!record) {
      this.live.delete(id);
      const entity = this.entityFor(id);
      if (entity) this.deps.registry.removeEntity(SENSOR_INTEGRATION, entity.id);
      if (current) this.emitStatus(id, "stopped");
      return;
    }
    const domain = domainOf(record.compiled);
    // A sensor whose type moved between words and yes/no is a new entity: the domain is in
    // the id, and the history of the old one would not read as the new one's.
    const existing = this.entityFor(id);
    if (existing && existing.domain !== domain) {
      this.deps.registry.removeEntity(SENSOR_INTEGRATION, existing.id);
    }
    const entity = this.deps.registry.registerEntity(SENSOR_INTEGRATION, {
      uniqueId: id,
      domain,
      name: record.name,
      slug: id,
    });
    const live: Live = {
      id,
      entityId: entity.id,
      compiled: record.compiled,
      enabled: record.enabled,
      deps: new Set(record.entities),
      status: "stopped",
      lastRunAt: current?.lastRunAt,
    };
    this.live.set(id, live);
    if (!record.enabled) {
      this.deps.states.setAvailable(SENSOR_INTEGRATION, entity.id, false);
      this.setStatus(live, "stopped");
      return;
    }
    this.setStatus(live, "running");
    this.compute(live);
  }

  /** Computes the value from the inputs as they stand, and reports it. */
  private compute(live: Live): void {
    const { compiled } = live;
    const deps = new Set<string>();
    const host = tracking(this.host(), deps);
    const vars = new Map<string, Value>();
    const env: Env = { host, vars };
    live.lastRunAt = this.now();
    try {
      let missing: string | undefined;
      for (const input of compiled.inputs) {
        const value = evaluate(input.value, env);
        vars.set(input.name, value);
        missing ??= this.unavailable(value);
      }
      if (missing) {
        this.deps.states.setAvailable(SENSOR_INTEGRATION, live.entityId, false);
        this.clearError(live);
        return;
      }
      const value = evaluate(compiled.value, env);
      const state = this.stateOf(compiled, value);
      if (state) this.deps.states.report(SENSOR_INTEGRATION, live.entityId, state);
      else this.deps.states.setAvailable(SENSOR_INTEGRATION, live.entityId, false);
      this.clearError(live);
    } catch (err) {
      const error = `line ${compiled.line}: ${errorMessage(err)}`;
      this.log.error("sensor failed", { sensor: live.id, error });
      this.deps.states.setAvailable(SENSOR_INTEGRATION, live.entityId, false);
      this.setStatus(live, "error", error);
    } finally {
      for (const d of deps) if (d.startsWith("state:")) live.deps.add(d.slice("state:".length));
    }
  }

  /** The id of an input entity that is gone or unavailable, if any. */
  private unavailable(value: Value): string | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const gone = this.unavailable(item);
        if (gone) return gone;
      }
      return undefined;
    }
    if (!isEntity(value)) return isAbsent(value) ? "an input" : undefined;
    const record = this.deps.states.get(value.id as EntityId);
    return record?.available ? undefined : value.id;
  }

  /** The value as an entity state; undefined for a Bool with no answer. */
  private stateOf(sensor: CSensor, value: Value): EntityState | undefined {
    const absent = isAbsent(value);
    switch (sensor.type) {
      case "Bool":
        if (typeof value !== "boolean") return undefined;
        return {
          domain: "binary_sensor",
          on: value,
          ...(sensor.class ? { deviceClass: sensor.class as BinarySensorClass } : {}),
        };
      case "Number":
        return {
          domain: "sensor",
          value: typeof value === "number" && Number.isFinite(value) ? value : null,
          ...(sensor.unit ? { unit: sensor.unit } : {}),
          ...(sensor.class ? { deviceClass: sensor.class as SensorClass } : {}),
        };
      case "String":
        return {
          domain: "sensor",
          value: absent ? null : typeof value === "string" ? value : String(value),
        };
    }
  }

  private recompute(): void {
    for (const live of this.live.values()) if (live.enabled) this.compute(live);
  }

  private entityFor(id: string): Entity | undefined {
    return this.deps.registry
      .listEntities()
      .find((e) => e.integrationId === SENSOR_INTEGRATION && e.uniqueId === id);
  }

  private info(live: Live): SensorInfo {
    return {
      sensorId: live.id,
      entityId: live.entityId,
      status: live.status,
      error: live.error,
      lastRunAt: live.lastRunAt,
    };
  }

  private clearError(live: Live): void {
    if (live.status === "error") this.setStatus(live, "running");
  }

  private setStatus(live: Live, status: HandlerStatus, error?: string): void {
    live.status = status;
    live.error = error;
    this.emitStatus(live.id, status, error);
  }

  private emitStatus(id: string, status: HandlerStatus, error?: string): void {
    this.deps.bus.emit({ type: "automation_status", automationId: `sensor:${id}`, status, error });
  }

  private host(): Host {
    const { states, registry, timezone } = this.deps;
    return {
      state: (id) => states.get(id as EntityId),
      entity: (id) => registry.getEntity(id as EntityId),
      entities: () => registry.listEntities(),
      devices: () => registry.listDevices(),
      areas: () => registry.listAreas(),
      // Never read: the compiler keeps `screen`, `now` and the clock out of a sensor's value.
      screen: () => "Desktop",
      now: () => this.now(),
      timezone,
      present: (_entity, record) => {
        if (!record?.available) return "Unavailable";
        const value = stateValue(record.state);
        return value === null ? "Unknown" : String(value);
      },
      unit: (_entity, record) =>
        record?.state.domain === "sensor" ? (record.state.unit ?? null) : null,
      ago: () => "",
      when: () => "",
      format: (value, places) => value.toFixed(places),
    };
  }
}
