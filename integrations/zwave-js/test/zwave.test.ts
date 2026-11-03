import { afterEach, describe, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import { createZwaveIntegration, securityClassName } from "../src/index.ts";
import {
  CONFIG_FIXTURE_URL,
  type FakeServerOptions,
  FakeZwaveServer,
  HOME_ID,
  QR,
  QR_DSK,
} from "./fake-server.ts";

const integration = createZwaveIntegration({
  connectTimeoutMs: 500,
  backoffBaseMs: 20,
  backoffMaxMs: 40,
});
const id = (rest: string) => `${HOME_ID}-${rest}`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(options: FakeServerOptions = {}) {
  const server = await FakeZwaveServer.start(options);
  const t = createTestContext(integration.configSchema.parse({ serverUrl: server.url }));
  cleanups.push(() => {
    t.abort();
    server.stop();
  });
  await integration.setup(t.ctx);
  return { server, t };
}

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}
const stateOf = (t: TestContext<unknown>, uniqueId: string) =>
  t.state(id(uniqueId))?.state as Record<string, unknown> | undefined;

test("builds devices per node and entities per value from the node dump", async () => {
  const { t } = await setup();
  expect([...t.devices.values()].map((d) => [d.uniqueId, d.name, d.model])).toEqual([
    [id("1"), "Zooz ZST39", "ZST39"],
    [id("2"), "Porch plug", "ZW096"],
    [id("3"), "Inovelli LZW31", "LZW31"],
    [id("4"), "Bedroom blind", "FGR223"],
    [id("5"), "Front door", "BE469ZP"],
    [id("6"), "Hallway thermostat", "T6 Pro"],
    [id("7"), "Hall sensor", "ZW100"],
    [id("8"), "Dead plug", "ZW096"],
    [id("10"), "Double relay", "ZMNHBD"], // node 9 is not ready yet
  ]);
  expect<string[][]>([...t.entities.values()].map((e) => [e.id, e.uniqueId])).toEqual([
    ["switch.porch_plug", id("2-0-37-currentValue")],
    ["sensor.porch_plug_power", id("2-0-49-Power")],
    ["sensor.porch_plug_electric_consumption_kwh", id("2-0-50-value-65537")],
    ["light.inovelli_lzw31", id("3-0-38-currentValue")],
    ["button.inovelli_lzw31_scene_1", id("3-0-91-scene-001")],
    ["button.inovelli_lzw31_scene_2", id("3-0-91-scene-002")],
    ["cover.bedroom_blind", id("4-0-38-currentValue")],
    ["lock.front_door", id("5-0-98-currentMode")],
    ["binary_sensor.front_door_door_state", id("5-0-113-Access Control-Door state")],
    ["climate.hallway_thermostat", id("6-0-64-climate")],
    ["sensor.hallway_thermostat_air_temperature", id("6-0-49-Air temperature")],
    ["binary_sensor.hall_sensor_sensor_state_motion", id("7-0-48-Motion")],
    [
      "binary_sensor.hall_sensor_motion_sensor_status",
      id("7-0-113-Home Security-Motion sensor status"),
    ],
    ["sensor.hall_sensor_humidity", id("7-0-49-Humidity")],
    ["sensor.hall_sensor_battery_level", id("7-0-128-level")],
    ["switch.dead_plug", id("8-0-37-currentValue")],
    ["switch.double_relay_1", id("10-1-37-currentValue")],
    ["switch.double_relay_2", id("10-2-37-currentValue")],
  ]);
  expect(t.entity(id("3-0-38-currentValue")).capabilities).toEqual({
    brightness: true,
    transition: true,
  });
  expect(t.entity(id("6-0-64-climate")).capabilities).toEqual({
    tempRange: { min: 10, max: 30, step: 0.5 },
  });
});

test("reports the dump's values as state; a dead node is unavailable, a sleeping one is not", async () => {
  const { t } = await setup();
  expect(stateOf(t, "2-0-37-currentValue")).toEqual({ domain: "switch", on: false });
  expect(stateOf(t, "2-0-49-Power")).toEqual({
    domain: "sensor",
    value: 0,
    unit: "W",
    deviceClass: "power",
  });
  expect(stateOf(t, "2-0-50-value-65537")).toEqual({
    domain: "sensor",
    value: 12.34,
    unit: "kWh",
    deviceClass: "energy",
  });
  expect(stateOf(t, "7-0-128-level")).toEqual({
    domain: "sensor",
    value: 90,
    unit: "%",
    deviceClass: "battery",
  });
  expect(stateOf(t, "3-0-38-currentValue")).toEqual({ domain: "light", on: false });
  expect(stateOf(t, "4-0-38-currentValue")).toEqual({
    domain: "cover",
    motion: "stopped",
    position: 1,
  });
  expect(stateOf(t, "5-0-98-currentMode")).toEqual({ domain: "lock", locked: true });
  expect(stateOf(t, "5-0-113-Access Control-Door state")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "door",
  });
  expect(stateOf(t, "6-0-64-climate")).toEqual({
    domain: "climate",
    mode: "heat",
    currentTemp: 19.5,
    targetTemp: 20.5,
  });
  expect(stateOf(t, "7-0-48-Motion")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "motion",
  });
  expect(stateOf(t, "7-0-49-Humidity")).toEqual({
    domain: "sensor",
    value: 44,
    unit: "%",
    deviceClass: "humidity",
  });
  expect(stateOf(t, "3-0-91-scene-001")).toEqual({ domain: "button" });
  expect(t.state(id("8-0-37-currentValue"))?.available).toBe(false);
  expect(t.state(id("7-0-48-Motion"))?.available).toBe(true);
});

test("value updates become state reports", async () => {
  const { server, t } = await setup();
  server.valueUpdated(2, { commandClass: 49, property: "Power" }, 61.5);
  server.valueUpdated(3, { commandClass: 38, property: "currentValue" }, 50);
  server.valueUpdated(
    5,
    { commandClass: 113, property: "Access Control", propertyKey: "Door state" },
    22,
  );
  server.valueUpdated(
    7,
    { commandClass: 113, property: "Home Security", propertyKey: "Motion sensor status" },
    8,
  );
  server.valueUpdated(6, { commandClass: 64, property: "mode" }, 2);
  server.valueUpdated(99, { commandClass: 37, property: "currentValue" }, true); // unknown node
  await until(() => stateOf(t, "6-0-64-climate")?.mode === "cool");
  expect(stateOf(t, "2-0-49-Power")).toMatchObject({ value: 61.5 });
  expect(stateOf(t, "3-0-38-currentValue")).toEqual({
    domain: "light",
    on: true,
    brightness: 50 / 99,
  });
  expect(stateOf(t, "5-0-113-Access Control-Door state")).toMatchObject({ on: true });
  expect(stateOf(t, "7-0-113-Home Security-Motion sensor status")).toMatchObject({
    on: true,
    deviceClass: "motion",
  });
  // In cooling mode the target is the cooling setpoint.
  expect(stateOf(t, "6-0-64-climate")).toEqual({
    domain: "climate",
    mode: "cool",
    currentTemp: 19.5,
    targetTemp: 25,
  });
});

test("value updates to a meter reading and a battery level become state reports", async () => {
  const { server, t } = await setup();
  server.valueUpdated(2, { commandClass: 50, property: "value", propertyKey: 65537 }, 13.5);
  server.valueUpdated(7, { commandClass: 128, property: "level" }, 40);
  await until(() => stateOf(t, "7-0-128-level")?.value === 40);
  expect(stateOf(t, "2-0-50-value-65537")).toEqual({
    domain: "sensor",
    value: 13.5,
    unit: "kWh",
    deviceClass: "energy",
  });
  expect(stateOf(t, "7-0-128-level")).toMatchObject({ unit: "%", deviceClass: "battery" });
});

test("commands become node.set_value calls with the value id", async () => {
  const { server, t } = await setup();
  await t.command(id("2-0-37-currentValue"), { domain: "switch", action: "turn_on" });
  await t.command(id("10-2-37-currentValue"), { domain: "switch", action: "turn_off" });
  await t.command(id("3-0-38-currentValue"), {
    domain: "light",
    action: "turn_on",
    brightness: 0.5,
    transitionMs: 2000,
  });
  await t.command(id("3-0-38-currentValue"), { domain: "light", action: "turn_on" });
  await t.command(id("3-0-38-currentValue"), { domain: "light", action: "turn_off" });
  await t.command(id("4-0-38-currentValue"), { domain: "cover", action: "close" });
  await t.command(id("4-0-38-currentValue"), {
    domain: "cover",
    action: "set_position",
    position: 0.5,
  });
  await t.command(id("4-0-38-currentValue"), { domain: "cover", action: "stop" });
  await t.command(id("5-0-98-currentMode"), { domain: "lock", action: "unlock" });
  await t.command(id("6-0-64-climate"), { domain: "climate", action: "set_target", temp: 22 });
  await t.command(id("6-0-64-climate"), { domain: "climate", action: "set_mode", mode: "auto" });

  const value = (commandClass: number, property: string, endpoint = 0, propertyKey?: number) => ({
    commandClass,
    endpoint,
    property,
    ...(propertyKey === undefined ? {} : { propertyKey }),
  });
  expect(server.commands).toEqual([
    { command: "node.set_value", nodeId: 2, valueId: value(37, "targetValue"), value: true },
    { command: "node.set_value", nodeId: 10, valueId: value(37, "targetValue", 2), value: false },
    {
      command: "node.set_value",
      nodeId: 3,
      valueId: value(38, "targetValue"),
      value: 50,
      options: { transitionDuration: "2s" },
    },
    { command: "node.set_value", nodeId: 3, valueId: value(38, "targetValue"), value: 255 },
    { command: "node.set_value", nodeId: 3, valueId: value(38, "targetValue"), value: 0 },
    { command: "node.set_value", nodeId: 4, valueId: value(38, "targetValue"), value: 0 },
    { command: "node.set_value", nodeId: 4, valueId: value(38, "targetValue"), value: 50 },
    {
      command: "endpoint.invoke_cc_api",
      nodeId: 4,
      endpoint: 0,
      commandClass: 38,
      methodName: "stopLevelChange",
      args: [],
    },
    { command: "node.set_value", nodeId: 5, valueId: value(98, "targetMode"), value: 0 },
    { command: "node.set_value", nodeId: 6, valueId: value(67, "setpoint", 0, 1), value: 22 },
    { command: "node.set_value", nodeId: 6, valueId: value(64, "mode"), value: 3 },
  ]);
  // State follows from the device's own reports.
  await until(() => stateOf(t, "5-0-98-currentMode")?.locked === false);
  expect(stateOf(t, "2-0-37-currentValue")).toMatchObject({ on: true });
  await expect(
    t.command(id("2-0-49-Power"), { domain: "switch", action: "turn_on" }),
  ).rejects.toThrow("read-only");
});

test("a command the server refuses rejects with its message", async () => {
  const { t } = await setup();
  await expect(
    t.command(id("8-0-37-currentValue"), { domain: "switch", action: "turn_off" }),
  ).rejects.toThrow("Node 8 is dead");
});

test("central scene notifications are button presses", async () => {
  const { server, t } = await setup();
  const before = t.reports.length;
  server.emit({
    source: "node",
    event: "value notification",
    nodeId: 3,
    args: { commandClass: 91, endpoint: 0, property: "scene", propertyKey: "002", value: 0 },
  });
  await until(() => stateOf(t, "3-0-91-scene-002")?.pressedAt !== undefined);
  expect(stateOf(t, "3-0-91-scene-001")).toEqual({ domain: "button" });
  expect(t.reports.length).toBe(before + 1);
  // A later value update on the node does not wipe the press.
  server.valueUpdated(3, { commandClass: 38, property: "currentValue" }, 10);
  await until(() => stateOf(t, "3-0-38-currentValue")?.on === true);
  expect(stateOf(t, "3-0-91-scene-002")?.pressedAt).toBeNumber();
});

test("node dead, alive, ready, and removed events", async () => {
  const { server, t } = await setup();
  const plug = id("2-0-37-currentValue");
  server.emit({ source: "node", event: "dead", nodeId: 2 });
  await until(() => t.state(plug)?.available === false);
  expect(t.state(id("2-0-49-Power"))?.available).toBe(false);
  server.emit({ source: "node", event: "alive", nodeId: 2 });
  await until(() => t.state(plug)?.available === true);

  // Node 9 finishes its interview.
  server.emit({
    source: "node",
    event: "ready",
    nodeId: 9,
    nodeState: {
      nodeId: 9,
      status: 4,
      ready: true,
      name: "New plug",
      values: [{ commandClass: 37, endpoint: 0, property: "currentValue", value: true }],
    },
  });
  await until(() => t.entities.size === 19);
  expect(stateOf(t, "9-0-37-currentValue")).toEqual({ domain: "switch", on: true });

  server.emit({ source: "controller", event: "node removed", node: { nodeId: 10 } });
  await until(() => t.entities.size === 17);
  expect([...t.entities.keys()].some((e) => e.includes("double_relay"))).toBe(false);
});

test("marks everything unavailable when the server goes away, and recovers when it returns", async () => {
  const { server, t } = await setup();
  server.stop();
  await until(() => [...t.states.values()].every((s) => !s.available), "unavailable");
  await expect(
    t.command(id("2-0-37-currentValue"), { domain: "switch", action: "turn_on" }),
  ).rejects.toThrow("The Z-Wave JS server is not connected");
  await expect(t.runAction("heal_network", {})).rejects.toThrow("not connected");

  await until(
    () => t.logs.filter((l) => l.msg === "Z-Wave JS server unreachable").length >= 2,
    "retries",
  );
  server.listen();
  await until(() => t.state(id("2-0-37-currentValue"))?.available === true, "recovery");
  expect(t.state(id("8-0-37-currentValue"))?.available).toBe(false); // still dead
  expect(t.entities.size).toBe(18);
});

test("an unreachable server or an incompatible schema rejects setup", async () => {
  const server = await FakeZwaveServer.start();
  const url = server.url;
  server.stop();
  const t = createTestContext(integration.configSchema.parse({ serverUrl: url }));
  await expect(integration.setup(t.ctx)).rejects.toThrow(
    `cannot connect to the Z-Wave JS server at ${url}`,
  );

  await expect(setup({ minSchemaVersion: 40, maxSchemaVersion: 44 })).rejects.toThrow(
    "the Z-Wave JS server speaks schemas 40 to 44; this client needs 35",
  );
  expect(integration.configSchema.parse({})).toEqual({ serverUrl: "ws://localhost:3000" });
});

test("exclusion and heal are integration actions", async () => {
  const { server, t } = await setup();
  for (const action of ["start_exclusion", "stop_exclusion", "heal_network", "stop_heal_network"]) {
    expect(await t.runAction(action, {})).toEqual({ success: true });
  }
  expect(server.commands).toEqual([
    { command: "controller.begin_exclusion" },
    { command: "controller.stop_exclusion" },
    { command: "controller.begin_rebuilding_routes" },
    { command: "controller.stop_rebuilding_routes" },
  ]);
});

const commandNamed = (server: FakeZwaveServer, name: string) =>
  server.commands.find((c) => c.command === name);

test("start_inclusion with a PIN grants every class asked for, answers the PIN, and reports the node", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", { pin: "12345" });
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  expect(commandNamed(server, "controller.begin_inclusion")).toEqual({
    command: "controller.begin_inclusion",
    options: { strategy: 0 },
  });

  server.askSecurityClasses([0, 1, 2]);
  await until(() => commandNamed(server, "controller.grant_security_classes") !== undefined);
  expect(commandNamed(server, "controller.grant_security_classes")).toEqual({
    command: "controller.grant_security_classes",
    inclusionGrant: { securityClasses: [0, 1, 2], clientSideAuth: false },
  });
  server.askPin();
  await until(() => commandNamed(server, "controller.validate_dsk_and_enter_pin") !== undefined);
  expect(commandNamed(server, "controller.validate_dsk_and_enter_pin")).toEqual({
    command: "controller.validate_dsk_and_enter_pin",
    pin: "12345",
  });
  server.nodeAdded(11, 2);
  expect(await outcome).toEqual({ nodeId: 11, securityClass: "S2 Access Control" });
  expect(commandNamed(server, "controller.stop_inclusion")).toBeUndefined();
});

test("start_inclusion without a PIN withholds the classes that need one, and says why security fell short", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", {});
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  server.askSecurityClasses([0, 1, 2, 7]);
  await until(() => commandNamed(server, "controller.grant_security_classes") !== undefined);
  expect(commandNamed(server, "controller.grant_security_classes")).toMatchObject({
    inclusionGrant: { securityClasses: [0, 7] },
  });
  // Should the driver ask anyway, an empty PIN makes it give up on S2 rather than hang.
  server.askPin();
  await until(() => commandNamed(server, "controller.validate_dsk_and_enter_pin") !== undefined);
  expect(commandNamed(server, "controller.validate_dsk_and_enter_pin")).toMatchObject({ pin: "" });
  server.emit({ source: "controller", event: "inclusion aborted" });
  server.nodeAdded(12, -1, 6); // zwave-js reports SecurityClass.None as -1
  expect(await outcome).toEqual({
    nodeId: 12,
    securityClass: "none",
    lowSecurityReason: "the PIN was wrong",
  });
});

test("start_inclusion with a QR code pairs by DSK with the S2 strategy", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", { qr: QR.s2 });
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  expect(commandNamed(server, "controller.begin_inclusion")).toEqual({
    command: "controller.begin_inclusion",
    options: { strategy: 4, provisioning: QR.s2 },
  });
  server.nodeAdded(13, 1);
  expect(await outcome).toEqual({ nodeId: 13, securityClass: "S2 Authenticated" });
});

test("start_inclusion gives up when no device joins in time, and stops the controller", async () => {
  const { server, t } = await setup();
  await expect(t.runAction("start_inclusion", { timeoutSec: 0.05 })).rejects.toThrow(
    "No device joined within 0 seconds",
  );
  await until(() => commandNamed(server, "controller.stop_inclusion") !== undefined);
  // The next inclusion is not blocked by the one that timed out.
  const again = t.runAction("start_inclusion", { pin: "12345" });
  await until(
    () => server.commands.filter((c) => c.command === "controller.begin_inclusion").length === 2,
  );
  server.nodeAdded(14, 2);
  expect(await again).toMatchObject({ nodeId: 14 });
});

test("start_inclusion rejects on failure, on stop_inclusion, when one is already running, and on disconnect", async () => {
  const { server, t } = await setup();
  const failed = t.runAction("start_inclusion", {});
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  await expect(t.runAction("start_inclusion", {})).rejects.toThrow("already in progress");
  server.emit({ source: "controller", event: "inclusion failed" });
  await expect(failed).rejects.toThrow("Inclusion failed");

  const stopped = t.runAction("start_inclusion", {});
  await until(
    () => server.commands.filter((c) => c.command === "controller.begin_inclusion").length === 2,
  );
  expect(await t.runAction("stop_inclusion", {})).toEqual({ success: true });
  await expect(stopped).rejects.toThrow("Inclusion was stopped");

  const lost = t.runAction("start_inclusion", {});
  await until(
    () => server.commands.filter((c) => c.command === "controller.begin_inclusion").length === 3,
  );
  server.stop();
  await expect(lost).rejects.toThrow("connection was lost");
  await expect(t.runAction("start_inclusion", {})).rejects.toThrow("not connected");
});

test("start_inclusion rejects when the aborted integration stops", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", {});
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  t.abort();
  await expect(outcome).rejects.toThrow("The integration was stopped");
});

test("start_inclusion rejects when the controller is busy, and does not block the next one", async () => {
  const { server, t } = await setup({ busy: true });
  await expect(t.runAction("start_inclusion", { timeoutSec: 0.05 })).rejects.toThrow(
    "The controller is busy with another operation",
  );
  // Not "already in progress": the refused inclusion was cleared.
  await expect(t.runAction("start_inclusion", {})).rejects.toThrow("controller is busy");
  // Its timeout was cleared too, so no stop_inclusion follows.
  await Bun.sleep(100);
  expect(commandNamed(server, "controller.stop_inclusion")).toBeUndefined();
});

test("malformed S2 prompts and node added events are ignored while an inclusion waits", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", {});
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  server.emit({ source: "controller", event: "grant security classes" });
  server.emit({
    source: "controller",
    event: "grant security classes",
    requested: { securityClasses: "all" },
  });
  server.emit({ source: "controller", event: "node added", node: { status: 0 } });
  // Events arrive in order, so once the well-formed prompt is answered the others were seen.
  server.askSecurityClasses([0]);
  await until(() => commandNamed(server, "controller.grant_security_classes") !== undefined);
  expect(
    server.commands.filter((c) => c.command === "controller.grant_security_classes"),
  ).toHaveLength(1);
  server.nodeAdded(16, 0);
  expect(await outcome).toEqual({ nodeId: 16, securityClass: "S2 Unauthenticated" });
});

test("start_inclusion names an unknown security class by number and an unknown failure as unknown", async () => {
  const { server, t } = await setup();
  const outcome = t.runAction("start_inclusion", {});
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  server.nodeAdded(17, 5, 42);
  expect(await outcome).toEqual({
    nodeId: 17,
    securityClass: "class 5",
    lowSecurityReason: "an unknown reason",
  });
});

test("securityClassName names zwave-js's classes, none, and unknown numbers", () => {
  expect([0, 1, 2, 7].map(securityClassName)).toEqual([
    "S2 Unauthenticated",
    "S2 Authenticated",
    "S2 Access Control",
    "S0 Legacy",
  ]);
  expect(securityClassName(null)).toBe("none");
  expect(securityClassName(undefined)).toBe("none");
  expect(securityClassName(3)).toBe("class 3");
});

test("a node added with no inclusion waiting (SmartStart) gets its entities when it is ready", async () => {
  const { server, t } = await setup();
  server.nodeAdded(18, 1);
  server.emit({
    source: "node",
    event: "ready",
    nodeId: 18,
    nodeState: {
      nodeId: 18,
      status: 4,
      ready: true,
      name: "SmartStart plug",
      values: [{ commandClass: 37, endpoint: 0, property: "currentValue", value: false }],
    },
  });
  await until(() => t.entities.size === 19);
  expect(stateOf(t, "18-0-37-currentValue")).toEqual({ domain: "switch", on: false });
  expect(t.logs.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
});

test("a PIN must be five digits; the CLI's number form is accepted", async () => {
  const { server, t } = await setup();
  await expect(t.runAction("start_inclusion", { pin: "1234" })).rejects.toThrow("five digits");
  await expect(t.runAction("start_inclusion", { pin: "12345", qr: QR.s2 })).rejects.toThrow(
    "not both",
  );
  await expect(t.runAction("start_inclusion", { pin: 123456 })).rejects.toThrow("five digits");
  const outcome = t.runAction("start_inclusion", { pin: 12345 });
  await until(() => commandNamed(server, "controller.begin_inclusion") !== undefined);
  server.askPin();
  await until(() => commandNamed(server, "controller.validate_dsk_and_enter_pin") !== undefined);
  expect(commandNamed(server, "controller.validate_dsk_and_enter_pin")).toMatchObject({
    pin: "12345",
  });
  server.nodeAdded(15, 1);
  await outcome;
});

test("provision_qr provisions a SmartStart code and lists it; an S2 code is refused", async () => {
  const { server, t } = await setup();
  expect(await t.runAction("provision_qr", { qr: QR.smartStartLongRange })).toEqual({
    dsk: QR_DSK,
    securityClasses: ["S2 Unauthenticated", "S2 Authenticated", "S2 Access Control"],
    longRange: true,
  });
  expect(server.commands.map((c) => c.command)).toEqual([
    "utils.parse_qr_code_string",
    "controller.provision_smart_start_node",
  ]);
  expect(commandNamed(server, "controller.provision_smart_start_node")).toMatchObject({
    entry: { version: 1, dsk: QR_DSK, supportedProtocols: [0, 1] },
  });
  expect(await t.runAction("provision_qr", { qr: QR.smartStart })).toMatchObject({
    longRange: false,
  });

  await expect(t.runAction("provision_qr", { qr: QR.s2 })).rejects.toThrow(
    "This is an S2 QR code, not SmartStart",
  );
  await expect(t.runAction("provision_qr", { qr: "garbage" })).rejects.toThrow("Invalid QR code");
  expect(
    server.commands.filter((c) => c.command === "controller.provision_smart_start_node"),
  ).toHaveLength(2);

  const listed = (await t.runAction("list_provisioned", {})) as {
    entries: Record<string, unknown>[];
  };
  expect(listed.entries).toHaveLength(2);
  expect(listed.entries[0]).toMatchObject({
    dsk: QR_DSK,
    securityClasses: ["S2 Unauthenticated", "S2 Authenticated", "S2 Access Control"],
    status: "active",
  });

  expect(await t.runAction("unprovision", { dsk: QR_DSK })).toEqual({});
  expect(commandNamed(server, "controller.unprovision_smart_start_node")).toEqual({
    command: "controller.unprovision_smart_start_node",
    dskOrNodeId: QR_DSK,
  });
  expect(server.provisioned).toHaveLength(1);
  await expect(t.runAction("unprovision", {})).rejects.toThrow("Give a dsk or a nodeId");
  await expect(t.runAction("unprovision", { dsk: QR_DSK, nodeId: 3 })).rejects.toThrow("not both");
});

test("unprovision takes a node id in place of a DSK", async () => {
  const { server, t } = await setup();
  expect(await t.runAction("unprovision", { nodeId: 11 })).toEqual({});
  expect(commandNamed(server, "controller.unprovision_smart_start_node")).toEqual({
    command: "controller.unprovision_smart_start_node",
    dskOrNodeId: 11,
  });
});

test("remove_failed_node removes the node, and its device and entities go with it", async () => {
  const { server, t } = await setup();
  const deviceId = t.entity(id("8-0-37-currentValue")).deviceId;
  expect(deviceId).toBeDefined();
  expect(await t.runAction("remove_failed_node", { nodeId: 8 })).toEqual({});
  expect(server.commands).toEqual([{ command: "controller.remove_failed_node", nodeId: 8 }]);
  await until(() => t.entities.size === 17);
  expect([...t.entities.values()].some((e) => e.uniqueId === id("8-0-37-currentValue"))).toBe(
    false,
  );
  expect(t.devices.has(deviceId ?? ("" as never))).toBe(false);
});

test("configuration parameters are read and written raw, with a format when a size is given", async () => {
  const { server, t } = await setup();
  expect(await t.runAction("get_config_parameter", { nodeId: 3, parameter: 9 })).toEqual({
    value: 3,
  });
  expect(
    await t.runAction("set_config_parameter", { nodeId: 3, parameter: 9, value: 20, valueSize: 1 }),
  ).toEqual({ result: { status: 255 } });
  await t.runAction("set_config_parameter", {
    nodeId: 3,
    parameter: 10,
    value: -5,
    valueSize: 2,
    signed: true,
  });
  await t.runAction("set_config_parameter", { nodeId: 3, parameter: 11, value: 1, bitMask: 0x0f });
  await expect(
    t.runAction("set_config_parameter", { nodeId: 3, parameter: 9, value: 1, valueSize: 3 }),
  ).rejects.toThrow("valueSize is 1, 2 or 4");
  await expect(
    t.runAction("set_config_parameter", { nodeId: 3, parameter: 9, value: 1, signed: true }),
  ).rejects.toThrow("signed needs a valueSize");
  expect(server.commands).toEqual([
    { command: "node.get_raw_config_parameter_value", nodeId: 3, parameter: 9 },
    {
      command: "node.set_raw_config_parameter_value",
      nodeId: 3,
      parameter: 9,
      value: 20,
      valueSize: 1,
      valueFormat: 1,
    },
    {
      command: "node.set_raw_config_parameter_value",
      nodeId: 3,
      parameter: 10,
      value: -5,
      valueSize: 2,
      valueFormat: 0,
    },
    {
      command: "node.set_raw_config_parameter_value",
      nodeId: 3,
      parameter: 11,
      value: 1,
      bitMask: 15,
    },
  ]);
});

test("cleans up on abort: closes the socket and stops reconnecting", async () => {
  const { server, t } = await setup();
  expect(server.connections).toBe(1);
  t.abort();
  await until(() => server.connections === 0, "disconnect");
  await Bun.sleep(100);
  expect(server.connections).toBe(0);
});

describe("device settings and LED effects", () => {
  const configured = async () => {
    const { server, t } = await setup({ fixture: CONFIG_FIXTURE_URL });
    const kitchen = [...t.devices.values()].find((d) => d.name === "Kitchen dimmer");
    if (!kitchen || !t.settings) throw new Error("no device settings");
    // Each node with parameters announces them once it is tracked.
    await until(() => t.settingsChanges.length === 3, "the first settings_changed");
    expect(new Set(t.settingsChanges)).toEqual(new Set(t.devices.keys()));
    t.settingsChanges.length = 0;
    return { server, t, settings: t.settings, kitchen: kitchen.id };
  };

  test("lists a node's parameters as its device's settings, and sets one through set_value", async () => {
    const { server, t, settings, kitchen } = await configured();
    const listed = await settings.list(kitchen);
    expect(listed).toHaveLength(17);
    expect(listed.find((s) => s.key === "52")).toMatchObject({ type: "boolean", value: false });

    await settings.set(kitchen, "52", true);
    expect(server.commands.at(-1)).toEqual({
      command: "node.set_value",
      nodeId: 11,
      valueId: { commandClass: 112, endpoint: 0, property: 52 },
      value: 1,
    });
    // The driver reports the parameter back; the setting follows, and one event says so.
    await until(() => t.settingsChanges.length > 0, "settings_changed");
    expect(t.settingsChanges).toEqual([kitchen]);
    expect((await settings.list(kitchen)).find((s) => s.key === "52")?.value).toBe(true);
    await expect(settings.set(kitchen, "999", 1)).rejects.toThrow("has no parameter 999");
  });

  test("led_notify writes the whole parameter once, by device id, and the parts follow", async () => {
    const { server, t, settings, kitchen } = await configured();
    const result = await t.runAction("led_notify", {
      deviceId: kitchen,
      effect: "pulse",
      color: 0,
      duration: "indefinitely",
    });
    expect(result).toEqual({
      target: "99",
      name: "All LED Strip",
      parameter: 99,
      value: 67134719,
      fields: { effect: 4, color: 0, level: 100, duration: 255 },
    });
    const raw = () => server.commands.filter((c) => String(c.command).includes("raw_config"));
    await until(() => raw().length === 2, "the read-back");
    expect(raw()).toEqual([
      {
        command: "node.set_raw_config_parameter_value",
        nodeId: 11,
        parameter: 99,
        value: 67134719,
        valueSize: 4,
        valueFormat: 1,
      },
      { command: "node.get_raw_config_parameter_value", nodeId: 11, parameter: 99 },
    ]);
    await until(() => t.settingsChanges.length > 0, "settings_changed");
    const effect = (await settings.list(kitchen)).filter((s) => s.group === "All LED Strip Effect");
    expect(effect.map((s) => s.value)).toEqual([255, 100, 0, 4]);
  });

  test("led_effects lists what each device's driver describes, and led_notify needs a target when it can't tell", async () => {
    const { t } = await configured();
    const effects = (await t.runAction("led_effects", { nodeId: 13 })) as { target: string }[];
    expect(effects.map((e) => e.target)).toEqual(["24", "25"]);
    await expect(t.runAction("led_notify", { nodeId: 13, effect: "solid" })).rejects.toThrow(
      "Say which LEDs with target: 24 (Light LED), 25 (Fan LED)",
    );
    expect(
      await t.runAction("led_notify", { nodeId: 13, target: "fan led", effect: "solid" }),
    ).toMatchObject({
      target: "25",
    });
    expect(() => t.runAction("led_notify", { effect: "solid" })).toThrow();
    await expect(t.runAction("led_notify", { nodeId: 99, effect: 1 })).rejects.toThrow(
      "No ready Z-Wave node 99",
    );
  });

  test("a value the device refuses is an error, and nothing changes", async () => {
    const { t, settings, kitchen } = await configured();
    await expect(settings.set(kitchen, "97", 77)).rejects.toThrow(
      "Default All LED Strip Brightness When On wasn't changed: the device refused the value",
    );
    expect((await settings.list(kitchen)).find((s) => s.key === "97")?.value).toBe(33);
    expect(t.settingsChanges).toEqual([]);
  });

  test("a parameter reported after the interview is listed; one removed is not", async () => {
    const { server, t, settings, kitchen } = await configured();
    server.valueUpdated(11, { commandClass: 112, property: 158 }, 1);
    await until(() => t.settingsChanges.length > 0, "settings_changed");
    expect((await settings.list(kitchen)).find((s) => s.key === "158")).toMatchObject({
      label: "Parameter 158",
      value: 1,
    });
    t.settingsChanges.length = 0;
    server.emit({
      source: "node",
      event: "value removed",
      nodeId: 11,
      args: { commandClass: 112, endpoint: 0, property: 12 },
    });
    await until(() => t.settingsChanges.length > 0, "settings_changed");
    const keys = (await settings.list(kitchen)).map((s) => s.key);
    expect(keys).not.toContain("12");
    expect(keys).toContain("158");
  });

  test("a parameter the device describes later is added from its metadata", async () => {
    const { server, t, settings, kitchen } = await configured();
    server.emit({
      source: "node",
      event: "metadata updated",
      nodeId: 11,
      args: {
        commandClass: 112,
        endpoint: 0,
        property: 158,
        metadata: { type: "number", label: "Switch Mode", min: 0, max: 1, writeable: true },
      },
    });
    await until(() => t.settingsChanges.length > 0, "settings_changed");
    expect((await settings.list(kitchen)).find((s) => s.key === "158")).toMatchObject({
      label: "Switch Mode",
      value: null,
    });
  });
});
