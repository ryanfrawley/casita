// core/types.ts
// Core contracts for the home automation engine.
// Integrations and automations depend ONLY on this file, never on core internals.

import type { z } from "zod";

// ───────────────────────── Identity ─────────────────────────

export type DeviceId = string & { readonly __brand: "DeviceId" }; // e.g. "thermostat", "model_3"
export type EntityId = string & { readonly __brand: "EntityId" }; // e.g. "light.kitchen_ceiling"
export type AreaId = string & { readonly __brand: "AreaId" };

// ───────────────────────── Entity state (per domain) ─────────────────────────

export type LightState = {
  domain: "light";
  on: boolean;
  brightness?: number; // 0–1
  colorTempK?: number;
  rgb?: [number, number, number];
};

export type SwitchState = { domain: "switch"; on: boolean };

/** What a numeric reading is of; the words and icons follow it. */
export const SENSOR_CLASSES = [
  "temperature",
  "humidity",
  "power",
  "energy",
  "illuminance",
  "battery",
] as const;
export type SensorClass = (typeof SENSOR_CLASSES)[number];

/** What a binary sensor senses: a door is open or closed, a leak sensor wet or dry. */
export const BINARY_SENSOR_CLASSES = [
  "motion",
  "occupancy",
  "door",
  "window",
  "leak",
  "smoke",
] as const;
export type BinarySensorClass = (typeof BINARY_SENSOR_CLASSES)[number];

export type SensorState = {
  domain: "sensor";
  value: number | string | null;
  unit?: string;
  deviceClass?: SensorClass;
};

export type BinarySensorState = {
  domain: "binary_sensor";
  on: boolean;
  deviceClass?: BinarySensorClass;
};

export type ClimateState = {
  domain: "climate";
  mode: "off" | "heat" | "cool" | "auto";
  currentTemp?: number;
  targetTemp?: number;
};

export type CoverState = {
  domain: "cover";
  position?: number; // 0 = closed, 1 = open
  motion: "opening" | "closing" | "stopped";
};

export type LockState = { domain: "lock"; locked: boolean; jammed?: boolean };

/** Stateless; each press reports a new `pressedAt`, which emits a state_changed. */
export type ButtonState = { domain: "button"; pressedAt?: number };

/** How the sky reads. A night has its own values only where the picture differs. */
export type WeatherCondition =
  | "clear"
  | "clear-night"
  | "partly-cloudy"
  | "partly-cloudy-night"
  | "cloudy"
  | "overcast"
  | "fog"
  | "haze"
  | "drizzle"
  | "rain"
  | "pouring"
  | "snow"
  | "hail"
  | "thunderstorm"
  | "windy"
  | "tornado";

/** Conditions outside, now. Read-only; the forecast travels in the record's attributes. */
export type WeatherState = {
  domain: "weather";
  condition: WeatherCondition;
  temperature?: number; // °C
  apparentTemperature?: number; // °C
  humidity?: number; // percent
  windSpeed?: number; // km/h
  windBearing?: number; // degrees the wind blows from, 0 = north
};

export type EntityState =
  | LightState
  | SwitchState
  | SensorState
  | BinarySensorState
  | ClimateState
  | CoverState
  | LockState
  | ButtonState
  | WeatherState;

export type Domain = EntityState["domain"];
export type StateFor<D extends Domain> = Extract<EntityState, { domain: D }>;

export const DOMAINS = [
  "light",
  "switch",
  "sensor",
  "binary_sensor",
  "climate",
  "cover",
  "lock",
  "button",
  "weather",
] as const satisfies readonly Domain[];

// ───────────────────────── Commands (per domain) ─────────────────────────

export type Command =
  | {
      domain: "light";
      action: "turn_on";
      brightness?: number;
      colorTempK?: number;
      rgb?: [number, number, number];
      transitionMs?: number;
    }
  | { domain: "light"; action: "turn_off"; transitionMs?: number }
  | { domain: "switch"; action: "turn_on" | "turn_off" | "toggle" }
  | { domain: "climate"; action: "set_mode"; mode: ClimateState["mode"] }
  | { domain: "climate"; action: "set_target"; temp: number }
  | { domain: "cover"; action: "open" | "close" | "stop" }
  | { domain: "cover"; action: "set_position"; position: number }
  | { domain: "lock"; action: "lock" | "unlock" }
  | { domain: "button"; action: "press" };

export type CommandFor<D extends Domain> = Extract<Command, { domain: D }>;

/** What an entity supports — drives command validation, the UI, and automations. */
export type Capabilities = {
  brightness?: boolean;
  colorTemp?: { minK: number; maxK: number };
  rgb?: boolean;
  transition?: boolean;
  position?: boolean;
  tempRange?: { min: number; max: number; step: number };
};

export type CommandErrorCode =
  | "not_found"
  | "disabled"
  | "domain_mismatch"
  | "unavailable"
  | "unsupported"
  | "invalid"
  | "forbidden"
  | "superseded"
  | "timeout"
  | "failed";

export interface CommandResult {
  entityId: EntityId;
  command: Command; // the normalized command actually sent
  status: "sent" | "confirmed" | "unconfirmed";
  latencyMs: number;
}

export interface SendOptions {
  /** Wait for the device to report a state matching the command. */
  confirm?: boolean;
}

// ───────────────────────── Registry ─────────────────────────

export interface Area {
  id: AreaId;
  name: string;
  /** An icon name a person chose; unset means the default picture. */
  icon?: string;
}

export interface Device {
  id: DeviceId;
  /** Integration's own stable key; re-attaches the same row across restarts. */
  uniqueId: string;
  integrationId: string; // "<integration>.<instanceName>"
  name: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  areaId?: AreaId;
  viaDeviceId?: DeviceId; // e.g. a Zigbee device behind a coordinator
  /** Its integration instance is no longer loaded. */
  orphaned?: boolean;
  /** An icon name a person chose; unset means the default picture. */
  icon?: string;
}

export interface Entity<D extends Domain = Domain> {
  id: EntityId;
  /** Integration's own stable key; re-attaches the same row after a rename. */
  uniqueId: string;
  domain: D;
  integrationId: string; // "<integration>.<instanceName>"
  deviceId?: DeviceId;
  name: string;
  capabilities: Capabilities;
  /** Overrides the device's area when set. */
  areaId?: AreaId;
  disabled?: boolean;
  hidden?: boolean;
  /** Its integration instance is no longer loaded. */
  orphaned?: boolean;
  /** Overrides the domain and default history retention. */
  retention?: RetentionPolicy;
  /** An icon name a person chose; unset means the domain's picture. */
  icon?: string;
  /**
   * What a person says a sensor or binary sensor is, written into every state it reports;
   * unset keeps the class its integration gave.
   */
  deviceClass?: SensorClass | BinarySensorClass;
}

// ───────────────────────── Device settings ─────────────────────────

export type SettingValue = number | boolean | string;

/**
 * One adjustable property of a device that is not part of any entity's state: a dimmer's
 * minimum level, how long its LEDs stay lit. Its integration describes it from what the
 * device or its driver says about itself, so nothing here names a model.
 */
export interface DeviceSetting {
  /** Stable within the device; the integration's own name for it (`"22"`, `"64[0xff00]"`). */
  key: string;
  label: string;
  description?: string;
  /** Settings that belong together, shown under one heading: "LED1 Strip Effect". */
  group?: string;
  /**
   * `enum` takes only one of `options`; `number` takes anything in range, with `options`
   * naming some of its values ("255 = Indefinitely"); `boolean` is on or off.
   */
  type: "number" | "boolean" | "enum" | "string";
  /** `null` when the device has not reported it. */
  value: SettingValue | null;
  default?: SettingValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: number | string; label: string }[];
  /** A reading the device reports about itself, such as whether it found a neutral wire. */
  readOnly?: boolean;
  /** Hard to undo, such as a factory reset; asked about before it is sent. */
  destructive?: boolean;
}

/** How an integration lists and changes its devices' settings. */
export interface DeviceSettingsProvider {
  /** The device's settings, empty when it has none. */
  list(deviceId: DeviceId): DeviceSetting[] | Promise<DeviceSetting[]>;
  /**
   * Resolve once the change is handed to the transport. The core has already checked the
   * value against the setting; the new value is shown when the device reports it, through
   * `settingsChanged`.
   */
  set(deviceId: DeviceId, key: string, value: SettingValue): Promise<void>;
}

/** History retention in days: the raw window, plus optional rollup tiers with their own windows. */
export type RetentionPolicy = { raw: number; minute?: number; hour?: number; day?: number };

export type Attributes = Record<string, unknown>;

export interface StateRecord<S extends EntityState = EntityState> {
  entityId: EntityId;
  state: S;
  /** Integration-specific extras (link quality, firmware). Never validated, never part of state. */
  attributes?: Attributes;
  available: boolean;
  changedAt: number; // last time `state` changed
  updatedAt: number; // last time anything was reported
}

// ───────────────────────── Events ─────────────────────────

export type CommandSource =
  | { kind: "user"; userId: string; sessionId: string }
  | { kind: "automation"; automationId: string }
  | { kind: "system" };

export type IntegrationStatus = "starting" | "running" | "error" | "stopped";

// One union member per type, so EventOf can extract each.
export type CoreEvent =
  | { type: "state_changed"; entityId: EntityId; old?: StateRecord; new: StateRecord }
  | { type: "entity_added"; entity: Entity }
  | { type: "entity_updated"; entity: Entity }
  | { type: "entity_removed"; entity: Entity }
  | { type: "entity_renamed"; oldId: EntityId; entity: Entity }
  | { type: "device_added"; device: Device }
  | { type: "device_updated"; device: Device }
  | { type: "device_removed"; device: Device }
  | { type: "device_renamed"; oldId: DeviceId; device: Device }
  | { type: "area_added"; area: Area }
  | { type: "area_updated"; area: Area }
  | { type: "area_removed"; area: Area }
  /** A Casa page was saved; the browser fetches it again. */
  | { type: "page_changed"; pageId: string }
  | { type: "theme_changed"; themeId: string }
  | { type: "components_changed" }
  /** A Casa automation was saved, switched, or deleted; the runtime re-registers it. */
  | { type: "automation_changed"; automationId: string }
  /** A Casa sensor was saved, switched, or deleted; the runtime recomputes or drops it. */
  | { type: "sensor_changed"; sensorId: string }
  | { type: "command_issued"; entityId: EntityId; command: Command; source: CommandSource }
  | {
      type: "command_failed";
      entityId: EntityId;
      command: Command;
      source: CommandSource;
      code: CommandErrorCode;
      error: string;
    }
  | { type: "integration_status"; integrationId: string; status: IntegrationStatus; error?: string }
  /** An automation's handlers were armed, disarmed, or hit an error: `automationId` is the source id (`automation:x`, `page:home`). */
  | {
      type: "automation_status";
      automationId: string;
      status: "running" | "error" | "stopped";
      error?: string;
    }
  | { type: "config_changed"; path: string }
  /** A device reported a new value for one of its settings, or its list of settings changed. */
  | { type: "settings_changed"; deviceId: DeviceId };

export type EventOf<T extends CoreEvent["type"]> = Extract<CoreEvent, { type: T }>;

export interface EventBus {
  emit(event: CoreEvent): void;
  on<T extends CoreEvent["type"]>(type: T, handler: (e: EventOf<T>) => void): () => void;
}

// ───────────────────────── Shared services ─────────────────────────

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Private, persisted key-value storage (tokens, pairing keys, cursors). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Every handle is cancelled when the owning integration or automation unloads. */
export interface Scheduler {
  every(ms: number, fn: () => void | Promise<void>): () => void;
  /** Evaluated in `server.timezone`. */
  cron(expr: string, fn: () => void | Promise<void>): () => void;
  after(ms: number, fn: () => void | Promise<void>): () => void;
}

// ───────────────────────── Integration contract ─────────────────────────

/**
 * Resolve once the command is handed to the transport; reject with an Error whose
 * message is user-readable. Never wait for the device — the router handles confirmation.
 */
export type CommandHandler<D extends Domain = Domain> = (command: CommandFor<D>) => Promise<void>;

export type DeviceInput = Omit<Device, "id" | "integrationId" | "areaId" | "orphaned">;

export type EntityInput<D extends Domain = Domain> = {
  uniqueId: string;
  domain: D;
  name: string;
  /** Proposed id slug; defaults to one derived from `name`. The registry resolves collisions. */
  slug?: string;
  deviceId?: DeviceId;
  capabilities?: Capabilities;
};

export interface IntegrationContext<C> {
  /** "<integration>.<instanceName>" */
  readonly instanceId: string;
  readonly config: C;
  readonly log: Logger;
  readonly storage: KeyValueStore;
  readonly scheduler: Scheduler;
  /** Aborted when the integration is unloaded or reloaded. */
  readonly signal: AbortSignal;

  /** Idempotent on `uniqueId`: call on every discovery, not only the first. */
  registerDevice(device: DeviceInput): Device;
  /** Idempotent on `uniqueId`. An entity with no handler is read-only. */
  registerEntity<D extends Domain>(
    entity: EntityInput<D>,
    onCommand?: CommandHandler<D>,
  ): Entity<D>;
  removeEntity(id: EntityId): void;
  /** For a device that left the network; its entities go with it. */
  removeDevice(id: DeviceId): void;

  /** Only accepted for entities this instance registered; throws otherwise. */
  reportState(id: EntityId, state: EntityState, attributes?: Attributes): void;
  setAvailable(id: EntityId, available: boolean): void;

  /** Operations that are not entity commands: permit join, start inclusion, rescan. */
  registerAction<P>(
    name: string,
    schema: z.ZodType<P>,
    handler: (params: P) => Promise<unknown>,
  ): void;

  /** Lets people see and change this instance's devices' settings. One provider per instance. */
  provideDeviceSettings(provider: DeviceSettingsProvider): void;
  /** Says one of this instance's devices has new setting values; a no-op for any other device. */
  settingsChanged(id: DeviceId): void;
}

export interface Integration<C = unknown> {
  id: string; // stable, e.g. "zigbee2mqtt"
  name: string;
  version: string;
  configSchema: z.ZodType<C>;
  /** Return a teardown function, or rely on ctx.signal for cleanup. */
  setup(ctx: IntegrationContext<C>): Promise<void | (() => void | Promise<void>)>;
}

export const defineIntegration = <C>(integration: Integration<C>): Integration<C> => integration;
