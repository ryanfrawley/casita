import { expect, test } from "bun:test";
import type { Command } from "@casita/core/types";
import { CC, type EntitySpec, entitiesFor, valueKey, zwaveNode } from "../src/mapping.ts";

const NODE_ID = 7;

/** A node with the given values; `deviceClass` is [generic, specific]. */
function node(values: Record<string, unknown>[], deviceClass?: [number, number]) {
  return zwaveNode.parse({
    nodeId: NODE_ID,
    values,
    deviceClass: deviceClass
      ? { generic: { key: deviceClass[0] }, specific: { key: deviceClass[1] } }
      : undefined,
  });
}

const values = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

function only(specs: EntitySpec[], domain: string): EntitySpec {
  const matching = specs.filter((s) => s.domain === domain);
  expect(matching).toHaveLength(1);
  const [spec] = matching;
  if (!spec) throw new Error(`no ${domain}`);
  return spec;
}

function write(spec: EntitySpec, command: Command, current = values({})) {
  if (!spec.write) throw new Error(`${spec.key} is read-only`);
  return spec.write(command, current);
}

const dimmerValue = { commandClass: CC.multilevelSwitch, property: "currentValue" };

// ───────── valueKey ─────────

test("valueKey joins endpoint, command class and property, adding propertyKey only when present", () => {
  expect(valueKey({ commandClass: 37, endpoint: 0, property: "currentValue" })).toBe(
    "0-37-currentValue",
  );
  expect(valueKey({ commandClass: 67, endpoint: 2, property: "setpoint", propertyKey: 1 })).toBe(
    "2-67-setpoint-1",
  );
  expect(valueKey({ commandClass: 113, endpoint: 0, property: 5, propertyKey: "Door state" })).toBe(
    "0-113-5-Door state",
  );
  // A propertyKey of 0 is still a key.
  expect(valueKey({ commandClass: 91, endpoint: 0, property: "scene", propertyKey: 0 })).toBe(
    "0-91-scene-0",
  );
});

test("the schema defaults a value's endpoint to 0 and a node's values to empty", () => {
  expect(zwaveNode.parse({ nodeId: 1 }).values).toEqual([]);
  const [value] = node([dimmerValue]).values;
  expect(value?.endpoint).toBe(0);
  expect(entitiesFor(zwaveNode.parse({ nodeId: 1 }), 1)).toEqual([]);
});

// ───────── switches and endpoints ─────────

test("each endpoint gets its own entities, labelled by endpoint number, in endpoint order", () => {
  const specs = entitiesFor(
    node([
      { commandClass: CC.binarySwitch, endpoint: 2, property: "currentValue" },
      { commandClass: CC.binarySwitch, endpoint: 1, property: "currentValue" },
      { commandClass: CC.binarySwitch, endpoint: 0, property: "currentValue" },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.key, s.domain, s.label])).toEqual([
    ["0-37-currentValue", "switch", ""],
    ["1-37-currentValue", "switch", "1"],
    ["2-37-currentValue", "switch", "2"],
  ]);
  const second = specs[2];
  if (!second) throw new Error("missing endpoint 2");
  expect(second.read(values({ "2-37-currentValue": true, "1-37-currentValue": false }))).toEqual({
    domain: "switch",
    on: true,
  });
  expect(write(second, { domain: "switch", action: "turn_off" })).toEqual([
    {
      command: "node.set_value",
      params: {
        nodeId: NODE_ID,
        valueId: { commandClass: CC.binarySwitch, endpoint: 2, property: "targetValue" },
        value: false,
      },
    },
  ]);
});

test("a binary switch reads nothing until its value is a boolean", () => {
  const spec = only(
    entitiesFor(node([{ commandClass: CC.binarySwitch, property: "currentValue" }]), NODE_ID),
    "switch",
  );
  expect(spec.read(values({}))).toBeUndefined();
  expect(spec.read(values({ "0-37-currentValue": null }))).toBeUndefined();
  expect(spec.read(values({ "0-37-currentValue": 255 }))).toBeUndefined();
});

// ───────── multilevel switch: cover or light ─────────

test("a multilevel switch is a cover for Window Covering or a motor-control specific class", () => {
  const domain = (deviceClass?: [number, number]) =>
    entitiesFor(node([dimmerValue], deviceClass), NODE_ID).map((s) => s.domain);
  expect(domain([0x09, 0x01])).toEqual(["cover"]);
  for (const specific of [0x03, 0x05, 0x06, 0x07])
    expect(domain([0x11, specific])).toEqual(["cover"]);
  expect(domain([0x11, 0x01])).toEqual(["light"]); // multilevel power switch
  expect(domain([0x11, 0x04])).toEqual(["light"]);
  expect(domain([0x10, 0x03])).toEqual(["light"]); // specific 3 under another generic
  expect(domain()).toEqual(["light"]);
});

test("a cover reads its position on the 0–99 scale and clamps out-of-range values", () => {
  const spec = only(entitiesFor(node([dimmerValue], [0x09, 0x01]), NODE_ID), "cover");
  expect(spec.capabilities).toEqual({ position: true });
  const read = (level: unknown) => spec.read(values({ "0-38-currentValue": level }));
  expect(read(0)).toEqual({ domain: "cover", motion: "stopped", position: 0 });
  expect(read(99)).toEqual({ domain: "cover", motion: "stopped", position: 1 });
  expect(read(255)).toEqual({ domain: "cover", motion: "stopped", position: 1 });
  expect(read("50")).toBeUndefined();
  expect(read(undefined)).toBeUndefined();
});

test("a cover opens, closes and positions via targetValue, and stops via the CC API", () => {
  const spec = only(entitiesFor(node([dimmerValue], [0x11, 0x06]), NODE_ID), "cover");
  const sent = (command: Command) =>
    write(spec, command).map((c) => (c.command === "node.set_value" ? c.params.value : c));
  expect(sent({ domain: "cover", action: "open" })).toEqual([99]);
  expect(sent({ domain: "cover", action: "close" })).toEqual([0]);
  expect(sent({ domain: "cover", action: "set_position", position: 0.5 })).toEqual([50]);
  expect(sent({ domain: "cover", action: "stop" })).toEqual([
    {
      command: "endpoint.invoke_cc_api",
      params: {
        nodeId: NODE_ID,
        endpoint: 0,
        commandClass: CC.multilevelSwitch,
        methodName: "stopLevelChange",
        args: [],
      },
    },
  ]);
  expect(write(spec, { domain: "light", action: "turn_off" })).toEqual([]);
});

// ───────── barrier operator (garage door) ─────────

const barrierValues = [
  { commandClass: CC.barrierOperator, property: "currentState" },
  { commandClass: CC.barrierOperator, property: "targetState" },
  { commandClass: CC.barrierOperator, property: "position" },
];
const STATE = "0-102-currentState";
const POSITION = "0-102-position";

test("a barrier operator is one cover with no position capability, keyed by its current state", () => {
  const specs = entitiesFor(node(barrierValues), NODE_ID);
  expect(specs.map((s) => [s.domain, s.key, s.label])).toEqual([["cover", STATE, ""]]);
  expect(specs[0]?.capabilities).toBeUndefined();
});

test("a barrier reads open, closed, opening and closing from zwave-js's state codes", () => {
  const spec = only(entitiesFor(node(barrierValues), NODE_ID), "cover");
  const read = (state: unknown, position?: unknown) =>
    spec.read(values({ [STATE]: state, [POSITION]: position }));
  expect(read(255, 100)).toEqual({ domain: "cover", motion: "stopped", position: 1 });
  expect(read(0, 0)).toEqual({ domain: "cover", motion: "stopped", position: 0 });
  // While moving, zwave-js has no position.
  expect(read(254, null)).toEqual({ domain: "cover", motion: "opening", position: undefined });
  expect(read(252, null)).toEqual({ domain: "cover", motion: "closing", position: undefined });
  // Stopped part way: with a position when the report carried one, without when it did not.
  expect(read(253, 40)).toEqual({ domain: "cover", motion: "stopped", position: 0.4 });
  expect(read(253, null)).toEqual({ domain: "cover", motion: "stopped", position: undefined });
  // Unknown until the first report.
  expect(read(null)).toBeUndefined();
  expect(read(undefined)).toBeUndefined();
});

test("a barrier opens and closes via targetState, and cannot stop or take a position", () => {
  const spec = only(entitiesFor(node(barrierValues), NODE_ID), "cover");
  expect(write(spec, { domain: "cover", action: "open" })).toEqual([
    {
      command: "node.set_value",
      params: {
        nodeId: NODE_ID,
        valueId: { commandClass: CC.barrierOperator, endpoint: 0, property: "targetState" },
        value: 255,
      },
    },
  ]);
  expect(write(spec, { domain: "cover", action: "close" }).map((c) => c.params.value)).toEqual([0]);
  expect(() => write(spec, { domain: "cover", action: "stop" })).toThrow(/only opens or closes/);
  expect(() => write(spec, { domain: "cover", action: "set_position", position: 0.5 })).toThrow();
  expect(write(spec, { domain: "switch", action: "turn_on" })).toEqual([]);
});

test("a barrier's safety-beam obstruction notification is a binary sensor, on at 255", () => {
  const key = "0-113-Access Control-Barrier safety beam obstacle status";
  const specs = entitiesFor(
    node([
      ...barrierValues,
      {
        commandClass: CC.notification,
        property: "Access Control",
        propertyKey: "Barrier safety beam obstacle status",
        metadata: { label: "Barrier safety beam obstacle status" },
      },
    ]),
    NODE_ID,
  );
  const beam = only(specs, "binary_sensor");
  expect(beam.label).toBe("Barrier safety beam obstacle status");
  expect(beam.read(values({ [key]: 255 }))).toEqual({ domain: "binary_sensor", on: true });
  expect(beam.read(values({ [key]: 0 }))).toEqual({ domain: "binary_sensor", on: false });
  expect(beam.read(values({ [key]: null }))).toBeUndefined();
});

test("a dimmer reads off at 0, full at 99, and clamps or ignores out-of-range values", () => {
  const spec = only(entitiesFor(node([dimmerValue]), NODE_ID), "light");
  expect(spec.capabilities).toEqual({ brightness: true, transition: true });
  const read = (level: unknown) => spec.read(values({ "0-38-currentValue": level }));
  expect(read(0)).toEqual({ domain: "light", on: false, brightness: undefined });
  expect(read(99)).toEqual({ domain: "light", on: true, brightness: 1 });
  expect(read(33)).toEqual({ domain: "light", on: true, brightness: 33 / 99 });
  expect(read(255)).toEqual({ domain: "light", on: true, brightness: 1 });
  expect(read(-5)).toEqual({ domain: "light", on: false, brightness: undefined });
  expect(read(Number.NaN)).toBeUndefined();
  expect(read(null)).toBeUndefined();
  expect(read("on")).toBeUndefined();
});

test("a dimmer turns on to its previous level (255) without a brightness, and never to 0", () => {
  const spec = only(entitiesFor(node([dimmerValue]), NODE_ID), "light");
  const sent = (command: Command) => write(spec, command).map((c) => c.params);
  expect(sent({ domain: "light", action: "turn_on" })).toMatchObject([{ value: 255 }]);
  expect(sent({ domain: "light", action: "turn_on", brightness: 1 })).toMatchObject([
    { value: 99 },
  ]);
  expect(sent({ domain: "light", action: "turn_on", brightness: 0.004 })).toMatchObject([
    { value: 1 },
  ]);
  expect(sent({ domain: "light", action: "turn_off" })).toEqual([
    {
      nodeId: NODE_ID,
      valueId: { commandClass: CC.multilevelSwitch, endpoint: 0, property: "targetValue" },
      value: 0,
    },
  ]);
  expect(write(spec, { domain: "cover", action: "open" })).toEqual([]);
});

test("a dimmer passes a transition as whole seconds in the set_value options", () => {
  const spec = only(entitiesFor(node([dimmerValue]), NODE_ID), "light");
  const options = (command: Command) => write(spec, command).map((c) => c.params.options);
  expect(options({ domain: "light", action: "turn_on", transitionMs: 2400 })).toEqual([
    { transitionDuration: "2s" },
  ]);
  expect(options({ domain: "light", action: "turn_off", transitionMs: 0 })).toEqual([
    { transitionDuration: "0s" },
  ]);
  expect(options({ domain: "light", action: "turn_on" })).toEqual([undefined]);
});

// ───────── locks ─────────

test("a door lock is locked only in mode 255 (secured)", () => {
  const spec = only(
    entitiesFor(node([{ commandClass: CC.doorLock, property: "currentMode" }]), NODE_ID),
    "lock",
  );
  const read = (mode: unknown) => spec.read(values({ "0-98-currentMode": mode }));
  expect(read(255)).toEqual({ domain: "lock", locked: true });
  expect(read(0)).toEqual({ domain: "lock", locked: false });
  expect(read(1)).toEqual({ domain: "lock", locked: false });
  expect(read(undefined)).toBeUndefined();
  expect(write(spec, { domain: "lock", action: "lock" })).toMatchObject([
    { params: { valueId: { property: "targetMode" }, value: 255 } },
  ]);
  expect(write(spec, { domain: "lock", action: "unlock" })).toMatchObject([
    { params: { value: 0 } },
  ]);
});

// ───────── thermostats ─────────

const heatingSetpoint = {
  commandClass: CC.thermostatSetpoint,
  property: "setpoint",
  propertyKey: 1,
  metadata: { min: 5, max: 30 },
};
const coolingSetpoint = {
  commandClass: CC.thermostatSetpoint,
  property: "setpoint",
  propertyKey: 2,
};
const thermostatMode = { commandClass: CC.thermostatMode, property: "mode" };
const airTemperature = { commandClass: CC.multilevelSensor, property: "Air temperature" };

test("a thermostat with no mode value only heats, and cannot have its mode set", async () => {
  const spec = only(entitiesFor(node([heatingSetpoint, airTemperature]), NODE_ID), "climate");
  expect(spec.key).toBe("0-64-climate");
  expect(spec.capabilities).toEqual({ tempRange: { min: 5, max: 30, step: 0.5 } });
  expect(spec.read(values({}))).toEqual({
    domain: "climate",
    mode: "heat",
    currentTemp: undefined,
    targetTemp: undefined,
  });
  expect(spec.read(values({ "0-67-setpoint-1": 20, "0-49-Air temperature": 18.5 }))).toEqual({
    domain: "climate",
    mode: "heat",
    currentTemp: 18.5,
    targetTemp: 20,
  });
  expect(() => write(spec, { domain: "climate", action: "set_mode", mode: "cool" })).toThrow(
    "no mode control",
  );
  expect(write(spec, { domain: "climate", action: "set_target", temp: 21 })).toMatchObject([
    { params: { valueId: { property: "setpoint", propertyKey: 1 }, value: 21 } },
  ]);
});

test("a thermostat with only a cooling setpoint still uses it as its target", () => {
  const spec = only(entitiesFor(node([coolingSetpoint]), NODE_ID), "climate");
  expect(spec.capabilities).toEqual({ tempRange: undefined });
  expect(spec.read(values({ "0-67-setpoint-2": 24 }))).toMatchObject({ targetTemp: 24 });
  expect(write(spec, { domain: "climate", action: "set_target", temp: 23 })).toMatchObject([
    { params: { valueId: { propertyKey: 2 }, value: 23 } },
  ]);
});

test("in cool mode a thermostat reads and writes the cooling setpoint; otherwise the heating one", () => {
  const spec = only(
    entitiesFor(node([thermostatMode, heatingSetpoint, coolingSetpoint]), NODE_ID),
    "climate",
  );
  const current = (mode: number) =>
    values({ "0-64-mode": mode, "0-67-setpoint-1": 20, "0-67-setpoint-2": 25 });
  expect(spec.read(current(2))).toMatchObject({ mode: "cool", targetTemp: 25 });
  expect(spec.read(current(1))).toMatchObject({ mode: "heat", targetTemp: 20 });
  expect(spec.read(current(3))).toMatchObject({ mode: "auto", targetTemp: 20 });
  expect(spec.read(current(0))).toMatchObject({ mode: "off", targetTemp: 20 });
  const target = (mode: number) =>
    write(spec, { domain: "climate", action: "set_target", temp: 22 }, current(mode));
  expect(target(2)).toMatchObject([{ params: { valueId: { propertyKey: 2 } } }]);
  expect(target(1)).toMatchObject([{ params: { valueId: { propertyKey: 1 } } }]);
});

test("set_mode writes the Z-Wave mode number", () => {
  const spec = only(entitiesFor(node([thermostatMode, heatingSetpoint]), NODE_ID), "climate");
  const mode = (name: "off" | "heat" | "cool" | "auto") =>
    write(spec, { domain: "climate", action: "set_mode", mode: name }).map((c) => c.params.value);
  expect([mode("off"), mode("heat"), mode("cool"), mode("auto")]).toEqual([[0], [1], [2], [3]]);
});

test("a thermostat with a mode control reads nothing until it has a mode or a target", () => {
  const spec = only(entitiesFor(node([thermostatMode, heatingSetpoint]), NODE_ID), "climate");
  expect(spec.read(values({}))).toBeUndefined();
  expect(spec.read(values({ "0-64-mode": 1 }))).toMatchObject({
    mode: "heat",
    targetTemp: undefined,
  });
});

test("a thermostat mode with no setpoint at all cannot take a target", () => {
  const spec = only(entitiesFor(node([thermostatMode]), NODE_ID), "climate");
  expect(() => write(spec, { domain: "climate", action: "set_target", temp: 20 })).toThrow(
    "no setpoint",
  );
});

// ───────── sensors ─────────

test("multilevel sensors become sensors classed by their label, read only from finite numbers", () => {
  const specs = entitiesFor(
    node([
      { ...airTemperature, metadata: { label: "Air temperature", unit: "°C" } },
      {
        commandClass: CC.multilevelSensor,
        endpoint: 1,
        property: "Power",
        metadata: { unit: "W" },
      },
      { commandClass: CC.multilevelSensor, property: "Ultraviolet" },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.domain, s.label])).toEqual([
    ["sensor", "Air temperature"],
    ["sensor", "Ultraviolet"],
    ["sensor", "1 Power"],
  ]);
  const [temp, uv, power] = specs;
  if (!temp || !uv || !power) throw new Error("missing sensors");
  expect(temp.read(values({ "0-49-Air temperature": 21.5 }))).toEqual({
    domain: "sensor",
    value: 21.5,
    unit: "°C",
    deviceClass: "temperature",
  });
  expect(power.read(values({ "1-49-Power": 3 }))).toMatchObject({
    deviceClass: "power",
    unit: "W",
  });
  expect(uv.read(values({ "0-49-Ultraviolet": 2 }))).toMatchObject({ deviceClass: undefined });
  expect(temp.read(values({ "0-49-Air temperature": "21.5" }))).toBeUndefined();
  expect(temp.read(values({ "0-49-Air temperature": null }))).toBeUndefined();
  expect(temp.read(values({ "0-49-Air temperature": Number.POSITIVE_INFINITY }))).toBeUndefined();
});

test("binary sensors read only booleans and are classed by their label", () => {
  const specs = entitiesFor(
    node([
      { commandClass: CC.binarySensor, property: "Door/Window" },
      { commandClass: CC.binarySensor, property: "Any", metadata: { label: "Water leak" } },
    ]),
    NODE_ID,
  );
  const [door, leak] = specs;
  if (!door || !leak) throw new Error("missing binary sensors");
  expect(door.read(values({ "0-48-Door/Window": true }))).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "door",
  });
  expect(leak.read(values({ "0-48-Any": false }))).toMatchObject({
    on: false,
    deviceClass: "leak",
  });
  expect(door.read(values({ "0-48-Door/Window": 1 }))).toBeUndefined();
});

test("motion and door notifications become binary sensors; other notifications are skipped", () => {
  const notification = (property: string, propertyKey: string, label: string) => ({
    commandClass: CC.notification,
    property,
    propertyKey,
    metadata: { label },
  });
  const specs = entitiesFor(
    node([
      notification("Home Security", "Motion sensor status", "Motion sensor status"),
      notification("Access Control", "Door state", "Door state"),
      notification("Power Management", "Battery level status", "Battery level status"),
      notification("Home Security", "Cover status", "Cover status"),
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.key, s.label])).toEqual([
    ["0-113-Home Security-Motion sensor status", "Motion sensor status"],
    ["0-113-Access Control-Door state", "Door state"],
  ]);
  const [motion, door] = specs;
  if (!motion || !door) throw new Error("missing notification sensors");
  const motionKey = "0-113-Home Security-Motion sensor status";
  expect(motion.read(values({ [motionKey]: 8 }))).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "motion",
  });
  expect(motion.read(values({ [motionKey]: 0 }))).toMatchObject({ on: false });
  expect(motion.read(values({ [motionKey]: null }))).toBeUndefined();
  const doorKey = "0-113-Access Control-Door state";
  expect(door.read(values({ [doorKey]: 22 }))).toMatchObject({ on: true, deviceClass: "door" });
  expect(door.read(values({ [doorKey]: 23 }))).toMatchObject({ on: false });
});

// Home Security event 7 is "Motion detection, location provided"; it is as much motion as event 8.
test("a motion notification of event 7 (motion with location) reads as on", () => {
  const key = "0-113-Home Security-Motion sensor status";
  const spec = only(
    entitiesFor(
      node([
        {
          commandClass: CC.notification,
          property: "Home Security",
          propertyKey: "Motion sensor status",
          metadata: { label: "Motion sensor status" },
        },
      ]),
      NODE_ID,
    ),
    "binary_sensor",
  );
  expect(spec.read(values({ [key]: 7 }))).toMatchObject({ on: true });
});

// "Door handle state" reports 0 (closed) / 1 (open), not the 22/23 of "Door state", so mapping it
// as a door means it can never read open.
test("an Access Control 'Door handle state' value is not mapped as an always-closed door", () => {
  const key = "0-113-Access Control-Door handle state";
  const specs = entitiesFor(
    node([
      {
        commandClass: CC.notification,
        property: "Access Control",
        propertyKey: "Door handle state",
        metadata: { label: "Door handle state" },
      },
    ]),
    NODE_ID,
  );
  const opened = specs.map((s) => s.read(values({ [key]: 1 })));
  expect(opened.every((state) => state === undefined || ("on" in state && state.on))).toBe(true);
});

test("central scene keys become buttons that carry their scene value id", () => {
  const specs = entitiesFor(
    node([
      { commandClass: CC.centralScene, property: "scene", propertyKey: "001" },
      { commandClass: CC.centralScene, endpoint: 1, property: "scene", propertyKey: "002" },
      { commandClass: CC.centralScene, property: "slowRefresh" },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.domain, s.label, s.scene])).toEqual([
    ["button", "scene 1", "0-91-scene-001"],
    ["button", "1 scene 2", "1-91-scene-002"],
  ]);
  expect(specs[0]?.read(values({}))).toEqual({ domain: "button" });
});

test("meter readings become sensors classed by unit; previous values and reset are not", () => {
  const specs = entitiesFor(
    node([
      {
        commandClass: CC.meter,
        property: "value",
        propertyKey: 65537,
        metadata: { label: "Electric Consumption [kWh]", unit: "kWh" },
      },
      {
        commandClass: CC.meter,
        property: "value",
        propertyKey: 66049,
        metadata: { label: "Electric Consumption [W]", unit: "W" },
      },
      {
        commandClass: CC.meter,
        property: "value",
        propertyKey: 66561,
        metadata: { label: "Electric Consumption [V]", unit: "V" },
      },
      {
        commandClass: CC.meter,
        property: "previousValue",
        propertyKey: 65537,
        metadata: { label: "Electric Consumption [kWh] (prev. value)", unit: "kWh" },
      },
      {
        commandClass: CC.meter,
        property: "reset",
        metadata: { label: "Reset accumulated values" },
      },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.key, s.domain, s.label])).toEqual([
    ["0-50-value-65537", "sensor", "Electric Consumption [kWh]"],
    ["0-50-value-66049", "sensor", "Electric Consumption [W]"],
    ["0-50-value-66561", "sensor", "Electric Consumption [V]"],
  ]);
  const current = values({
    "0-50-value-65537": 12.34,
    "0-50-value-66049": 61.5,
    "0-50-value-66561": 119.8,
  });
  expect(specs.map((s) => s.read(current))).toEqual([
    { domain: "sensor", value: 12.34, unit: "kWh", deviceClass: "energy" },
    { domain: "sensor", value: 61.5, unit: "W", deviceClass: "power" },
    { domain: "sensor", value: 119.8, unit: "V", deviceClass: undefined },
  ]);
  expect(specs[0]?.write).toBeUndefined();
});

test("a meter or battery on an endpoint is labelled by it; a meter with no unit has no class", () => {
  const specs = entitiesFor(
    node([
      {
        commandClass: CC.meter,
        endpoint: 2,
        property: "value",
        propertyKey: 66049,
        metadata: { label: "Electric Consumption [W]", unit: "W" },
      },
      { commandClass: CC.meter, endpoint: 1, property: "value", propertyKey: 1 },
      { commandClass: CC.battery, endpoint: 1, property: "level" },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.key, s.label])).toEqual([
    ["1-50-value-1", "1 value"],
    ["1-128-level", "1 level"],
    ["2-50-value-66049", "2 Electric Consumption [W]"],
  ]);
  expect(specs[2]?.read(values({ "2-50-value-66049": 7 }))).toMatchObject({
    deviceClass: "power",
  });
  expect(specs[0]?.read(values({ "1-50-value-1": 3 }))).toEqual({
    domain: "sensor",
    value: 3,
    unit: undefined,
    deviceClass: undefined,
  });
});

test("a battery level is a battery sensor; the other battery values are ignored", () => {
  const specs = entitiesFor(
    node([
      {
        commandClass: CC.battery,
        property: "level",
        metadata: { label: "Battery level", unit: "%" },
      },
      { commandClass: CC.battery, property: "isLow", metadata: { label: "Low battery level" } },
    ]),
    NODE_ID,
  );
  expect(specs.map((s) => [s.key, s.domain, s.label])).toEqual([
    ["0-128-level", "sensor", "Battery level"],
  ]);
  expect(specs[0]?.read(values({ "0-128-level": 90 }))).toEqual({
    domain: "sensor",
    value: 90,
    unit: "%",
    deviceClass: "battery",
  });
  expect(specs[0]?.read(values({ "0-128-level": "unknown" }))).toBeUndefined();
});

test("values of command classes this mapping does not know are ignored", () => {
  expect(
    entitiesFor(
      node([
        { commandClass: 0x86, property: "firmwareVersions" },
        { commandClass: 0x72, property: "manufacturerId" },
      ]),
      NODE_ID,
    ),
  ).toEqual([]);
});
