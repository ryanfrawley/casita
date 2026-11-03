// Maps a zigbee2mqtt device's `exposes` metadata to entities: how to read each one's state
// out of the device's JSON payload, and how to turn a command into a /set payload.

import type {
  BinarySensorState,
  Capabilities,
  ClimateState,
  Command,
  Domain,
  EntityState,
  SensorState,
} from "@casita/core/types";
import { z } from "zod";

const feature = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  property: z.string().optional(),
  access: z.number().optional(),
  unit: z.string().optional(),
  value_on: z.unknown().optional(),
  value_off: z.unknown().optional(),
  value_min: z.number().optional(),
  value_max: z.number().optional(),
  value_step: z.number().optional(),
  values: z.array(z.unknown()).optional(),
  endpoint: z.string().optional(),
});
type Feature = z.infer<typeof feature>;

const expose = feature.extend({ features: z.array(feature).optional() });
type Expose = z.infer<typeof expose>;

export const bridgeDevice = z.looseObject({
  ieee_address: z.string(),
  friendly_name: z.string(),
  type: z.string().optional(),
  disabled: z.boolean().optional(),
  software_build_id: z.string().nullish(),
  definition: z
    .looseObject({
      model: z.string().optional(),
      vendor: z.string().optional(),
      exposes: z.array(expose).default([]),
    })
    .nullish(),
});
export type BridgeDevice = z.infer<typeof bridgeDevice>;

export type Payload = Record<string, unknown>;

export interface EntitySpec {
  /** Stable within the device; combined with the IEEE address into the uniqueId. */
  key: string;
  domain: Domain;
  /** Appended to the device's friendly name; empty for the device's main function. */
  label: string;
  capabilities?: Capabilities;
  /** Properties that can be asked for with a /get, to learn state without waiting. */
  gettable: string[];
  /** The state carried by a device payload, or undefined if it says nothing about this entity. */
  read(payload: Payload): EntityState | undefined;
  /** The /set payload for a command; absent for read-only entities. */
  write?(command: Command): Payload;
}

const ACCESS_STATE = 1;
const ACCESS_SET = 2;
const ACCESS_GET = 4;

const SENSOR_CLASS: Record<string, SensorState["deviceClass"]> = {
  temperature: "temperature",
  device_temperature: "temperature",
  local_temperature: "temperature",
  humidity: "humidity",
  soil_moisture: "humidity",
  power: "power",
  energy: "energy",
  illuminance: "illuminance",
  illuminance_lux: "illuminance",
  battery: "battery",
};

const BINARY_CLASS: Record<string, BinarySensorState["deviceClass"]> = {
  occupancy: "occupancy",
  presence: "occupancy",
  motion: "motion",
  contact: "door",
  water_leak: "leak",
  smoke: "smoke",
};

/** Reported with every payload; kept as attributes rather than entities. */
export const ATTRIBUTE_PROPERTIES = ["linkquality", "last_seen", "update_available"];

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const mired = (value: number) => Math.round(1_000_000 / value);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const find = (e: Expose, name: string) => e.features?.find((f) => f.name === name);
const prop = (f: Feature | undefined, fallback: string) => f?.property ?? f?.name ?? fallback;
const gettable = (...features: (Feature | undefined)[]) =>
  features.flatMap((f) => (f?.property && (f.access ?? 0) & ACCESS_GET ? [f.property] : []));
const suffix = (e: Expose) => (e.endpoint ? `_${e.endpoint}` : "");
const label = (e: Expose) => e.endpoint ?? "";

function light(e: Expose): EntitySpec | undefined {
  const state = find(e, "state");
  if (!state) return undefined;
  const brightness = find(e, "brightness");
  const colorTemp = find(e, "color_temp");
  const color = find(e, "color_xy") ?? find(e, "color_hs");
  const stateProp = prop(state, "state");
  const maxBrightness = brightness?.value_max ?? 254;
  return {
    key: `light${suffix(e)}`,
    domain: "light",
    label: label(e),
    capabilities: {
      brightness: brightness ? true : undefined,
      colorTemp:
        colorTemp?.value_min && colorTemp.value_max
          ? { minK: mired(colorTemp.value_max), maxK: mired(colorTemp.value_min) }
          : undefined,
      rgb: color ? true : undefined,
      transition: true,
    },
    gettable: gettable(state, brightness, colorTemp),
    read(payload) {
      const value = payload[stateProp];
      if (value !== (state.value_on ?? "ON") && value !== (state.value_off ?? "OFF"))
        return undefined;
      const level = brightness ? num(payload[prop(brightness, "brightness")]) : undefined;
      const temp = colorTemp ? num(payload[prop(colorTemp, "color_temp")]) : undefined;
      return {
        domain: "light",
        on: value === (state.value_on ?? "ON"),
        brightness: level === undefined ? undefined : clamp01(level / maxBrightness),
        colorTempK: temp ? mired(temp) : undefined,
      };
    },
    write(command) {
      if (command.domain !== "light") return {};
      const transition =
        command.transitionMs === undefined ? undefined : command.transitionMs / 1000;
      if (command.action === "turn_off")
        return { [stateProp]: state.value_off ?? "OFF", transition };
      const [r, g, b] = command.rgb ?? [];
      return {
        [stateProp]: state.value_on ?? "ON",
        [prop(brightness, "brightness")]:
          command.brightness === undefined
            ? undefined
            : Math.max(1, Math.round(command.brightness * maxBrightness)),
        [prop(colorTemp, "color_temp")]:
          command.colorTempK === undefined ? undefined : mired(command.colorTempK),
        color: command.rgb ? { r, g, b } : undefined,
        transition,
      };
    },
  };
}

function onOff(e: Expose): EntitySpec | undefined {
  const state = find(e, "state");
  if (!state) return undefined;
  const stateProp = prop(state, "state");
  return {
    key: `switch${suffix(e)}`,
    domain: "switch",
    label: label(e),
    gettable: gettable(state),
    read(payload) {
      const value = payload[stateProp];
      if (value !== (state.value_on ?? "ON") && value !== (state.value_off ?? "OFF"))
        return undefined;
      return { domain: "switch", on: value === (state.value_on ?? "ON") };
    },
    write: (command) => ({
      [stateProp]:
        command.action === "turn_on" ? (state.value_on ?? "ON") : (state.value_off ?? "OFF"),
    }),
  };
}

function cover(e: Expose): EntitySpec | undefined {
  const state = find(e, "state");
  const position = find(e, "position");
  if (!state && !position) return undefined;
  const stateProp = prop(state, "state");
  const positionProp = prop(position, "position");
  return {
    key: `cover${suffix(e)}`,
    domain: "cover",
    label: label(e),
    capabilities: { position: position && (position.access ?? 0) & ACCESS_SET ? true : undefined },
    gettable: gettable(state, position),
    read(payload) {
      const level = num(payload[positionProp]);
      const value = payload[stateProp];
      if (level !== undefined)
        return { domain: "cover", motion: "stopped", position: clamp01(level / 100) };
      if (value === "OPEN" || value === "CLOSE") {
        return { domain: "cover", motion: "stopped", position: value === "OPEN" ? 1 : 0 };
      }
      return undefined;
    },
    write(command) {
      if (command.domain !== "cover") return {};
      if (command.action === "set_position")
        return { [positionProp]: Math.round(command.position * 100) };
      return { [stateProp]: command.action.toUpperCase() };
    },
  };
}

function lock(e: Expose): EntitySpec | undefined {
  const state = find(e, "state");
  if (!state) return undefined;
  const stateProp = prop(state, "state");
  return {
    key: `lock${suffix(e)}`,
    domain: "lock",
    label: label(e),
    gettable: gettable(state),
    read(payload) {
      const value = payload[stateProp];
      if (value !== "LOCK" && value !== "UNLOCK") return undefined;
      return {
        domain: "lock",
        locked: value === "LOCK",
        jammed: payload.lock_state === "not_fully_locked" || undefined,
      };
    },
    write: (command) => ({ [stateProp]: command.action === "lock" ? "LOCK" : "UNLOCK" }),
  };
}

const MODES: readonly ClimateState["mode"][] = ["off", "heat", "cool", "auto"];

function climate(e: Expose): EntitySpec | undefined {
  const setpoint =
    find(e, "occupied_heating_setpoint") ??
    find(e, "current_heating_setpoint") ??
    find(e, "occupied_cooling_setpoint");
  const mode = find(e, "system_mode");
  const local = find(e, "local_temperature");
  if (!setpoint) return undefined;
  const setpointProp = prop(setpoint, "occupied_heating_setpoint");
  return {
    key: `climate${suffix(e)}`,
    domain: "climate",
    label: label(e),
    capabilities: {
      tempRange:
        setpoint.value_min !== undefined && setpoint.value_max !== undefined
          ? { min: setpoint.value_min, max: setpoint.value_max, step: setpoint.value_step ?? 0.5 }
          : undefined,
    },
    gettable: gettable(setpoint, mode, local),
    read(payload) {
      const target = num(payload[setpointProp]);
      const reported = mode ? payload[prop(mode, "system_mode")] : undefined;
      if (target === undefined && reported === undefined) return undefined;
      return {
        domain: "climate",
        // A thermostat with no mode control (most radiator valves) is always heating.
        mode: MODES.find((m) => m === reported) ?? "heat",
        currentTemp: num(payload[prop(local, "local_temperature")]),
        targetTemp: target,
      };
    },
    write(command) {
      if (command.domain !== "climate") return {};
      if (command.action === "set_target") return { [setpointProp]: command.temp };
      if (!mode) throw new Error("This thermostat has no mode control");
      return { [prop(mode, "system_mode")]: command.mode };
    },
  };
}

function numeric(e: Expose): EntitySpec | undefined {
  const property = e.property ?? e.name;
  if (!property || !((e.access ?? 0) & ACCESS_STATE) || ATTRIBUTE_PROPERTIES.includes(property))
    return undefined;
  return {
    key: property,
    domain: "sensor",
    label: (e.name ?? property).replaceAll("_", " "),
    gettable: gettable(e),
    read(payload) {
      const value = num(payload[property]);
      if (value === undefined) return undefined;
      return {
        domain: "sensor",
        value,
        unit: e.unit,
        deviceClass: SENSOR_CLASS[e.name ?? property],
      };
    },
  };
}

function binary(e: Expose): EntitySpec | undefined {
  const property = e.property ?? e.name;
  if (!property || !((e.access ?? 0) & ACCESS_STATE) || ATTRIBUTE_PROPERTIES.includes(property))
    return undefined;
  // A settable binary is a configuration toggle, not a sensor.
  if ((e.access ?? 0) & ACCESS_SET) return undefined;
  const deviceClass = BINARY_CLASS[e.name ?? property];
  return {
    key: property,
    domain: "binary_sensor",
    label: (e.name ?? property).replaceAll("_", " "),
    gettable: gettable(e),
    read(payload) {
      const value = payload[property];
      if (value !== (e.value_on ?? true) && value !== (e.value_off ?? false)) return undefined;
      // value_on already carries the sense: a contact sensor is "on" (open) when contact is false.
      return { domain: "binary_sensor", on: value === (e.value_on ?? true), deviceClass };
    },
  };
}

const BUILDERS: Record<string, (e: Expose) => EntitySpec | undefined> = {
  light,
  switch: onOff,
  cover,
  lock,
  climate,
  numeric,
  binary,
};

/** Every entity a device exposes that this integration understands. */
export function entitiesFor(device: BridgeDevice): EntitySpec[] {
  const specs: EntitySpec[] = [];
  for (const e of device.definition?.exposes ?? []) {
    const spec = Object.hasOwn(BUILDERS, e.type) ? BUILDERS[e.type]?.(e) : undefined;
    // Properties inside a thermostat or light are part of that entity, but top-level
    // duplicates (two exposes with the same key) would collide: first one wins.
    if (spec && !specs.some((s) => s.key === spec.key)) specs.push(spec);
  }
  return specs;
}
