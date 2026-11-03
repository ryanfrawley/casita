import { expect, test } from "bun:test";
import type { Command } from "@casita/core/types";
import { bridgeDevice, type EntitySpec, entitiesFor } from "../src/exposes.ts";

const STATE = 1;
const SET = 2;
const GET = 4;
const ALL = STATE | SET | GET;

function device(exposes: Record<string, unknown>[]) {
  return bridgeDevice.parse({
    ieee_address: "0x0000000000000001",
    friendly_name: "Thing",
    definition: { exposes },
  });
}

function single(exposes: Record<string, unknown>[]): EntitySpec {
  const specs = entitiesFor(device(exposes));
  expect(specs).toHaveLength(1);
  const [spec] = specs;
  if (!spec) throw new Error("no entity");
  return spec;
}

function write(spec: EntitySpec, command: Command) {
  if (!spec.write) throw new Error(`${spec.key} is read-only`);
  // undefined fields are dropped when the payload is serialized, so compare what is sent.
  return JSON.parse(JSON.stringify(spec.write(command))) as Record<string, unknown>;
}

const binaryFeature = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "binary",
  name,
  property: name,
  access: ALL,
  value_on: "ON",
  value_off: "OFF",
  ...extra,
});
const numericFeature = (name: string, extra: Record<string, unknown> = {}) => ({
  type: "numeric",
  name,
  property: name,
  access: ALL,
  ...extra,
});

// ───────── devices ─────────

test("a device with no definition, or no exposes, has no entities", () => {
  const base = { ieee_address: "0x1", friendly_name: "Coordinator" };
  expect(entitiesFor(bridgeDevice.parse({ ...base, definition: null }))).toEqual([]);
  expect(entitiesFor(bridgeDevice.parse(base))).toEqual([]);
  expect(entitiesFor(bridgeDevice.parse({ ...base, definition: {} }))).toEqual([]);
});

test("expose types this integration does not understand are skipped", () => {
  expect(
    entitiesFor(
      device([
        { type: "enum", name: "effect", property: "effect", access: SET, values: ["blink"] },
        { type: "text", name: "action", property: "action", access: STATE },
        { type: "composite", name: "options", property: "options", access: SET },
      ]),
    ),
  ).toEqual([]);
});

// The exposes come from the bridge as data; a type that names an Object.prototype member must not
// be treated as a builder.
test("an expose whose type names an Object prototype member yields no entity", () => {
  expect(entitiesFor(device([{ type: "constructor" }, { type: "toString" }]))).toEqual([]);
});

test("when two exposes would share a key, the first one wins", () => {
  const specs = entitiesFor(
    device([
      numericFeature("power", { unit: "W" }),
      numericFeature("power", { unit: "kW" }),
      { type: "switch", features: [binaryFeature("state")] },
      { type: "switch", features: [binaryFeature("state", { property: "relay" })] },
    ]),
  );
  expect(specs.map((s) => s.key)).toEqual(["power", "switch"]);
  expect(specs[0]?.read({ power: 5 })).toMatchObject({ unit: "W" });
  expect(specs[1]?.read({ state: "ON", relay: "OFF" })).toEqual({ domain: "switch", on: true });
});

// ───────── lights ─────────

test("a light without brightness or color temperature is on/off only", () => {
  const spec = single([{ type: "light", features: [binaryFeature("state")] }]);
  expect(spec.key).toBe("light");
  expect(spec.capabilities).toEqual({
    brightness: undefined,
    colorTemp: undefined,
    rgb: undefined,
    transition: true,
  });
  expect(spec.gettable).toEqual(["state"]);
  expect(spec.read({ state: "ON", brightness: 100 })).toEqual({
    domain: "light",
    on: true,
    brightness: undefined,
    colorTempK: undefined,
  });
  expect(spec.read({ state: "OFF" })).toMatchObject({ on: false });
  expect(spec.read({ state: "TOGGLE" })).toBeUndefined();
  expect(spec.read({})).toBeUndefined();
  expect(write(spec, { domain: "light", action: "turn_on" })).toEqual({ state: "ON" });
  expect(write(spec, { domain: "light", action: "turn_off", transitionMs: 1500 })).toEqual({
    state: "OFF",
    transition: 1.5,
  });
  expect(write(spec, { domain: "switch", action: "turn_on" })).toEqual({});
});

test("a light without color temperature still scales brightness to its value_max", () => {
  const spec = single([
    {
      type: "light",
      features: [binaryFeature("state"), numericFeature("brightness", { value_max: 100 })],
    },
  ]);
  expect(spec.capabilities).toMatchObject({ brightness: true, colorTemp: undefined });
  expect(spec.read({ state: "ON", brightness: 50 })).toMatchObject({ brightness: 0.5 });
  expect(spec.read({ state: "ON", brightness: 0 })).toMatchObject({ on: true, brightness: 0 });
  expect(spec.read({ state: "ON", brightness: 300 })).toMatchObject({ brightness: 1 });
  expect(spec.read({ state: "ON", brightness: "50" })).toMatchObject({ brightness: undefined });
  expect(write(spec, { domain: "light", action: "turn_on", brightness: 0.5 })).toEqual({
    state: "ON",
    brightness: 50,
  });
  // A tiny brightness rounds up to the dimmest step rather than to "off".
  expect(write(spec, { domain: "light", action: "turn_on", brightness: 0.001 })).toEqual({
    state: "ON",
    brightness: 1,
  });
});

test("a light's color temperature range is converted from mireds, and 0 mireds is ignored", () => {
  const spec = single([
    {
      type: "light",
      features: [
        binaryFeature("state"),
        numericFeature("brightness", { value_max: 254 }),
        numericFeature("color_temp", { value_min: 153, value_max: 500 }),
        { type: "composite", name: "color_xy", property: "color", access: ALL },
      ],
    },
  ]);
  expect(spec.capabilities).toEqual({
    brightness: true,
    colorTemp: { minK: 2000, maxK: 6536 },
    rgb: true,
    transition: true,
  });
  expect(spec.gettable).toEqual(["state", "brightness", "color_temp"]);
  expect(spec.read({ state: "ON", color_temp: 250 })).toMatchObject({ colorTempK: 4000 });
  expect(spec.read({ state: "ON", color_temp: 0 })).toMatchObject({ colorTempK: undefined });
  expect(
    write(spec, { domain: "light", action: "turn_on", colorTempK: 4000, rgb: [255, 0, 10] }),
  ).toEqual({ state: "ON", color_temp: 250, color: { r: 255, g: 0, b: 10 } });
});

test("a color temperature range starting at 0 mireds is not advertised", () => {
  const spec = single([
    {
      type: "light",
      features: [
        binaryFeature("state"),
        numericFeature("color_temp", { value_min: 0, value_max: 500 }),
      ],
    },
  ]);
  expect(spec.capabilities?.colorTemp).toBeUndefined();
});

test("a light honours custom value_on / value_off", () => {
  const spec = single([
    { type: "light", features: [binaryFeature("state", { value_on: 1, value_off: 0 })] },
  ]);
  expect(spec.read({ state: 1 })).toMatchObject({ on: true });
  expect(spec.read({ state: 0 })).toMatchObject({ on: false });
  expect(spec.read({ state: "ON" })).toBeUndefined();
  expect(write(spec, { domain: "light", action: "turn_on" })).toEqual({ state: 1 });
  expect(write(spec, { domain: "light", action: "turn_off" })).toEqual({ state: 0 });
});

test("endpoint lights read and write their endpoint-suffixed properties", () => {
  const specs = entitiesFor(
    device([
      {
        type: "light",
        endpoint: "l1",
        features: [
          binaryFeature("state", { property: "state_l1", endpoint: "l1" }),
          numericFeature("brightness", { property: "brightness_l1", endpoint: "l1" }),
        ],
      },
      {
        type: "light",
        endpoint: "l2",
        features: [binaryFeature("state", { property: "state_l2", endpoint: "l2" })],
      },
    ]),
  );
  expect(specs.map((s) => [s.key, s.label])).toEqual([
    ["light_l1", "l1"],
    ["light_l2", "l2"],
  ]);
  const [l1, l2] = specs;
  if (!l1 || !l2) throw new Error("missing endpoints");
  const payload = { state_l1: "ON", brightness_l1: 127, state_l2: "OFF" };
  expect(l1.read(payload)).toMatchObject({ on: true, brightness: 0.5 });
  expect(l2.read(payload)).toMatchObject({ on: false });
  expect(write(l1, { domain: "light", action: "turn_on", brightness: 1 })).toEqual({
    state_l1: "ON",
    brightness_l1: 254,
  });
  expect(l1.gettable).toEqual(["state_l1", "brightness_l1"]);
});

test("a light expose without a state feature is skipped", () => {
  expect(
    entitiesFor(device([{ type: "light", features: [numericFeature("brightness")] }])),
  ).toEqual([]);
});

// ───────── switches ─────────

test("a switch honours custom value_on / value_off and only lists gettable properties", () => {
  const spec = single([
    {
      type: "switch",
      features: [
        binaryFeature("state", { value_on: "open", value_off: "closed", access: STATE | SET }),
      ],
    },
  ]);
  expect(spec.gettable).toEqual([]);
  expect(spec.read({ state: "open" })).toEqual({ domain: "switch", on: true });
  expect(spec.read({ state: "closed" })).toEqual({ domain: "switch", on: false });
  expect(spec.read({ state: "ON" })).toBeUndefined();
  expect(write(spec, { domain: "switch", action: "turn_on" })).toEqual({ state: "open" });
  expect(write(spec, { domain: "switch", action: "turn_off" })).toEqual({ state: "closed" });
});

// ───────── covers ─────────

test("a cover with only state reads OPEN/CLOSE as fully open/closed and cannot be positioned", () => {
  const spec = single([
    {
      type: "cover",
      features: [
        {
          type: "enum",
          name: "state",
          property: "state",
          access: SET | STATE,
          values: ["OPEN", "CLOSE", "STOP"],
        },
      ],
    },
  ]);
  expect(spec.key).toBe("cover");
  expect(spec.capabilities).toEqual({ position: undefined });
  expect(spec.read({ state: "OPEN" })).toEqual({ domain: "cover", motion: "stopped", position: 1 });
  expect(spec.read({ state: "CLOSE" })).toEqual({
    domain: "cover",
    motion: "stopped",
    position: 0,
  });
  expect(spec.read({ state: "STOP" })).toBeUndefined();
  expect(write(spec, { domain: "cover", action: "open" })).toEqual({ state: "OPEN" });
  expect(write(spec, { domain: "cover", action: "close" })).toEqual({ state: "CLOSE" });
  expect(write(spec, { domain: "cover", action: "stop" })).toEqual({ state: "STOP" });
});

test("a cover with position prefers it over state, clamps it, and sets it in percent", () => {
  const spec = single([
    {
      type: "cover",
      features: [
        { type: "enum", name: "state", property: "state", access: SET | STATE },
        numericFeature("position", { value_min: 0, value_max: 100 }),
      ],
    },
  ]);
  expect(spec.capabilities).toEqual({ position: true });
  expect(spec.read({ state: "OPEN", position: 25 })).toMatchObject({ position: 0.25 });
  expect(spec.read({ position: 140 })).toMatchObject({ position: 1 });
  expect(write(spec, { domain: "cover", action: "set_position", position: 0.333 })).toEqual({
    position: 33,
  });
  expect(write(spec, { domain: "light", action: "turn_off" })).toEqual({});
});

test("a read-only position does not make a cover positionable", () => {
  const spec = single([
    { type: "cover", features: [numericFeature("position", { access: STATE })] },
  ]);
  expect(spec.capabilities).toEqual({ position: undefined });
  expect(spec.read({ position: 0 })).toMatchObject({ position: 0 });
});

// ───────── locks ─────────

test("a lock reads LOCK/UNLOCK and reports a jam from lock_state", () => {
  const spec = single([
    {
      type: "lock",
      features: [
        binaryFeature("state", { value_on: "LOCK", value_off: "UNLOCK" }),
        { type: "enum", name: "lock_state", property: "lock_state", access: STATE },
      ],
    },
  ]);
  expect(spec.read({ state: "LOCK", lock_state: "locked" })).toEqual({
    domain: "lock",
    locked: true,
    jammed: undefined,
  });
  expect(spec.read({ state: "LOCK", lock_state: "not_fully_locked" })).toEqual({
    domain: "lock",
    locked: true,
    jammed: true,
  });
  expect(spec.read({ state: "UNLOCK" })).toMatchObject({ locked: false });
  expect(spec.read({ lock_state: "locked" })).toBeUndefined();
  expect(write(spec, { domain: "lock", action: "lock" })).toEqual({ state: "LOCK" });
  expect(write(spec, { domain: "lock", action: "unlock" })).toEqual({ state: "UNLOCK" });
});

// ───────── climate ─────────

test("a thermostat with no system_mode always heats and refuses set_mode", () => {
  const spec = single([
    {
      type: "climate",
      features: [
        numericFeature("current_heating_setpoint", {
          value_min: 4,
          value_max: 35,
          value_step: 0.5,
        }),
        numericFeature("local_temperature", { access: STATE | GET }),
      ],
    },
  ]);
  expect(spec.capabilities).toEqual({ tempRange: { min: 4, max: 35, step: 0.5 } });
  expect(spec.gettable).toEqual(["current_heating_setpoint", "local_temperature"]);
  expect(spec.read({ current_heating_setpoint: 21, local_temperature: 19.5 })).toEqual({
    domain: "climate",
    mode: "heat",
    currentTemp: 19.5,
    targetTemp: 21,
  });
  expect(spec.read({ local_temperature: 19.5 })).toBeUndefined();
  expect(write(spec, { domain: "climate", action: "set_target", temp: 22 })).toEqual({
    current_heating_setpoint: 22,
  });
  expect(() => write(spec, { domain: "climate", action: "set_mode", mode: "off" })).toThrow(
    "no mode control",
  );
});

test("a thermostat with system_mode reads and sets it, defaulting unknown modes to heat", () => {
  const spec = single([
    {
      type: "climate",
      features: [
        numericFeature("occupied_heating_setpoint"),
        { type: "enum", name: "system_mode", property: "system_mode", access: ALL },
      ],
    },
  ]);
  expect(spec.capabilities).toEqual({ tempRange: undefined });
  expect(spec.read({ system_mode: "off" })).toMatchObject({ mode: "off", targetTemp: undefined });
  expect(spec.read({ system_mode: "cool", occupied_heating_setpoint: 20 })).toMatchObject({
    mode: "cool",
    targetTemp: 20,
  });
  expect(spec.read({ system_mode: "emergency_heating" })).toMatchObject({ mode: "heat" });
  expect(write(spec, { domain: "climate", action: "set_mode", mode: "auto" })).toEqual({
    system_mode: "auto",
  });
  expect(write(spec, { domain: "lock", action: "lock" })).toEqual({});
});

test("a climate expose without any setpoint is skipped", () => {
  expect(
    entitiesFor(
      device([
        { type: "climate", features: [numericFeature("local_temperature", { access: STATE })] },
      ]),
    ),
  ).toEqual([]);
});

// ───────── numeric and binary sensors ─────────

test("numeric exposes become sensors unless they lack the state bit or are attributes", () => {
  const specs = entitiesFor(
    device([
      numericFeature("temperature", { access: STATE | GET, unit: "°C" }),
      numericFeature("soil_moisture", { access: STATE, unit: "%" }),
      numericFeature("motion_sensitivity", { access: SET }),
      numericFeature("linkquality", { access: STATE }),
      numericFeature("voltage", { access: STATE }),
    ]),
  );
  expect(specs.map((s) => [s.key, s.label, s.gettable])).toEqual([
    ["temperature", "temperature", ["temperature"]],
    ["soil_moisture", "soil moisture", []],
    ["voltage", "voltage", []],
  ]);
  const [temperature, moisture, voltage] = specs;
  expect(temperature?.read({ temperature: 21.4 })).toEqual({
    domain: "sensor",
    value: 21.4,
    unit: "°C",
    deviceClass: "temperature",
  });
  expect(moisture?.read({ soil_moisture: 40 })).toMatchObject({ deviceClass: "humidity" });
  expect(voltage?.read({ voltage: 3000 })).toMatchObject({ deviceClass: undefined });
  expect(temperature?.read({ temperature: null })).toBeUndefined();
  expect(temperature?.read({})).toBeUndefined();
  expect(temperature?.write).toBeUndefined();
});

test("endpoint-suffixed numeric properties are distinct sensors classed by their name", () => {
  const specs = entitiesFor(
    device([
      numericFeature("power", { property: "power_l1", access: STATE }),
      numericFeature("power", { property: "power_l2", access: STATE }),
    ]),
  );
  expect(specs.map((s) => s.key)).toEqual(["power_l1", "power_l2"]);
  expect(specs[1]?.read({ power_l1: 1, power_l2: 2 })).toMatchObject({
    value: 2,
    deviceClass: "power",
  });
});

test("binary exposes become binary sensors; settable ones are configuration and skipped", () => {
  const specs = entitiesFor(
    device([
      { type: "binary", name: "occupancy", property: "occupancy", access: STATE },
      {
        type: "binary",
        name: "contact",
        property: "contact",
        access: STATE,
        value_on: false,
        value_off: true,
      },
      {
        type: "binary",
        name: "child_lock",
        property: "child_lock",
        access: ALL,
        value_on: "LOCK",
        value_off: "UNLOCK",
      },
      { type: "binary", name: "tamper", property: "tamper", access: SET },
    ]),
  );
  expect(specs.map((s) => [s.key, s.domain])).toEqual([
    ["occupancy", "binary_sensor"],
    ["contact", "binary_sensor"],
  ]);
  const [occupancy, contact] = specs;
  expect(occupancy?.read({ occupancy: true })).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "occupancy",
  });
  expect(occupancy?.read({ occupancy: "yes" })).toBeUndefined();
  // value_on carries the sense: contact = false means the door is open.
  expect(contact?.read({ contact: false })).toMatchObject({ on: true, deviceClass: "door" });
  expect(contact?.read({ contact: true })).toMatchObject({ on: false });
});
