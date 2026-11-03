// Maps a Z-Wave node's values to entities, by command class.

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

export const CC = {
  binarySwitch: 37,
  multilevelSwitch: 38,
  binarySensor: 48,
  multilevelSensor: 49,
  meter: 50,
  thermostatMode: 64,
  thermostatSetpoint: 67,
  centralScene: 91,
  doorLock: 98,
  barrierOperator: 102,
  notification: 113,
  battery: 128,
} as const;

const valueId = z.looseObject({
  commandClass: z.number(),
  endpoint: z.number().default(0),
  property: z.union([z.string(), z.number()]),
  propertyKey: z.union([z.string(), z.number()]).optional(),
});
export type ValueId = z.infer<typeof valueId>;

const nodeValue = valueId.extend({
  value: z.unknown().optional(),
  metadata: z
    .looseObject({
      label: z.string().optional(),
      unit: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
});
export type NodeValue = z.infer<typeof nodeValue>;

export const zwaveNode = z.looseObject({
  nodeId: z.number(),
  /** 0 unknown, 1 asleep, 2 awake, 3 dead, 4 alive */
  status: z.number().optional(),
  ready: z.boolean().optional(),
  name: z.string().nullish(),
  firmwareVersion: z.string().nullish(),
  deviceConfig: z
    .looseObject({
      manufacturer: z.string().optional(),
      label: z.string().optional(),
      description: z.string().optional(),
    })
    .nullish(),
  deviceClass: z
    .looseObject({
      generic: z.looseObject({ key: z.number(), label: z.string().optional() }).optional(),
      specific: z.looseObject({ key: z.number(), label: z.string().optional() }).optional(),
    })
    .nullish(),
  values: z.array(nodeValue).default([]),
});
export type ZwaveNode = z.infer<typeof zwaveNode>;

export const NODE_DEAD = 3;

/** Identifies a value within its node. */
export const valueKey = (v: ValueId): string =>
  `${v.endpoint ?? 0}-${v.commandClass}-${v.property}${v.propertyKey === undefined ? "" : `-${v.propertyKey}`}`;

/** A server command the integration should send. */
export interface Call {
  command: string;
  params: Record<string, unknown>;
}

export type Values = ReadonlyMap<string, unknown>;

export interface EntitySpec {
  /** `<endpoint>-<commandClass>-<property>[-<propertyKey>]`; the uniqueId adds home and node. */
  key: string;
  domain: Domain;
  /** Appended to the node's name; empty for the node's main function. */
  label: string;
  capabilities?: Capabilities;
  /** The state the node's current values describe, or undefined if not known yet. */
  read(values: Values): EntityState | undefined;
  write?(command: Command, values: Values): Call[];
  /** Central Scene: the value id whose notifications are this button's presses. */
  scene?: string;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// Generic device class 0x09 is Window Covering; these specific classes of Multilevel Switch
// (0x11) are motor controls.
const WINDOW_COVERING = 0x09;
const MULTILEVEL_SWITCH = 0x11;
const MOTOR_CLASSES = [0x03, 0x05, 0x06, 0x07];

function isCover(node: ZwaveNode): boolean {
  const generic = node.deviceClass?.generic?.key;
  const specific = node.deviceClass?.specific?.key ?? -1;
  return (
    generic === WINDOW_COVERING ||
    (generic === MULTILEVEL_SWITCH && MOTOR_CLASSES.includes(specific))
  );
}

const SENSOR_CLASS: [RegExp, SensorState["deviceClass"]][] = [
  [/temperature/i, "temperature"],
  [/humidity/i, "humidity"],
  [/illuminance|luminance/i, "illuminance"],
  [/power/i, "power"],
  [/energy/i, "energy"],
];

const BINARY_CLASS: [RegExp, BinarySensorState["deviceClass"]][] = [
  [/motion/i, "motion"],
  [/door|window/i, "door"],
  [/water|leak/i, "leak"],
  [/smoke/i, "smoke"],
  [/occupancy|presence/i, "occupancy"],
];

const classOf = <T>(table: [RegExp, T][], text: string): T | undefined =>
  table.find(([re]) => re.test(text))?.[1];

// A meter reading's class comes from its unit; its label ("Electric Consumption [W]") names
// the quantity metered, not the kind of reading.
const METER_CLASS: Record<string, SensorState["deviceClass"]> = {
  Wh: "energy",
  kWh: "energy",
  W: "power",
  kW: "power",
};

const THERMOSTAT_MODES: Record<number, ClimateState["mode"]> = {
  0: "off",
  1: "heat",
  2: "cool",
  3: "auto",
};
const SETPOINT_HEATING = 1;
const SETPOINT_COOLING = 2;

// Notification values that mean "on" for the notifications mapped to binary sensors.
// Notification events 7 and 8 are motion with and without a location.
const MOTION_DETECTED = [7, 8];
const DOOR_OPEN = 22;
// Access Control's "Barrier safety beam obstacle status" has one state with an enum parameter,
// so zwave-js reports the parameter itself: 0 clear, 255 obstructed.
const BEAM_OBSTRUCTED = 255;

// Barrier Operator's `currentState`: closed, or a position 1–99 (reported as Stopped, with
// `position` set), or one of these; null while unknown.
const BARRIER = { closed: 0, closing: 252, stopped: 253, opening: 254, open: 255 } as const;

/** Every entity a node's values describe. */
export function entitiesFor(node: ZwaveNode, nodeId: number): EntitySpec[] {
  const specs: EntitySpec[] = [];
  const endpointLabel = (endpoint: number) => (endpoint > 0 ? `${endpoint}` : "");
  const set = (id: ValueId, value: unknown, options?: Record<string, unknown>): Call => ({
    command: "node.set_value",
    params: {
      nodeId,
      valueId: {
        commandClass: id.commandClass,
        endpoint: id.endpoint,
        property: id.property,
        propertyKey: id.propertyKey,
      },
      value,
      ...(options ? { options } : {}),
    },
  });
  const has = (endpoint: number, commandClass: number, property: string) =>
    node.values.find(
      (v) => v.endpoint === endpoint && v.commandClass === commandClass && v.property === property,
    );

  const endpoints = [...new Set(node.values.map((v) => v.endpoint))].sort((a, b) => a - b);
  for (const endpoint of endpoints) {
    const label = endpointLabel(endpoint);

    const binary = has(endpoint, CC.binarySwitch, "currentValue");
    if (binary) {
      const target = { commandClass: CC.binarySwitch, endpoint, property: "targetValue" };
      specs.push({
        key: valueKey(binary),
        domain: "switch",
        label,
        read: (values) => {
          const on = values.get(valueKey(binary));
          return typeof on === "boolean" ? { domain: "switch", on } : undefined;
        },
        write: (command) => [set(target, command.action === "turn_on")],
      });
    }

    const level = has(endpoint, CC.multilevelSwitch, "currentValue");
    if (level) {
      const target = { commandClass: CC.multilevelSwitch, endpoint, property: "targetValue" };
      const current = (values: Values) => num(values.get(valueKey(level)));
      if (isCover(node)) {
        specs.push({
          key: valueKey(level),
          domain: "cover",
          label,
          capabilities: { position: true },
          read: (values) => {
            const value = current(values);
            return value === undefined
              ? undefined
              : { domain: "cover", motion: "stopped", position: clamp01(value / 99) };
          },
          write: (command) => {
            if (command.domain !== "cover") return [];
            if (command.action === "stop") {
              const params = {
                nodeId,
                endpoint,
                commandClass: CC.multilevelSwitch,
                methodName: "stopLevelChange",
                args: [],
              };
              return [{ command: "endpoint.invoke_cc_api", params }];
            }
            const position =
              command.action === "set_position"
                ? command.position
                : command.action === "open"
                  ? 1
                  : 0;
            return [set(target, Math.round(position * 99))];
          },
        });
      } else {
        specs.push({
          key: valueKey(level),
          domain: "light",
          label,
          capabilities: { brightness: true, transition: true },
          read: (values) => {
            const value = current(values);
            if (value === undefined) return undefined;
            return {
              domain: "light",
              on: value > 0,
              brightness: value > 0 ? clamp01(value / 99) : undefined,
            };
          },
          write: (command) => {
            if (command.domain !== "light") return [];
            const options =
              command.transitionMs === undefined
                ? undefined
                : { transitionDuration: `${Math.round(command.transitionMs / 1000)}s` };
            if (command.action === "turn_off") return [set(target, 0, options)];
            // 255 restores the level the dimmer had before it was turned off.
            const value =
              command.brightness === undefined
                ? 255
                : Math.max(1, Math.round(command.brightness * 99));
            return [set(target, value, options)];
          },
        });
      }
    }

    const lock = has(endpoint, CC.doorLock, "currentMode");
    if (lock) {
      const target = { commandClass: CC.doorLock, endpoint, property: "targetMode" };
      specs.push({
        key: valueKey(lock),
        domain: "lock",
        label,
        read: (values) => {
          const mode = num(values.get(valueKey(lock)));
          return mode === undefined ? undefined : { domain: "lock", locked: mode === 255 };
        },
        write: (command) => [set(target, command.action === "lock" ? 255 : 0)],
      });
    }

    // A garage door opener: it opens or closes, and reports which it is doing. Its position is
    // known only at rest, so it is not offered as a capability.
    const barrier = has(endpoint, CC.barrierOperator, "currentState");
    if (barrier) {
      const target = { commandClass: CC.barrierOperator, endpoint, property: "targetState" };
      const positionKey = valueKey({
        commandClass: CC.barrierOperator,
        endpoint,
        property: "position",
      });
      specs.push({
        key: valueKey(barrier),
        domain: "cover",
        label,
        read: (values) => {
          const state = num(values.get(valueKey(barrier)));
          if (state === undefined) return undefined;
          const percent = num(values.get(positionKey));
          const position = percent === undefined ? undefined : clamp01(percent / 100);
          switch (state) {
            case BARRIER.open:
              return { domain: "cover", motion: "stopped", position: 1 };
            case BARRIER.closed:
              return { domain: "cover", motion: "stopped", position: 0 };
            case BARRIER.opening:
              return { domain: "cover", motion: "opening", position };
            case BARRIER.closing:
              return { domain: "cover", motion: "closing", position };
            default:
              return { domain: "cover", motion: "stopped", position };
          }
        },
        write: (command) => {
          if (command.domain !== "cover") return [];
          if (command.action === "open") return [set(target, BARRIER.open)];
          if (command.action === "close") return [set(target, BARRIER.closed)];
          throw new Error("A garage door only opens or closes");
        },
      });
    }

    const mode = has(endpoint, CC.thermostatMode, "mode");
    const setpoints = node.values.filter(
      (v) =>
        v.endpoint === endpoint &&
        v.commandClass === CC.thermostatSetpoint &&
        v.property === "setpoint",
    );
    if (mode || setpoints.length > 0) {
      const heating = setpoints.find((v) => v.propertyKey === SETPOINT_HEATING) ?? setpoints[0];
      const cooling = setpoints.find((v) => v.propertyKey === SETPOINT_COOLING);
      const air = node.values.find(
        (v) =>
          v.endpoint === endpoint &&
          v.commandClass === CC.multilevelSensor &&
          /temperature/i.test(String(v.property)),
      );
      const modeOf = (values: Values): ClimateState["mode"] =>
        // A thermostat with no mode control only heats.
        mode ? (THERMOSTAT_MODES[num(values.get(valueKey(mode))) ?? -1] ?? "off") : "heat";
      const active = (values: Values) => (modeOf(values) === "cool" && cooling ? cooling : heating);
      const range = heating?.metadata;
      specs.push({
        key: `${endpoint}-${CC.thermostatMode}-climate`,
        domain: "climate",
        label,
        capabilities: {
          tempRange:
            range?.min !== undefined && range.max !== undefined
              ? { min: range.min, max: range.max, step: 0.5 }
              : undefined,
        },
        read: (values) => {
          const setpoint = active(values);
          const targetTemp = setpoint ? num(values.get(valueKey(setpoint))) : undefined;
          if (mode && values.get(valueKey(mode)) === undefined && targetTemp === undefined)
            return undefined;
          return {
            domain: "climate",
            mode: modeOf(values),
            currentTemp: air ? num(values.get(valueKey(air))) : undefined,
            targetTemp,
          };
        },
        write: (command, values) => {
          if (command.domain !== "climate") return [];
          if (command.action === "set_mode") {
            if (!mode) throw new Error("This thermostat has no mode control");
            const value = Object.entries(THERMOSTAT_MODES).find(
              ([, name]) => name === command.mode,
            )?.[0];
            return [set(mode, Number(value))];
          }
          const setpoint = active(values);
          if (!setpoint) throw new Error("This thermostat has no setpoint");
          return [set(setpoint, command.temp)];
        },
      });
    }

    for (const value of node.values) {
      if (value.endpoint !== endpoint) continue;
      const name = value.metadata?.label ?? String(value.property);
      const suffix = [label, name].filter(Boolean).join(" ");

      const sensor = (deviceClass: SensorState["deviceClass"]): EntitySpec => ({
        key: valueKey(value),
        domain: "sensor",
        label: suffix,
        read: (values) => {
          const reading = num(values.get(valueKey(value)));
          if (reading === undefined) return undefined;
          return { domain: "sensor", value: reading, unit: value.metadata?.unit, deviceClass };
        },
      });

      if (value.commandClass === CC.multilevelSensor) {
        specs.push(sensor(classOf(SENSOR_CLASS, name)));
      } else if (value.commandClass === CC.meter && value.property === "value") {
        // A meter's other values are its previous reading, the time since it, and the reset
        // command; only the reading itself is a sensor.
        specs.push(sensor(METER_CLASS[value.metadata?.unit ?? ""]));
      } else if (value.commandClass === CC.battery && value.property === "level") {
        specs.push(sensor("battery"));
      } else if (value.commandClass === CC.binarySensor) {
        specs.push({
          key: valueKey(value),
          domain: "binary_sensor",
          label: suffix,
          read: (values) => {
            const on = values.get(valueKey(value));
            if (typeof on !== "boolean") return undefined;
            return { domain: "binary_sensor", on, deviceClass: classOf(BINARY_CLASS, name) };
          },
        });
      } else if (value.commandClass === CC.notification) {
        // Only motion, door and barrier-obstruction notifications become entities.
        const kind: { deviceClass?: BinarySensorState["deviceClass"]; on: number[] } | undefined =
          /motion/i.test(name)
            ? { deviceClass: "motion", on: MOTION_DETECTED }
            : /^door state/i.test(name)
              ? { deviceClass: "door", on: [DOOR_OPEN] }
              : /barrier safety beam/i.test(name)
                ? { on: [BEAM_OBSTRUCTED] }
                : undefined;
        if (!kind) continue;
        specs.push({
          key: valueKey(value),
          domain: "binary_sensor",
          label: suffix,
          read: (values) => {
            const reading = num(values.get(valueKey(value)));
            return reading === undefined
              ? undefined
              : {
                  domain: "binary_sensor",
                  on: kind.on.includes(reading),
                  ...(kind.deviceClass ? { deviceClass: kind.deviceClass } : {}),
                };
          },
        });
      } else if (value.commandClass === CC.centralScene && value.property === "scene") {
        specs.push({
          key: valueKey(value),
          domain: "button",
          label: [label, `scene ${Number(value.propertyKey)}`].filter(Boolean).join(" "),
          scene: valueKey(value),
          read: () => ({ domain: "button" }),
        });
      }
    }
  }
  return specs;
}
