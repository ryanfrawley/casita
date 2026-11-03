import { expect, test } from "bun:test";
import { createTestContext } from "@casita/integration-testing";
import { FakeBroker } from "@casita/mqtt-shared/testing";
import { createZigbee2MqttIntegration } from "../src/index.ts";

const FIXTURE = new URL(
  "../../../tests/fixtures/zigbee2mqtt/bridge-devices.synthetic.json",
  import.meta.url,
);
const BULB = "0x0017880100000001";
const PLUG = "0x00158d0000000002";

async function setup(baseTopic = "zigbee2mqtt") {
  const broker = new FakeBroker();
  const devices = (await Bun.file(FIXTURE).json()) as Record<string, unknown>[];
  broker.publish(`${baseTopic}/bridge/state`, { state: "online" });
  broker.publish(`${baseTopic}/bridge/devices`, devices);
  const integration = createZigbee2MqttIntegration(broker.connect);
  const t = createTestContext(
    integration.configSchema.parse({ brokerUrl: "mqtt://broker:1883", baseTopic }),
  );
  await integration.setup(t.ctx);
  const sets = () =>
    broker.published
      .filter((p) => p.topic.endsWith("/set"))
      .map((p) => [p.topic, JSON.parse(p.payload)]);
  return { broker, t, devices, sets };
}

test("discovers devices and entities from the bridge's device list", async () => {
  const { t } = await setup();
  expect([...t.devices.values()].map((d) => [d.name, d.manufacturer, d.model])).toEqual([
    ["Hall bulb", "Philips", "9290012573A"],
    ["Coffee plug", "Aqara", "ZNCZ04LM"],
    ["Hall motion", "Aqara", "RTCGQ11LM"],
    ["Back door", "Aqara", "MCCGQ11LM"],
    ["Bedroom radiator", "SONOFF", "TRVZB"],
    ["Office blind", "IKEA", "E1757"],
    ["Front door lock", "Yale", "YRD426NRSC"],
    ["Kitchen switch", "TuYa", "TS0012"],
  ]);
  expect<string[]>([...t.entities.values()].map((e) => e.id)).toEqual([
    "light.hall_bulb",
    "switch.coffee_plug",
    "sensor.coffee_plug_power",
    "sensor.coffee_plug_energy",
    "binary_sensor.hall_motion_occupancy",
    "sensor.hall_motion_illuminance",
    "sensor.hall_motion_battery",
    "binary_sensor.back_door_contact",
    "climate.bedroom_radiator",
    "cover.office_blind",
    "lock.front_door_lock",
    "switch.kitchen_switch_left",
    "switch.kitchen_switch_right",
  ]);
  expect(t.entity(`${BULB}_light`)).toMatchObject({
    uniqueId: `${BULB}_light`,
    capabilities: {
      brightness: true,
      colorTemp: { minK: 2000, maxK: 6536 },
      rgb: true,
      transition: true,
    },
  });
  expect(t.entity("0x0c4314fffe000005_climate").capabilities).toEqual({
    tempRange: { min: 4, max: 35, step: 0.5 },
  });
  expect(t.entity("0x804b50fffe000006_cover").capabilities).toEqual({ position: true });
  expect(t.devices.get(t.entity(`${BULB}_light`).deviceId ?? ("" as never))?.firmware).toBe(
    "1.50.2",
  );
});

test("asks each device for its current state instead of waiting", async () => {
  const { broker } = await setup();
  const gets = broker.published
    .filter((p) => p.topic.endsWith("/get"))
    .map((p) => [p.topic, JSON.parse(p.payload)]);
  expect(gets).toContainEqual([
    "zigbee2mqtt/Hall bulb/get",
    { state: "", brightness: "", color_temp: "" },
  ]);
  expect(gets).toContainEqual(["zigbee2mqtt/Coffee plug/get", { state: "", power: "" }]);
  expect(gets.map((g) => g[0])).not.toContain("zigbee2mqtt/Hall motion/get"); // nothing gettable
});

test("reports state from device payloads, scaling units, with link quality as an attribute", async () => {
  const { broker, t } = await setup();
  broker.publish("zigbee2mqtt/Hall bulb", {
    state: "ON",
    brightness: 127,
    color_temp: 250,
    linkquality: 92,
  });
  expect(t.state(`${BULB}_light`)).toEqual({
    state: { domain: "light", on: true, brightness: 0.5, colorTempK: 4000 },
    attributes: { linkquality: 92 },
    available: true,
  });

  broker.publish("zigbee2mqtt/Coffee plug", {
    state: "OFF",
    power: 0,
    energy: 12.5,
    power_outage_memory: true,
  });
  expect(t.state(`${PLUG}_switch`)?.state).toEqual({ domain: "switch", on: false });
  expect(t.state(`${PLUG}_power`)?.state).toEqual({
    domain: "sensor",
    value: 0,
    unit: "W",
    deviceClass: "power",
  });
  expect(t.state(`${PLUG}_energy`)?.state).toEqual({
    domain: "sensor",
    value: 12.5,
    unit: "kWh",
    deviceClass: "energy",
  });

  broker.publish("zigbee2mqtt/Hall motion", { occupancy: true, illuminance: 40, battery: 87 });
  expect(t.state("0x00158d0000000003_occupancy")?.state).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "occupancy",
  });
  expect(t.state("0x00158d0000000003_battery")?.state).toMatchObject({
    value: 87,
    unit: "%",
    deviceClass: "battery",
  });

  // contact: true means closed, so the door sensor is off.
  broker.publish("zigbee2mqtt/Back door", { contact: true });
  expect(t.state("0x00158d0000000004_contact")?.state).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "door",
  });
  broker.publish("zigbee2mqtt/Back door", { contact: false });
  expect(t.state("0x00158d0000000004_contact")?.state).toMatchObject({ on: true });

  broker.publish("zigbee2mqtt/Bedroom radiator", {
    occupied_heating_setpoint: 21,
    local_temperature: 19.5,
    system_mode: "auto",
  });
  expect(t.state("0x0c4314fffe000005_climate")?.state).toEqual({
    domain: "climate",
    mode: "auto",
    currentTemp: 19.5,
    targetTemp: 21,
  });

  broker.publish("zigbee2mqtt/Office blind", { position: 40, state: "OPEN" });
  expect(t.state("0x804b50fffe000006_cover")?.state).toEqual({
    domain: "cover",
    motion: "stopped",
    position: 0.4,
  });

  broker.publish("zigbee2mqtt/Front door lock", { state: "LOCK", lock_state: "locked" });
  expect(t.state("0x000d6f0000000007_lock")?.state).toEqual({ domain: "lock", locked: true });
  broker.publish("zigbee2mqtt/Front door lock", { state: "LOCK", lock_state: "not_fully_locked" });
  expect(t.state("0x000d6f0000000007_lock")?.state).toEqual({
    domain: "lock",
    locked: true,
    jammed: true,
  });

  broker.publish("zigbee2mqtt/Kitchen switch", { state_left: "ON", state_right: "OFF" });
  expect(t.state("0xa4c1380000000008_switch_left")?.state).toEqual({ domain: "switch", on: true });
  expect(t.state("0xa4c1380000000008_switch_right")?.state).toEqual({
    domain: "switch",
    on: false,
  });
});

test("a payload that says nothing about an entity is not a report for it", async () => {
  const { broker, t } = await setup();
  broker.publish("zigbee2mqtt/Coffee plug", { power: 3 });
  expect<string[]>(t.reports.map((r) => r.entityId)).toEqual(["sensor.coffee_plug_power"]);
  broker.publish("zigbee2mqtt/Coffee plug", "not json");
  broker.publish("zigbee2mqtt/Coffee plug", [1, 2]);
  expect(t.reports).toHaveLength(1);
});

test("delivers commands as JSON to the device's set topic", async () => {
  const { t, sets } = await setup();
  await t.command(`${BULB}_light`, {
    domain: "light",
    action: "turn_on",
    brightness: 0.5,
    colorTempK: 2700,
    transitionMs: 1500,
  });
  await t.command(`${BULB}_light`, { domain: "light", action: "turn_on", rgb: [255, 0, 10] });
  await t.command(`${BULB}_light`, { domain: "light", action: "turn_off" });
  await t.command(`${PLUG}_switch`, { domain: "switch", action: "turn_on" });
  await t.command("0xa4c1380000000008_switch_right", { domain: "switch", action: "turn_off" });
  await t.command("0x0c4314fffe000005_climate", {
    domain: "climate",
    action: "set_target",
    temp: 22.5,
  });
  await t.command("0x0c4314fffe000005_climate", {
    domain: "climate",
    action: "set_mode",
    mode: "off",
  });
  await t.command("0x804b50fffe000006_cover", { domain: "cover", action: "open" });
  await t.command("0x804b50fffe000006_cover", { domain: "cover", action: "stop" });
  await t.command("0x804b50fffe000006_cover", {
    domain: "cover",
    action: "set_position",
    position: 0.25,
  });
  await t.command("0x000d6f0000000007_lock", { domain: "lock", action: "unlock" });
  expect(sets()).toEqual([
    [
      "zigbee2mqtt/Hall bulb/set",
      { state: "ON", brightness: 127, color_temp: 370, transition: 1.5 },
    ],
    ["zigbee2mqtt/Hall bulb/set", { state: "ON", color: { r: 255, g: 0, b: 10 } }],
    ["zigbee2mqtt/Hall bulb/set", { state: "OFF" }],
    ["zigbee2mqtt/Coffee plug/set", { state: "ON" }],
    ["zigbee2mqtt/Kitchen switch/set", { state_right: "OFF" }],
    ["zigbee2mqtt/Bedroom radiator/set", { occupied_heating_setpoint: 22.5 }],
    ["zigbee2mqtt/Bedroom radiator/set", { system_mode: "off" }],
    ["zigbee2mqtt/Office blind/set", { state: "OPEN" }],
    ["zigbee2mqtt/Office blind/set", { state: "STOP" }],
    ["zigbee2mqtt/Office blind/set", { position: 25 }],
    ["zigbee2mqtt/Front door lock/set", { state: "UNLOCK" }],
  ]);
  expect(t.reports).toEqual([]); // state comes only from the device
  await expect(t.command(`${PLUG}_power`, { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "read-only",
  );
});

test("marks entities unavailable when the broker drops, the bridge goes offline, or a device does", async () => {
  const { broker, t } = await setup();
  const report = () => {
    broker.publish("zigbee2mqtt/Hall bulb", { state: "ON" }, false);
    broker.publish("zigbee2mqtt/Coffee plug", { state: "ON" }, false);
  };
  const availability = () => [
    t.state(`${BULB}_light`)?.available,
    t.state(`${PLUG}_switch`)?.available,
  ];
  report();
  expect(availability()).toEqual([true, true]);

  broker.drop();
  expect(availability()).toEqual([false, false]);
  broker.restore();
  report();
  expect(availability()).toEqual([true, true]);

  broker.publish("zigbee2mqtt/bridge/state", { state: "offline" });
  expect(availability()).toEqual([false, false]);
  report();

  broker.publish("zigbee2mqtt/Hall bulb/availability", { state: "offline" });
  expect(availability()).toEqual([false, true]);
  broker.publish("zigbee2mqtt/Hall bulb/availability", "online"); // the older plain-text form
  expect(availability()).toEqual([true, true]);
});

test("a rename in zigbee2mqtt keeps the entity and follows the new topic", async () => {
  const { broker, t, devices, sets } = await setup();
  const id = t.entity(`${BULB}_light`).id;
  const renamed = devices.map((d) =>
    d.ieee_address === BULB ? { ...d, friendly_name: "Landing bulb" } : d,
  );
  broker.publish("zigbee2mqtt/bridge/devices", renamed);

  expect(t.entity(`${BULB}_light`)).toMatchObject({ id, name: "Landing bulb" });
  expect(t.entities.size).toBe(13);
  broker.publish("zigbee2mqtt/Hall bulb", { state: "ON" }, false);
  expect(t.state(`${BULB}_light`)).toBeUndefined();
  broker.publish("zigbee2mqtt/Landing bulb", { state: "ON" }, false);
  expect(t.state(`${BULB}_light`)?.state).toMatchObject({ on: true });
  await t.command(`${BULB}_light`, { domain: "light", action: "turn_off" });
  expect(sets().at(-1)?.[0]).toBe("zigbee2mqtt/Landing bulb/set");
});

test("a device removed from the bridge is removed here; malformed lists are ignored", async () => {
  const { broker, t, devices } = await setup();
  broker.publish("zigbee2mqtt/bridge/devices", "garbage");
  broker.publish("zigbee2mqtt/bridge/devices", { not: "a list" });
  expect(t.entities.size).toBe(13);

  broker.publish("zigbee2mqtt/bridge/devices", [
    ...devices.filter((d) => d.ieee_address !== PLUG),
    { friendly_name: "no address" },
  ]);
  expect([...t.entities.keys()].filter((id) => id.includes("coffee_plug"))).toEqual([]);
  expect(t.entities.size).toBe(10);
  expect([...t.devices.values()].some((d) => d.uniqueId === PLUG)).toBe(false);
});

test("permit_join publishes the bridge request", async () => {
  const { broker, t } = await setup();
  expect(await t.runAction("permit_join", { seconds: 60 })).toEqual({
    permitJoin: true,
    seconds: 60,
  });
  expect(await t.runAction("permit_join", { seconds: 0 })).toEqual({
    permitJoin: false,
    seconds: 0,
  });
  expect(broker.published.slice(-2)).toEqual([
    { topic: "zigbee2mqtt/bridge/request/permit_join", payload: '{"value":true,"time":60}' },
    { topic: "zigbee2mqtt/bridge/request/permit_join", payload: '{"value":false,"time":0}' },
  ]);
  await expect(t.runAction("permit_join", { seconds: 999 })).rejects.toThrow();
});

test("cleans up on abort, and honors a custom base topic", async () => {
  const { broker, t } = await setup("z2m/home");
  expect(t.entities.size).toBe(13);
  broker.publish("z2m/home/Hall bulb", { state: "ON" }, false);
  expect(t.reports).toHaveLength(1);
  t.abort();
  expect(broker.subscriptionCount).toBe(0);
  broker.publish("z2m/home/Hall bulb", { state: "OFF" }, false);
  expect(t.reports).toHaveLength(1);
});
