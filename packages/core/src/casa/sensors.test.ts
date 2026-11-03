import { expect, test } from "bun:test";
import { CoreError } from "../errors.ts";
import { createCore } from "../testing.ts";
import type { CoreEvent } from "../types.ts";
import type { Registry } from "./check.ts";
import { REGISTRY } from "./fixtures.ts";
import { SensorStore } from "./sensors.ts";

const DOOR = `sensor HallDoor {
  input motion = binary_sensor.hall_motion
  input bolt = lock.front
  name: "Hall door"
  type: String
  value: motion.value == .On ? "Open" : bolt.value == .Unlocked ? "Unlocked" : "Secured"
}
`;
const DOOR_BOOL = `sensor HallDoor {
  input bolt = lock.front
  name: "Hall door"
  type: Bool  class: .Lock
  value: bolt.value == .Unlocked
}
`;

async function setup(registry: () => Registry = () => REGISTRY) {
  const core = await createCore();
  const { db, bus, now } = core;
  return { ...core, store: new SensorStore({ db, bus, now, registry }) };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoreError) return e.code;
    throw e;
  }
  return undefined;
}

const changed = (id: string): CoreEvent => ({ type: "sensor_changed", sensorId: id });

test("saving a compiling source stores the sensor, a first version, and announces it", async () => {
  const { store, events, now } = await setup();
  const result = store.save("hall_door", DOOR, "ry");
  expect(result.ok).toBe(true);
  expect(result.sensor).toMatchObject({
    id: "hall_door",
    name: "Hall door",
    enabled: true,
    type: "String",
    entities: ["binary_sensor.hall_motion", "lock.front"],
    updatedAt: now(),
    updatedBy: "ry",
  });
  expect(result.sensor?.compiled.inputs.map((i) => i.name)).toEqual(["motion", "bolt"]);
  expect(events).toEqual([changed("hall_door")]);
  expect(store.getSource("hall_door")).toEqual({
    source: DOOR,
    versions: [{ version: 1, savedAt: now(), savedBy: "ry" }],
  });
});

test("a source that does not compile is reported and nothing is stored or announced", async () => {
  const { store, events } = await setup();
  const bad = store.save("x", DOOR_BOOL);
  expect(bad.ok).toBe(false);
  // `.Lock` is not a binary class.
  expect(bad.diagnostics.map((d) => d.code)).toEqual(["E030"]);
  expect(store.save("x", "automation X { }").diagnostics.map((d) => d.code)).toContain("E001");
  expect(store.get("x")).toBeUndefined();
  expect(events).toEqual([]);
  expect(codeOf(() => store.save("Hall-Door", DOOR))).toBe("invalid");
});

test("versions, revert, enable and delete work as an automation's do", async () => {
  const { store, events, db } = await setup();
  const asBool = DOOR_BOOL.replace(".Lock", ".Door");
  store.save("hall_door", DOOR, "ry");
  store.save("hall_door", asBool);
  expect(store.get("hall_door")?.type).toBe("Bool");
  expect(store.getSource("hall_door").versions.map((v) => v.version)).toEqual([2, 1]);
  expect(store.revert("hall_door", 1).ok).toBe(true);
  expect(store.get("hall_door")?.type).toBe("String");
  expect(store.list().map((s) => s.id)).toEqual(["hall_door"]);
  events.length = 0;
  expect(store.setEnabled("hall_door", false).enabled).toBe(false);
  expect(events).toEqual([changed("hall_door")]);
  expect(store.check(DOOR)).toEqual([]);
  store.delete("hall_door");
  expect(store.get("hall_door")).toBeUndefined();
  const count = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sensor_versions WHERE sensor_id = ?")
    .get("hall_door");
  expect(count?.n).toBe(0);
  expect(codeOf(() => store.delete("hall_door"))).toBe("not_found");
  expect(codeOf(() => store.setEnabled("hall_door", true))).toBe("not_found");
  expect(codeOf(() => store.getSource("hall_door"))).toBe("not_found");
});

test("refresh recompiles what the compiler now emits differently and names what no longer compiles", async () => {
  let registry: Registry = REGISTRY;
  const { store, events } = await setup(() => registry);
  store.save("hall_door", DOOR);
  events.length = 0;
  expect(store.refresh()).toEqual({ refreshed: [], failed: [] });
  // The lock is gone from the house: the stored sensor is left as it was, and named.
  registry = { ...REGISTRY, entities: REGISTRY.entities.filter((e) => e.id !== "lock.front") };
  const result = store.refresh();
  expect(result.refreshed).toEqual([]);
  expect(result.failed.map((f) => f.id)).toEqual(["hall_door"]);
  expect(result.failed[0]?.message).toContain("lock.front");
  expect(store.get("hall_door")?.type).toBe("String");
  expect(events).toEqual([]);
});
