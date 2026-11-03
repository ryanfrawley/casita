import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import { FakeBroker } from "@casita/mqtt-shared/testing";
import { createTeslaMateIntegration } from "../src/index.ts";

const FIXTURE = new URL("../../../tests/fixtures/teslamate/car.synthetic.json", import.meta.url);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(load = true, config: Record<string, unknown> = {}) {
  const broker = new FakeBroker();
  if (load) await broker.load(FIXTURE);
  const integration = createTeslaMateIntegration({ connect: broker.connect, nameGraceMs: 20 });
  const t = createTestContext(
    integration.configSchema.parse({ brokerUrl: "mqtt://broker:1883", ...config }),
  );
  cleanups.push(() => t.abort());
  await integration.setup(t.ctx);
  return { broker, t };
}
const value = (t: TestContext<unknown>, topic: string) => t.state(`teslamate-1-${topic}`)?.state;

test("discovers the car from TeslaMate's retained topics, named after the car", async () => {
  const { t } = await setup();
  expect([...t.devices.values()]).toMatchObject([
    {
      uniqueId: "teslamate-1",
      name: "Nightshade",
      manufacturer: "Tesla",
      model: "Model 3 74D",
      firmware: "2026.32.4",
    },
  ]);
  expect<string[]>([...t.entities.values()].map((e) => e.id).sort()).toEqual([
    "binary_sensor.nightshade_climate",
    "binary_sensor.nightshade_doors",
    "binary_sensor.nightshade_plugged_in",
    "binary_sensor.nightshade_sentry_mode",
    "lock.nightshade_lock",
    "sensor.nightshade_battery",
    "sensor.nightshade_charge_limit",
    "sensor.nightshade_charger_power",
    "sensor.nightshade_inside_temperature",
    "sensor.nightshade_location",
    "sensor.nightshade_odometer",
    "sensor.nightshade_outside_temperature",
    "sensor.nightshade_range",
    "sensor.nightshade_state",
  ]);
});

test("reports each value with its unit and class; location carries coordinates", async () => {
  const { t } = await setup();
  expect(value(t, "battery_level")).toEqual({
    domain: "sensor",
    value: 72,
    unit: "%",
    deviceClass: "battery",
  });
  expect(value(t, "rated_battery_range_km")).toEqual({
    domain: "sensor",
    value: 351.5,
    unit: "km",
    deviceClass: undefined,
  });
  expect(value(t, "inside_temp")).toMatchObject({
    value: 21.5,
    unit: "°C",
    deviceClass: "temperature",
  });
  expect(value(t, "state")).toEqual({ domain: "sensor", value: "online" });
  expect(value(t, "plugged_in")).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: undefined,
  });
  expect(value(t, "doors_open")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "door",
  });
  expect(value(t, "locked")).toEqual({ domain: "lock", locked: true });
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { domain: "sensor", value: "Home" },
    attributes: { latitude: 47.6205, longitude: -122.3493 },
  });
});

test("live updates become reports; new topics become new entities; junk is ignored", async () => {
  const { broker, t } = await setup();
  broker.publish("teslamate/cars/1/battery_level", "71");
  broker.publish("teslamate/cars/1/state", "driving");
  broker.publish("teslamate/cars/1/speed", "88");
  broker.publish("teslamate/cars/1/latitude", "47.7");
  expect(value(t, "battery_level")).toMatchObject({ value: 71 });
  expect(value(t, "state")).toMatchObject({ value: "driving" });
  expect(value(t, "speed")).toEqual({
    domain: "sensor",
    value: 88,
    unit: "km/h",
    deviceClass: undefined,
  });
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
  });

  const reports = t.reports.length;
  const entities = t.entities.size;
  broker.publish("teslamate/cars/1/battery_level", "7 2");
  broker.publish("teslamate/cars/1/locked", "maybe");
  broker.publish("teslamate/cars/1/exterior_color", "PearlWhite"); // not mapped
  broker.publish("teslamate/cars/1/constructor", "x");
  expect(t.reports).toHaveLength(reports);
  expect(t.entities.size).toBe(entities);
});

test("everything is read-only", async () => {
  const { t } = await setup();
  await expect(
    t.command("teslamate-1-locked", { domain: "lock", action: "unlock" }),
  ).rejects.toThrow("read-only");
});

test("a car whose name has not arrived is held briefly, then registered under a fallback", async () => {
  const { broker, t } = await setup(false);
  broker.publish("teslamate/cars/2/battery_level", "50");
  expect(t.entities.size).toBe(0);
  await Bun.sleep(40);
  expect<string[]>([...t.entities.keys()]).toEqual(["sensor.tesla_2_battery"]);

  // A name that arrives in time is used for the ids.
  broker.publish("teslamate/cars/3/battery_level", "60");
  broker.publish("teslamate/cars/3/display_name", "Blue");
  expect<string[]>([...t.entities.keys()]).toContain("sensor.blue_battery");
});

test("marks entities unavailable on disconnect and recovers from the retained values", async () => {
  const { broker, t } = await setup();
  broker.drop();
  expect([...t.states.values()].every((s) => !s.available)).toBe(true);
  broker.restore();
  expect([...t.states.values()].every((s) => s.available)).toBe(true);
});

test("honors a namespaced base topic, and cleans up on abort", async () => {
  const { broker, t } = await setup(false, { baseTopic: "teslamate/home" });
  broker.publish("teslamate/cars/1/battery_level", "50");
  broker.publish("teslamate/home/cars/1/display_name", "Nightshade");
  broker.publish("teslamate/home/cars/1/battery_level", "64");
  expect(value(t, "battery_level")).toMatchObject({ value: 64 });
  t.abort();
  expect(broker.subscriptionCount).toBe(0);
});

// ───────── a car named straight away, so every topic registers immediately ─────────

async function named(name = "Blue", car = "1") {
  const { broker, t } = await setup(false);
  broker.publish(`teslamate/cars/${car}/display_name`, name);
  return {
    broker,
    t,
    send: (topic: string, payload: string) =>
      broker.publish(`teslamate/cars/${car}/${topic}`, payload),
  };
}
const registered = (t: TestContext<unknown>, uniqueId: string) =>
  [...t.entities.values()].some((e) => e.uniqueId === uniqueId);

test.each([
  ["state", "online", "sensor.blue_state", { domain: "sensor", value: "online" }],
  ["battery_level", "72", "sensor.blue_battery", { value: 72, unit: "%", deviceClass: "battery" }],
  [
    "usable_battery_level",
    "70",
    "sensor.blue_usable_battery",
    { value: 70, unit: "%", deviceClass: "battery" },
  ],
  [
    "rated_battery_range_km",
    "351.5",
    "sensor.blue_range",
    { value: 351.5, unit: "km", deviceClass: undefined },
  ],
  [
    "est_battery_range_km",
    "300",
    "sensor.blue_estimated_range",
    { value: 300, unit: "km", deviceClass: undefined },
  ],
  [
    "charge_limit_soc",
    "80",
    "sensor.blue_charge_limit",
    { value: 80, unit: "%", deviceClass: undefined },
  ],
  [
    "charger_power",
    "11",
    "sensor.blue_charger_power",
    { value: 11, unit: "kW", deviceClass: "power" },
  ],
  [
    "charge_energy_added",
    "4.25",
    "sensor.blue_charge_energy_added",
    { value: 4.25, unit: "kWh", deviceClass: "energy" },
  ],
  [
    "time_to_full_charge",
    "1.5",
    "sensor.blue_time_to_full_charge",
    { value: 1.5, unit: "h", deviceClass: undefined },
  ],
  [
    "inside_temp",
    "21.5",
    "sensor.blue_inside_temperature",
    { value: 21.5, unit: "°C", deviceClass: "temperature" },
  ],
  [
    "outside_temp",
    "-3.5",
    "sensor.blue_outside_temperature",
    { value: -3.5, unit: "°C", deviceClass: "temperature" },
  ],
  [
    "odometer",
    "48621.33",
    "sensor.blue_odometer",
    { value: 48621.33, unit: "km", deviceClass: undefined },
  ],
  ["speed", "0", "sensor.blue_speed", { value: 0, unit: "km/h", deviceClass: undefined }],
  ["power", "-12", "sensor.blue_power", { value: -12, unit: "kW", deviceClass: "power" }],
  ["geofence", "Work", "sensor.blue_location", { domain: "sensor", value: "Work" }],
  ["plugged_in", "true", "binary_sensor.blue_plugged_in", { on: true, deviceClass: undefined }],
  ["is_climate_on", "false", "binary_sensor.blue_climate", { on: false, deviceClass: undefined }],
  ["sentry_mode", "true", "binary_sensor.blue_sentry_mode", { on: true, deviceClass: undefined }],
  ["doors_open", "true", "binary_sensor.blue_doors", { on: true, deviceClass: "door" }],
  ["windows_open", "false", "binary_sensor.blue_windows", { on: false, deviceClass: "window" }],
  ["trunk_open", "true", "binary_sensor.blue_trunk", { on: true, deviceClass: "door" }],
  ["frunk_open", "false", "binary_sensor.blue_frunk", { on: false, deviceClass: "door" }],
  [
    "is_user_present",
    "true",
    "binary_sensor.blue_occupied",
    { on: true, deviceClass: "occupancy" },
  ],
  [
    "update_available",
    "false",
    "binary_sensor.blue_update_available",
    { on: false, deviceClass: undefined },
  ],
  ["locked", "false", "lock.blue_lock", { domain: "lock", locked: false }],
] as const)("topic %p with %p becomes %p", async (topic, payload, entityId, expected) => {
  const { t, send } = await named();
  send(topic, payload);
  const entity = t.entity(`teslamate-1-${topic}`);
  expect<string>(entity.id).toBe(entityId);
  expect<string>(entity.domain).toBe(entityId.split(".")[0] ?? "");
  expect(entity.deviceId).toBe([...t.devices.keys()][0]);
  // Exact match: no stray unit or class on the text, binary and lock states.
  expect<unknown>(value(t, topic)).toEqual({ domain: entity.domain, ...expected });
});

test.each(["True", "FALSE", "1", "0", "yes", "", " true"])(
  "a binary payload of %p is ignored",
  async (payload) => {
    const { t, send } = await named();
    send("plugged_in", payload);
    send("locked", payload);
    expect(registered(t, "teslamate-1-plugged_in")).toBe(false);
    expect(registered(t, "teslamate-1-locked")).toBe(false);
  },
);

test.each(["", "   ", "\n"])("a blank numeric payload of %p means no value", async (payload) => {
  const { t, send } = await named();
  send("charger_power", "11");
  send("charger_power", payload);
  expect(value(t, "charger_power")).toEqual({
    domain: "sensor",
    value: null,
    unit: "kW",
    deviceClass: "power",
  });
  send("charger_power", "7");
  expect(value(t, "charger_power")).toMatchObject({ value: 7 });
});

test("a topic that starts out blank is an entity with no value yet", async () => {
  const { t, send } = await named();
  send("time_to_full_charge", "");
  expect(value(t, "time_to_full_charge")).toEqual({
    domain: "sensor",
    value: null,
    unit: "h",
    deviceClass: undefined,
  });
});

test.each(["NaN", "Infinity", "-Infinity", "72%", "abc", "1,5"])(
  "a numeric payload of %p is ignored",
  async (payload) => {
    const { t, send } = await named();
    send("battery_level", payload);
    expect(registered(t, "teslamate-1-battery_level")).toBe(false);
  },
);

test("numeric payloads tolerate surrounding whitespace and signed zero", async () => {
  const { t, send } = await named();
  send("battery_level", " 72 ");
  expect(value(t, "battery_level")).toMatchObject({ value: 72 });
  send("speed", "-0");
  const speed = value(t, "speed");
  expect(speed?.domain === "sensor" && speed.value === 0).toBe(true);
});

test("an invalid update keeps the last good value instead of reporting junk", async () => {
  const { t, send } = await named();
  send("battery_level", "72");
  const reports = t.reports.length;
  send("battery_level", "NaN");
  expect(t.reports).toHaveLength(reports);
  expect(value(t, "battery_level")).toMatchObject({ value: 72 });
});

test.each(["charging", "asleep", "offline", "driving", "suspended", "updating", "start"])(
  "the state %p is passed through as text",
  async (state) => {
    const { t, send } = await named();
    send("state", state);
    expect(value(t, "state")).toEqual({ domain: "sensor", value: state });
  },
);

test("a very long text payload is reported verbatim", async () => {
  const { t, send } = await named();
  const long = "Ä".repeat(10_000);
  send("geofence", long);
  expect(value(t, "geofence")).toEqual({ domain: "sensor", value: long });
});

test("two cars keep their own devices, entities and values", async () => {
  const { broker, t } = await setup(false);
  broker.publish("teslamate/cars/1/display_name", "Red");
  broker.publish("teslamate/cars/2/display_name", "Blue");
  broker.publish("teslamate/cars/1/battery_level", "10");
  broker.publish("teslamate/cars/2/battery_level", "90");
  broker.publish("teslamate/cars/2/latitude", "1");
  broker.publish("teslamate/cars/2/longitude", "2");
  broker.publish("teslamate/cars/1/geofence", "Home");
  broker.publish("teslamate/cars/2/geofence", "Work");

  expect([...t.devices.values()].map((d) => [d.uniqueId, d.name])).toEqual([
    ["teslamate-1", "Red"],
    ["teslamate-2", "Blue"],
  ]);
  expect(t.state("teslamate-1-battery_level")?.state).toMatchObject({ value: 10 });
  expect(t.state("teslamate-2-battery_level")?.state).toMatchObject({ value: 90 });
  // Car 1 never sent coordinates, so car 2's must not leak into its location.
  expect(t.state("teslamate-1-geofence")?.attributes).toBeUndefined();
  expect(t.state("teslamate-2-geofence")?.attributes).toEqual({ latitude: 1, longitude: 2 });
  expect(t.entity("teslamate-1-battery_level").deviceId).not.toBe(
    t.entity("teslamate-2-battery_level").deviceId,
  );
});

test("two cars with the same name get distinct entity ids", async () => {
  const { broker, t } = await setup(false);
  broker.publish("teslamate/cars/1/display_name", "Twin");
  broker.publish("teslamate/cars/2/display_name", "Twin");
  broker.publish("teslamate/cars/1/battery_level", "10");
  broker.publish("teslamate/cars/2/battery_level", "90");
  expect<string[]>([...t.entities.keys()]).toEqual([
    "sensor.twin_battery",
    "sensor.twin_battery_2",
  ]);
});

test("a renamed car renames its device and keeps its entity ids", async () => {
  const { t, send } = await named("Blue");
  send("battery_level", "50");
  send("display_name", "Midnight");
  expect([...t.devices.values()].map((d) => d.name)).toEqual(["Midnight"]);
  expect<string[]>([...t.entities.keys()]).toEqual(["sensor.blue_battery"]);
});

// Bug: describe() says "entity names follow it", but entities are only registered once, so
// after a rename they keep the old name ("Blue battery") under a device called "Midnight".
test("a renamed car's entity names follow the new name", async () => {
  const { t, send } = await named("Blue");
  send("battery_level", "50");
  send("display_name", "Midnight");
  expect(t.entity("teslamate-1-battery_level").name).toBe("Midnight battery");
});

test("a car registered under the fallback name takes its real name when it arrives", async () => {
  const { broker, t } = await setup(false);
  broker.publish("teslamate/cars/2/battery_level", "50");
  await Bun.sleep(40);
  broker.publish("teslamate/cars/2/display_name", "Late");
  expect([...t.devices.values()].map((d) => d.name)).toEqual(["Late"]);
  // Ids were already handed out and stay stable.
  expect<string[]>([...t.entities.keys()]).toEqual(["sensor.tesla_2_battery"]);
});

test("an empty display name falls back to the car id", async () => {
  const { t, send } = await named("");
  send("battery_level", "50");
  expect([...t.devices.values()].map((d) => d.name)).toEqual(["Tesla 1"]);
  expect<string[]>([...t.entities.keys()]).toEqual(["sensor.tesla_1_battery"]);
});

test("model, trim and firmware that arrive after registration update the device", async () => {
  const { t, send } = await named("Blue");
  send("battery_level", "50");
  expect([...t.devices.values()]).toMatchObject([{ model: undefined, firmware: undefined }]);
  send("model", "Y");
  expect([...t.devices.values()]).toMatchObject([{ model: "Model Y" }]);
  send("trim_badging", "P74D");
  send("version", "2026.40.1");
  expect([...t.devices.values()]).toMatchObject([
    { name: "Blue", model: "Model Y P74D", firmware: "2026.40.1" },
  ]);
  expect(t.devices.size).toBe(1);
});

test("a trim without a model does not invent a model", async () => {
  const { t, send } = await named("Blue");
  send("trim_badging", "74D");
  expect([...t.devices.values()]).toMatchObject([{ model: undefined }]);
});

test("latitude without longitude reports the location without coordinates", async () => {
  const { t, send } = await named();
  send("geofence", "Home");
  send("latitude", "47.6");
  expect(t.state("teslamate-1-geofence")).toMatchObject({ state: { value: "Home" } });
  expect(t.state("teslamate-1-geofence")?.attributes).toBeUndefined();
  send("longitude", "-122.1");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.6,
    longitude: -122.1,
  });
});

test("coordinates alone create a location entity that reads away until a place is named", async () => {
  const { t, send } = await named();
  send("latitude", "47.6");
  expect(registered(t, "teslamate-1-geofence")).toBe(false); // half a position is not one
  send("longitude", "-122.1");
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { domain: "sensor", value: "away" },
    attributes: { latitude: 47.6, longitude: -122.1 },
  });
  send("geofence", "Home");
  expect(t.state("teslamate-1-geofence")?.state).toEqual({ domain: "sensor", value: "Home" });
});

test("the combined location topic supplies the position too", async () => {
  const { t, send } = await named();
  send("location", '{"latitude":47.61,"longitude":-122.2}');
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { value: "away" },
    attributes: { latitude: 47.61, longitude: -122.2 },
  });
  send("location", "not json");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.61,
    longitude: -122.2,
  });
});

// TeslaMate publishes geofence "" once the car is outside every geofence.
test("leaving a geofence clears the place but keeps reporting coordinates", async () => {
  const { t, send } = await named();
  send("latitude", "47.6");
  send("longitude", "-122.1");
  send("geofence", "Home");
  send("geofence", "");
  send("latitude", "48.0");
  const location = t.state("teslamate-1-geofence");
  expect(location?.state).not.toEqual({ domain: "sensor", value: "Home" });
  expect(location?.attributes).toEqual({ latitude: 48, longitude: -122.1 });
});

test("a car outside every geofence still gets a location with coordinates", async () => {
  const { t, send } = await named();
  send("geofence", "");
  send("latitude", "47.6");
  send("longitude", "-122.1");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.6,
    longitude: -122.1,
  });
});

// Same root cause: after a reconnect the retained "" is replayed, reports nothing, and the
// location entity that was marked unavailable on the drop never becomes available again.
test("after a reconnect the location is available even outside every geofence", async () => {
  const { broker, t, send } = await named();
  send("geofence", "Home");
  send("geofence", "");
  broker.drop();
  broker.restore();
  expect(t.state("teslamate-1-geofence")?.available).toBe(true);
});

test("the name grace timer does nothing once the integration is aborted", async () => {
  const { broker, t } = await setup(false);
  broker.publish("teslamate/cars/2/battery_level", "50");
  t.abort();
  await Bun.sleep(40);
  expect(t.entities.size).toBe(0);
  expect(t.devices.size).toBe(0);
});

test("a reconnect replays retained values: same states again, all available", async () => {
  const { broker, t } = await setup();
  const before = new Map([...t.states].map(([id, s]) => [id, s.state]));
  broker.drop();
  const reports = t.reports.length;
  broker.restore();
  expect(t.reports.length).toBeGreaterThan(reports);
  expect(new Map([...t.states].map(([id, s]) => [id, s.state]))).toEqual(before);
  expect([...t.states.values()].every((s) => s.available)).toBe(true);
  expect(t.entities.size).toBe(before.size);
});

test("values published while disconnected arrive on reconnect", async () => {
  const { broker, t } = await setup();
  broker.drop();
  broker.publish("teslamate/cars/1/battery_level", "65");
  expect(value(t, "battery_level")).toMatchObject({ value: 72 });
  broker.restore();
  expect(t.state("teslamate-1-battery_level")).toMatchObject({
    state: { value: 65 },
    available: true,
  });
});

test("a disconnect marks only registered entities unavailable, each once", async () => {
  const { broker, t } = await setup();
  broker.drop();
  expect(t.availability).toHaveLength(t.entities.size);
  expect(t.availability.every((a) => !a.available)).toBe(true);
});

test("topics outside <base>/cars/<id>/<topic>, and TeslaMate's bookkeeping topics, are ignored", async () => {
  const { broker, t } = await setup();
  const entities = t.entities.size;
  const reports = t.reports.length;
  broker.publish("teslamate/cars/1/active_route/destination", "Home");
  broker.publish("teslamate/cars/1/battery_level/x", "10");
  broker.publish("teslamate/cars/1/healthy", "false");
  broker.publish("teslamate/cars/1/since", "2026-10-03T23:00:00Z");
  broker.publish("teslamate/cars//battery_level", "10");
  broker.publish("teslamate/cars/1/", "10");
  broker.publish("teslamate/cars/1", "10");
  broker.publish("teslamate/other/1/battery_level", "10");
  for (const name of ["__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    broker.publish(`teslamate/cars/1/${name}`, "true");
  }
  expect(t.entities.size).toBe(entities);
  expect(t.reports).toHaveLength(reports);
  expect(registered(t, "teslamate-1-healthy")).toBe(false);
  expect(registered(t, "teslamate-1-since")).toBe(false);
  expect(t.devices.size).toBe(1);
});

// ───────── the wider set of topics, "nil", and the heading ─────────

test.each([
  ["charging_state", "Charging", "sensor.blue_charging_state", { value: "Charging" }],
  [
    "ideal_battery_range_km",
    "402.3",
    "sensor.blue_ideal_range",
    { value: 402.3, unit: "km", deviceClass: undefined },
  ],
  [
    "charger_voltage",
    "240",
    "sensor.blue_charger_voltage",
    { value: 240, unit: "V", deviceClass: undefined },
  ],
  [
    "charger_actual_current",
    "31.5",
    "sensor.blue_charger_current",
    { value: 31.5, unit: "A", deviceClass: undefined },
  ],
  [
    "charge_current_request",
    "32",
    "sensor.blue_charge_current_request",
    { value: 32, unit: "A", deviceClass: undefined },
  ],
  [
    "charge_current_request_max",
    "48",
    "sensor.blue_charge_current_limit",
    { value: 48, unit: "A", deviceClass: undefined },
  ],
  ["elevation", "-12", "sensor.blue_elevation", { value: -12, unit: "m", deviceClass: undefined }],
  [
    "tpms_pressure_fl",
    "2.9",
    "sensor.blue_tire_pressure_front_left",
    { value: 2.9, unit: "bar", deviceClass: undefined },
  ],
  [
    "tpms_pressure_fr",
    "2.875",
    "sensor.blue_tire_pressure_front_right",
    { value: 2.875, unit: "bar", deviceClass: undefined },
  ],
  [
    "tpms_pressure_rl",
    "3",
    "sensor.blue_tire_pressure_rear_left",
    { value: 3, unit: "bar", deviceClass: undefined },
  ],
  [
    "tpms_pressure_rr",
    "0",
    "sensor.blue_tire_pressure_rear_right",
    { value: 0, unit: "bar", deviceClass: undefined },
  ],
  ["climate_keeper_mode", "dog", "sensor.blue_climate_keeper", { value: "dog" }],
  ["update_version", "2026.44.1", "sensor.blue_update_version", { value: "2026.44.1" }],
  ["active_route_destination", "Work", "sensor.blue_destination", { value: "Work" }],
  [
    "is_preconditioning",
    "true",
    "binary_sensor.blue_preconditioning",
    { on: true, deviceClass: undefined },
  ],
  [
    "charge_port_door_open",
    "false",
    "binary_sensor.blue_charge_port",
    { on: false, deviceClass: "door" },
  ],
  [
    "driver_front_door_open",
    "true",
    "binary_sensor.blue_driver_door",
    { on: true, deviceClass: "door" },
  ],
  [
    "driver_rear_door_open",
    "false",
    "binary_sensor.blue_driver_rear_door",
    { on: false, deviceClass: "door" },
  ],
  [
    "passenger_front_door_open",
    "true",
    "binary_sensor.blue_passenger_door",
    { on: true, deviceClass: "door" },
  ],
  [
    "passenger_rear_door_open",
    "false",
    "binary_sensor.blue_passenger_rear_door",
    { on: false, deviceClass: "door" },
  ],
  [
    "tpms_soft_warning_fl",
    "true",
    "binary_sensor.blue_tire_warning_front_left",
    { on: true, deviceClass: undefined },
  ],
  [
    "tpms_soft_warning_fr",
    "false",
    "binary_sensor.blue_tire_warning_front_right",
    { on: false, deviceClass: undefined },
  ],
  [
    "tpms_soft_warning_rl",
    "false",
    "binary_sensor.blue_tire_warning_rear_left",
    { on: false, deviceClass: undefined },
  ],
  [
    "tpms_soft_warning_rr",
    "true",
    "binary_sensor.blue_tire_warning_rear_right",
    { on: true, deviceClass: undefined },
  ],
] as const)("the added topic %p with %p becomes %p", async (topic, payload, entityId, expected) => {
  const { t, send } = await named();
  send(topic, payload);
  const entity = t.entity(`teslamate-1-${topic}`);
  expect<string>(entity.id).toBe(entityId);
  expect(entity.deviceId).toBe([...t.devices.keys()][0]);
  expect<unknown>(value(t, topic)).toEqual({ domain: entity.domain, ...expected });
});

test.each([
  "state",
  "charging_state",
  "climate_keeper_mode",
  "update_version",
  "active_route_destination",
])("a text topic %p of nil or blank creates no entity", async (topic) => {
  const { t, send } = await named();
  send(topic, "nil");
  send(topic, "");
  expect(registered(t, `teslamate-1-${topic}`)).toBe(false);
});

test("nil after a destination clears it, so an old destination does not linger", async () => {
  const { t, send } = await named();
  send("active_route_destination", "Work");
  send("active_route_destination", "nil");
  expect(value(t, "active_route_destination")).toEqual({ domain: "sensor", value: null });
  send("active_route_destination", "Home");
  expect(value(t, "active_route_destination")).toEqual({ domain: "sensor", value: "Home" });
});

test("only the exact payload nil is ignored; other spellings are text", async () => {
  const { t, send } = await named();
  for (const payload of ["Nil", "NIL", " nil", "null", "nil "]) {
    send("climate_keeper_mode", payload);
    expect(value(t, "climate_keeper_mode")).toEqual({ domain: "sensor", value: payload });
  }
});

test("nil on a numeric or binary topic is ignored like any junk", async () => {
  const { t, send } = await named();
  send("tpms_pressure_fl", "nil");
  send("charge_port_door_open", "nil");
  expect(registered(t, "teslamate-1-tpms_pressure_fl")).toBe(false);
  expect(registered(t, "teslamate-1-charge_port_door_open")).toBe(false);
});

test.each(["", "  "])(
  "a blank payload %p on an added numeric topic means no value",
  async (payload) => {
    const { t, send } = await named();
    send("charger_voltage", "240");
    send("charger_voltage", payload);
    expect(value(t, "charger_voltage")).toEqual({
      domain: "sensor",
      value: null,
      unit: "V",
      deviceClass: undefined,
    });
    send("tpms_pressure_rr", payload);
    expect(value(t, "tpms_pressure_rr")).toMatchObject({ value: null, unit: "bar" });
  },
);

test("topics that are still not mapped are ignored", async () => {
  const { t, send } = await named();
  for (const topic of ["exterior_color", "spoiler_type", "active_route", "center_display_state"]) {
    send(topic, "x");
  }
  expect(t.entities.size).toBe(0);
});

test("a heading joins the location's coordinates", async () => {
  const { t, send } = await named();
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  send("heading", "271");
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { domain: "sensor", value: "away" },
    attributes: { latitude: 47.7, longitude: -122.3493, heading: 271 },
  });
});

test("a heading update re-reports the location with the new heading", async () => {
  const { t, send } = await named();
  send("geofence", "Home");
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  send("heading", "90");
  const reports = t.reports.length;
  send("heading", "180");
  expect(t.reports.length).toBe(reports + 1);
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { value: "Home" },
    attributes: { latitude: 47.7, longitude: -122.3493, heading: 180 },
  });
});

test("a heading of 0 is kept, not mistaken for no heading", async () => {
  const { t, send } = await named();
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  send("heading", "0");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
    heading: 0,
  });
});

test("without a heading the attributes are only the coordinates", async () => {
  const { t, send } = await named();
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
  });
});

test.each(["", "  ", "north", "NaN", "Infinity", "90°"])(
  "a heading of %p is left out of the attributes",
  async (payload) => {
    const { t, send } = await named();
    send("latitude", "47.7");
    send("longitude", "-122.3493");
    send("heading", "90");
    send("heading", payload);
    expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
      latitude: 47.7,
      longitude: -122.3493,
    });
  },
);

test("a heading with no position yet creates no location", async () => {
  const { t, send } = await named();
  send("heading", "90");
  expect(registered(t, "teslamate-1-geofence")).toBe(false);
  expect(t.entities.size).toBe(0);
  send("latitude", "47.7");
  expect(registered(t, "teslamate-1-geofence")).toBe(false);
  // The heading that came first is used once the position is whole.
  send("longitude", "-122.3493");
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
    heading: 90,
  });
});

test("a heading with a place but no position re-reports the place without attributes", async () => {
  const { t, send } = await named();
  send("geofence", "Home");
  send("heading", "90");
  expect(t.state("teslamate-1-geofence")).toMatchObject({ state: { value: "Home" } });
  expect(t.state("teslamate-1-geofence")?.attributes).toBeUndefined();
  expect(registered(t, "teslamate-1-heading")).toBe(false);
});

test("the heading is not an entity of its own", async () => {
  const { t, send } = await named();
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  send("heading", "45");
  expect([...t.entities.values()].map((e) => e.uniqueId)).toEqual(["teslamate-1-geofence"]);
});

test.each([
  ["heading first", ["heading", "latitude", "longitude", "geofence", "display_name"]],
  ["heading last", ["display_name", "geofence", "latitude", "longitude", "heading"]],
  ["heading between", ["longitude", "heading", "display_name", "latitude", "geofence"]],
  ["name after the grace", ["heading", "geofence", "latitude", "longitude"]],
])("retained position topics in any order give the same location (%s)", async (_, order) => {
  const { broker, t } = await setup(false);
  const payloads: Record<string, string> = {
    display_name: "Blue",
    geofence: "Home",
    latitude: "47.7",
    longitude: "-122.3493",
    heading: "271",
  };
  for (const topic of order) broker.publish(`teslamate/cars/1/${topic}`, payloads[topic] ?? "");
  await Bun.sleep(40);
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    state: { domain: "sensor", value: "Home" },
    attributes: { latitude: 47.7, longitude: -122.3493, heading: 271 },
  });
  expect(t.entities.size).toBe(1);
});

test("the combined location topic carries no heading, but the heading topic still applies", async () => {
  const { t, send } = await named();
  send("heading", "12");
  send("location", '{"latitude":47.7,"longitude":-122.3493,"heading":99}');
  expect(t.state("teslamate-1-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
    heading: 12,
  });
});

test("one car's heading does not reach another car's location", async () => {
  const { broker, t } = await setup(false);
  for (const car of ["1", "2"]) {
    broker.publish(`teslamate/cars/${car}/display_name`, `Car ${car}`);
    broker.publish(`teslamate/cars/${car}/latitude`, "47.7");
    broker.publish(`teslamate/cars/${car}/longitude`, "-122.3493");
  }
  broker.publish("teslamate/cars/1/heading", "45");
  expect(t.state("teslamate-1-geofence")?.attributes).toMatchObject({ heading: 45 });
  expect(t.state("teslamate-2-geofence")?.attributes).toEqual({
    latitude: 47.7,
    longitude: -122.3493,
  });
});

test("after a reconnect the location still carries its heading", async () => {
  const { broker, t, send } = await named();
  send("geofence", "Home");
  send("latitude", "47.7");
  send("longitude", "-122.3493");
  send("heading", "200");
  broker.drop();
  broker.restore();
  expect(t.state("teslamate-1-geofence")).toMatchObject({
    available: true,
    attributes: { latitude: 47.7, longitude: -122.3493, heading: 200 },
  });
});
