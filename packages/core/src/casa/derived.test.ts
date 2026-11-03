import { expect, test } from "bun:test";
import { createCore } from "../testing.ts";
import type { DeviceId, EntityId, EntityState } from "../types.ts";
import { noopLogger } from "../util.ts";
import { SENSOR_INTEGRATION, SensorRuntime } from "./derived.ts";
import { SensorStore } from "./sensors.ts";

const DOOR = `sensor KitchenDoor {
  input door = binary_sensor.kitchen_door
  input bolt = lock.kitchen
  name: "Kitchen door"
  type: String
  value: door.value == .On ? "Open" : bolt.value == .Unlocked ? "Unlocked" : "Secured"
}
`;

const SECURE = `sensor KitchenSecure {
  input door = binary_sensor.kitchen_door
  input bolt = lock.kitchen
  name: "Kitchen secure"
  type: Bool  class: .Door
  value: door.value == .Off && bolt.value == .Locked
}
`;

const HOUSE_TEMP = `sensor HouseTemp {
  input rooms = [sensor.living, sensor.bedroom]
  name: "House temperature"
  type: Number  unit: "°C"  class: .Temperature
  value: avg(rooms, (s) => s.value)
}
`;

async function setup() {
  const core = await createCore();
  const { db, bus, now, registry, states } = core;
  registry.registerEntity("fixture", {
    uniqueId: "door",
    domain: "binary_sensor",
    name: "Kitchen door",
  });
  registry.registerEntity("fixture", { uniqueId: "bolt", domain: "lock", name: "Kitchen" });
  registry.registerEntity("fixture", { uniqueId: "living", domain: "sensor", name: "Living" });
  registry.registerEntity("fixture", { uniqueId: "bedroom", domain: "sensor", name: "Bedroom" });
  const casaRegistry = () => ({
    entities: registry.listEntities().map((e) => ({ id: e.id, domain: e.domain, name: e.name })),
    areas: [],
    devices: registry.listDevices().map((d) => ({ id: d.id, name: d.name })),
  });
  const sensors = new SensorStore({ db, bus, now, registry: casaRegistry });
  const runtime = new SensorRuntime({
    sensors,
    bus,
    states,
    registry,
    logFor: () => noopLogger,
    timezone: "UTC",
    now,
  });
  const report = (id: string, state: EntityState) =>
    states.report("fixture", id as EntityId, state);
  const door = (on: boolean) =>
    report("binary_sensor.kitchen_door", { domain: "binary_sensor", on });
  const bolt = (locked: boolean) => report("lock.kitchen", { domain: "lock", locked });
  const temp = (id: string, value: number | null) =>
    report(id, { domain: "sensor", value, unit: "°C" });
  const stateOf = (id: string) => states.get(id as EntityId);
  return { ...core, sensors, runtime, door, bolt, temp, stateOf };
}

test("a saved sensor is an entity of casa.sensors, computed from its inputs as they change", async () => {
  const { sensors, runtime, registry, door, bolt, stateOf, events } = await setup();
  door(false);
  bolt(true);
  runtime.start();
  expect(sensors.save("kitchen_door", DOOR, "ry").ok).toBe(true);
  const entity = registry.getEntity("sensor.kitchen_door" as EntityId);
  expect(entity).toMatchObject({
    id: "sensor.kitchen_door",
    uniqueId: "kitchen_door",
    integrationId: SENSOR_INTEGRATION,
    domain: "sensor",
    name: "Kitchen door",
  });
  expect(stateOf("sensor.kitchen_door")).toMatchObject({
    state: { domain: "sensor", value: "Secured" },
    available: true,
  });
  bolt(false);
  expect(stateOf("sensor.kitchen_door")?.state).toEqual({ domain: "sensor", value: "Unlocked" });
  door(true);
  expect(stateOf("sensor.kitchen_door")?.state).toEqual({ domain: "sensor", value: "Open" });
  // Its own state change is on the bus like any entity's.
  expect(
    events.filter((e) => e.type === "state_changed" && e.entityId === "sensor.kitchen_door"),
  ).toHaveLength(3);
  expect(runtime.list()).toEqual([
    {
      sensorId: "kitchen_door",
      entityId: "sensor.kitchen_door",
      status: "running",
      error: undefined,
      lastRunAt: 1_000_000,
    },
  ]);
});

test("a Bool sensor is a binary sensor with its class; a Number carries its unit and class, averaging what is there", async () => {
  const { sensors, runtime, door, bolt, temp, stateOf } = await setup();
  runtime.start();
  door(false);
  bolt(true);
  sensors.save("kitchen_secure", SECURE);
  expect(stateOf("binary_sensor.kitchen_secure")?.state).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "door",
  });
  door(true);
  expect(stateOf("binary_sensor.kitchen_secure")?.state).toMatchObject({ on: false });

  temp("sensor.living", 20);
  temp("sensor.bedroom", 22);
  sensors.save("house_temp", HOUSE_TEMP);
  expect(stateOf("sensor.house_temp")?.state).toEqual({
    domain: "sensor",
    value: 21,
    unit: "°C",
    deviceClass: "temperature",
  });
  // A room with no reading is left out of the average, not averaged as zero.
  temp("sensor.bedroom", null);
  expect(stateOf("sensor.house_temp")?.state).toMatchObject({ value: 20 });
});

test("the sensor is unavailable while an input is, or has not reported, and comes back with it", async () => {
  const { sensors, runtime, door, bolt, stateOf, states } = await setup();
  runtime.start();
  sensors.save("kitchen_door", DOOR);
  // Nothing has reported: no state at all yet, the entity exists.
  expect(stateOf("sensor.kitchen_door")).toBeUndefined();
  door(false);
  expect(stateOf("sensor.kitchen_door")).toBeUndefined();
  bolt(true);
  expect(stateOf("sensor.kitchen_door")).toMatchObject({
    available: true,
    state: { value: "Secured" },
  });
  states.setAvailable("fixture", "lock.kitchen" as EntityId, false);
  expect(stateOf("sensor.kitchen_door")?.available).toBe(false);
  states.setAvailable("fixture", "lock.kitchen" as EntityId, true);
  expect(stateOf("sensor.kitchen_door")).toMatchObject({
    available: true,
    state: { value: "Secured" },
  });
});

test("switching a sensor off makes it unavailable; deleting it removes the entity; a type change makes a new one", async () => {
  const { sensors, runtime, registry, door, bolt, stateOf } = await setup();
  runtime.start();
  door(false);
  bolt(true);
  sensors.save("kitchen_door", DOOR);
  sensors.setEnabled("kitchen_door", false);
  expect(stateOf("sensor.kitchen_door")?.available).toBe(false);
  expect(runtime.status("kitchen_door")?.status).toBe("stopped");
  bolt(false);
  expect(stateOf("sensor.kitchen_door")?.available).toBe(false);
  sensors.setEnabled("kitchen_door", true);
  expect(stateOf("sensor.kitchen_door")).toMatchObject({
    available: true,
    state: { value: "Unlocked" },
  });

  // The same id as a Bool is a binary sensor: the words' entity goes, with its history. The
  // real door already holds `binary_sensor.kitchen_door`, so the registry allocates past it.
  sensors.save("kitchen_door", SECURE.replace("KitchenSecure", "KitchenDoor"));
  expect(registry.getEntity("sensor.kitchen_door" as EntityId)).toBeUndefined();
  const asBool = runtime.status("kitchen_door")?.entityId as string;
  expect(asBool).toBe("binary_sensor.kitchen_door_2");
  expect(registry.getEntity(asBool as EntityId)?.integrationId).toBe(SENSOR_INTEGRATION);
  expect(stateOf(asBool)?.state).toMatchObject({ on: false });

  sensors.delete("kitchen_door");
  expect(registry.getEntity(asBool as EntityId)).toBeUndefined();
  expect(runtime.list()).toEqual([]);
});

test("a restart finds the stored sensors and their entities again", async () => {
  const first = await setup();
  first.runtime.start();
  first.door(true);
  first.bolt(true);
  first.sensors.save("kitchen_door", DOOR);
  first.runtime.stop();
  const again = new SensorRuntime({
    sensors: first.sensors,
    bus: first.bus,
    states: first.states,
    registry: first.registry,
    logFor: () => noopLogger,
    timezone: "UTC",
    now: first.now,
  });
  again.start();
  expect(again.list().map((s) => s.entityId)).toEqual(["sensor.kitchen_door"]);
  expect(first.stateOf("sensor.kitchen_door")?.state).toMatchObject({ value: "Open" });
  first.door(false);
  expect(first.stateOf("sensor.kitchen_door")?.state).toMatchObject({ value: "Secured" });
});

test("a sensor whose input is gone waits, unavailable, and computes again when it is back", async () => {
  const { sensors, runtime, registry, door, bolt, stateOf } = await setup();
  runtime.start();
  door(false);
  bolt(true);
  sensors.save("kitchen_door", DOOR);
  expect(stateOf("sensor.kitchen_door")?.available).toBe(true);
  registry.removeEntity("fixture", "lock.kitchen" as EntityId);
  expect(stateOf("sensor.kitchen_door")?.available).toBe(false);
  registry.registerEntity("fixture", { uniqueId: "bolt", domain: "lock", name: "Kitchen" });
  bolt(false);
  expect(stateOf("sensor.kitchen_door")).toMatchObject({
    available: true,
    state: { value: "Unlocked" },
  });
});

test("a sensor whose input names a device follows it: unavailable once the id is renamed away", async () => {
  const { sensors, runtime, registry, temp, stateOf } = await setup();
  const thermostat = registry.registerDevice("fixture", { uniqueId: "t", name: "Thermostat" });
  registry.registerEntity("fixture", {
    uniqueId: "living",
    domain: "sensor",
    name: "Living",
    deviceId: thermostat.id,
  });
  temp("sensor.living", 21);
  runtime.start();
  const saved = sensors.save(
    "thermostat_temp",
    `sensor ThermostatTemp {
  input temps = device.thermostat.entities
  name: "Thermostat temperature"
  type: Number  unit: "°C"
  value: avg(temps, (s) => s.value)
}
`,
  );
  expect(saved).toMatchObject({ ok: true });
  expect(stateOf("sensor.thermostat_temp")).toMatchObject({
    available: true,
    state: { value: 21 },
  });
  // No entity's state changes here; only the rename tells the sensor `thermostat` is gone.
  registry.renameDevice(thermostat.id, "hvac" as DeviceId);
  expect(stateOf("sensor.thermostat_temp")?.available).toBe(false);
});
