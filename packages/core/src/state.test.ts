import { expect, test } from "bun:test";
import { Bus } from "./bus.ts";
import { Registry } from "./registry.ts";
import { StateStore } from "./state.ts";
import { createCore } from "./testing.ts";
import type { CoreEvent, EntityId } from "./types.ts";

async function setup() {
  const core = await createCore();
  const id = core.registry.registerEntity("demo.main", {
    uniqueId: "a",
    domain: "light",
    name: "Lamp",
  }).id;
  core.events.length = 0;
  return { ...core, id };
}

test("first report emits state_changed with no old record", async () => {
  const { states, events, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true }, { linkquality: 80 });
  expect(events).toEqual([
    {
      type: "state_changed",
      entityId: id,
      old: undefined,
      new: {
        entityId: id,
        state: { domain: "light", on: true },
        attributes: { linkquality: 80 },
        available: true,
        changedAt: 1_000_000,
        updatedAt: 1_000_000,
      },
    },
  ]);
});

test("an identical report is a heartbeat: updatedAt moves, changedAt does not, no event", async () => {
  const { states, events, clock, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true, brightness: 0.5 });
  events.length = 0;
  clock.now += 500;
  states.report("demo.main", id, { domain: "light", brightness: 0.5, on: true });
  expect(events).toEqual([]);
  expect(states.get(id)).toMatchObject({ changedAt: 1_000_000, updatedAt: 1_000_500 });

  clock.now += 500;
  states.report("demo.main", id, { domain: "light", on: false });
  expect(events).toHaveLength(1);
  expect(states.get(id)).toMatchObject({ changedAt: 1_001_000, updatedAt: 1_001_000 });
});

test("reports are rejected for entities the integration does not own", async () => {
  const { states, events, id } = await setup();
  expect(() => states.report("mqtt.main", id, { domain: "light", on: true })).toThrow(
    "did not register",
  );
  expect(() =>
    states.report("demo.main", "light.nope" as EntityId, { domain: "light", on: true }),
  ).toThrow("did not register");
  expect(() => states.setAvailable("mqtt.main", id, false)).toThrow("did not register");
  expect(() => states.report("demo.main", id, { domain: "switch", on: true })).toThrow(
    "is a light",
  );
  expect(events).toEqual([]);
  expect(states.get(id)).toBeUndefined();
});

test("availability changes emit without moving changedAt; a report makes the entity available", async () => {
  const { states, events, clock, id } = await setup();
  states.setAvailable("demo.main", id, false); // nothing known yet
  expect(events).toEqual([]);
  states.report("demo.main", id, { domain: "light", on: true });
  events.length = 0;

  clock.now += 100;
  states.setAvailable("demo.main", id, false);
  states.setAvailable("demo.main", id, false);
  expect(events).toHaveLength(1);
  expect(states.get(id)).toMatchObject({ available: false, changedAt: 1_000_000 });

  states.report("demo.main", id, { domain: "light", on: true });
  expect(events).toHaveLength(2);
  expect(states.get(id)).toMatchObject({ available: true, changedAt: 1_000_000 });
});

test("startup restores the last known state as unavailable", async () => {
  const { states, db, registry, bus, now, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true }, { fw: "1.2" });

  const restarted = new StateStore({ db, registry, bus, now });
  expect(restarted.get(id)).toBeUndefined();
  restarted.restore();
  expect(restarted.get(id)).toEqual({
    entityId: id,
    state: { domain: "light", on: true },
    attributes: { fw: "1.2" },
    available: false,
    changedAt: 1_000_000,
    updatedAt: 1_000_000,
  });
});

test("state follows a rename and is dropped on removal", async () => {
  const { states, registry, db, bus, now, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true });
  const newId = "light.reading" as EntityId;
  registry.renameEntity(id, newId);
  expect(states.get(id)).toBeUndefined();
  expect(states.get(newId)).toMatchObject({ entityId: newId, state: { on: true } });

  registry.removeEntity("demo.main", newId);
  expect(states.get(newId)).toBeUndefined();
  const restarted = new StateStore({ db, registry, bus, now });
  restarted.restore();
  expect(restarted.all()).toEqual([]);
});

test("a change in attributes alone emits an event without moving changedAt", async () => {
  const { states, events, clock, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true }, { latitude: 47.6 });
  events.length = 0;

  clock.now += 500;
  states.report("demo.main", id, { domain: "light", on: true }, { latitude: 47.7 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "state_changed",
    old: { attributes: { latitude: 47.6 } },
    new: { attributes: { latitude: 47.7 }, changedAt: 1_000_000, updatedAt: 1_000_500 },
  });

  // The same attributes again, or none at all, is still a heartbeat; the last ones are kept.
  states.report("demo.main", id, { domain: "light", on: true }, { latitude: 47.7 });
  states.report("demo.main", id, { domain: "light", on: true });
  expect(events).toHaveLength(1);
  expect(states.get(id)?.attributes).toEqual({ latitude: 47.7 });
});

// ───────── a person-chosen class for sensors ─────────

async function sensors() {
  const core = await createCore();
  const window = core.registry.registerEntity("demo.main", {
    uniqueId: "w",
    domain: "binary_sensor",
    name: "Kitchen window",
  }).id;
  const porch = core.registry.registerEntity("demo.main", {
    uniqueId: "p",
    domain: "sensor",
    name: "Porch",
  }).id;
  core.events.length = 0;
  return { ...core, window, porch };
}

test("a report gets the chosen class written in, over the integration's or where it gave none", async () => {
  const { states, registry, window, porch } = await sensors();
  registry.updateEntity(window, { deviceClass: "window" });
  registry.updateEntity(porch, { deviceClass: "humidity" });

  states.report("demo.main", window, { domain: "binary_sensor", on: true });
  expect(states.get(window)?.state).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "window",
  });
  states.report("demo.main", porch, {
    domain: "sensor",
    value: 41,
    unit: "%",
    deviceClass: "temperature",
  });
  expect(states.get(porch)?.state).toEqual({
    domain: "sensor",
    value: 41,
    unit: "%",
    deviceClass: "humidity",
  });
});

test("with no class chosen, the integration's class stands, or none", async () => {
  const { states, events, window, porch } = await sensors();
  states.report("demo.main", porch, { domain: "sensor", value: 20, deviceClass: "temperature" });
  states.report("demo.main", window, { domain: "binary_sensor", on: false });
  expect(states.get(porch)?.state).toEqual({
    domain: "sensor",
    value: 20,
    deviceClass: "temperature",
  });
  expect(states.get(window)?.state).toEqual({ domain: "binary_sensor", on: false });
  expect(events[1]).toMatchObject({ new: { state: { domain: "binary_sensor", on: false } } });
  expect(events[1]).not.toMatchObject({ new: { state: { deviceClass: expect.anything() } } });
});

test("choosing a class emits state_changed at once, with the same changedAt", async () => {
  const { states, registry, events, clock, window } = await sensors();
  states.report("demo.main", window, { domain: "binary_sensor", on: true, deviceClass: "door" });
  events.length = 0;

  clock.now += 5_000;
  registry.updateEntity(window, { deviceClass: "window" });
  const changes = events.filter((e) => e.type === "state_changed");
  expect(changes).toEqual([
    {
      type: "state_changed",
      entityId: window,
      old: {
        entityId: window,
        state: { domain: "binary_sensor", on: true, deviceClass: "door" },
        attributes: undefined,
        available: true,
        changedAt: 1_000_000,
        updatedAt: 1_000_000,
      },
      new: {
        entityId: window,
        state: { domain: "binary_sensor", on: true, deviceClass: "window" },
        attributes: undefined,
        available: true,
        changedAt: 1_000_000,
        updatedAt: 1_000_000,
      },
    },
  ]);
  expect(states.get(window)?.state).toMatchObject({ deviceClass: "window" });

  // A later report keeps the chosen class: the integration's door is a heartbeat.
  events.length = 0;
  clock.now += 1_000;
  states.report("demo.main", window, { domain: "binary_sensor", on: true, deviceClass: "door" });
  expect(events).toEqual([]);
  expect(states.get(window)).toMatchObject({
    state: { deviceClass: "window" },
    changedAt: 1_000_000,
    updatedAt: 1_006_000,
  });
});

test("clearing the class goes back to the integration's, or to none", async () => {
  const { states, registry, events, window, porch } = await sensors();
  registry.updateEntity(porch, { deviceClass: "power" });
  registry.updateEntity(window, { deviceClass: "window" });
  states.report("demo.main", porch, { domain: "sensor", value: 20, deviceClass: "temperature" });
  states.report("demo.main", window, { domain: "binary_sensor", on: true });
  events.length = 0;

  registry.updateEntity(porch, { deviceClass: null });
  registry.updateEntity(window, { deviceClass: null });
  expect(events.filter((e) => e.type === "state_changed")).toMatchObject([
    { entityId: porch, new: { state: { deviceClass: "temperature" }, changedAt: 1_000_000 } },
    { entityId: window, new: { state: { domain: "binary_sensor", on: true } } },
  ]);
  expect(states.get(porch)?.state).toEqual({
    domain: "sensor",
    value: 20,
    deviceClass: "temperature",
  });
  expect(states.get(window)?.state).toEqual({ domain: "binary_sensor", on: true });
});

test("no state_changed when the class change makes no difference, or nothing is known yet", async () => {
  const { states, registry, events, window, porch } = await sensors();
  // No record yet: the class waits for the first report.
  registry.updateEntity(window, { deviceClass: "window" });
  expect(events.map((e) => e.type)).toEqual(["entity_updated"]);
  expect(states.get(window)).toBeUndefined();

  states.report("demo.main", porch, { domain: "sensor", value: 20, deviceClass: "temperature" });
  events.length = 0;
  // Choosing the class the integration already gave changes nothing to see.
  registry.updateEntity(porch, { deviceClass: "temperature" });
  // Neither does an edit that is not about the class.
  registry.updateEntity(porch, { name: "Porch temp" });
  // Nor clearing it, since the integration says temperature too.
  registry.updateEntity(porch, { deviceClass: null });
  expect(events.map((e) => e.type)).toEqual(["entity_updated", "entity_updated", "entity_updated"]);
});

test("other domains are untouched by the class machinery", async () => {
  const { states, registry, events, id } = await setup();
  states.report("demo.main", id, { domain: "light", on: true });
  events.length = 0;
  registry.updateEntity(id, { name: "Reading lamp", icon: "lamp" });
  expect(events.map((e) => e.type)).toEqual(["entity_updated"]);
  expect(states.get(id)?.state).toEqual({ domain: "light", on: true });
});

test("last_states holds the reported state, and restore applies the chosen class", async () => {
  const { states, registry, db, bus, now, porch } = await sensors();
  registry.updateEntity(porch, { deviceClass: "humidity" });
  states.report("demo.main", porch, { domain: "sensor", value: 41, deviceClass: "temperature" });

  const row = db.query<{ state: string }, []>("SELECT state FROM last_states").get();
  expect(JSON.parse(row?.state ?? "null")).toEqual({
    domain: "sensor",
    value: 41,
    deviceClass: "temperature",
  });

  const restarted = new StateStore({ db, registry, bus, now });
  restarted.restore();
  expect(restarted.get(porch)).toMatchObject({
    state: { domain: "sensor", value: 41, deviceClass: "humidity" },
    available: false,
    changedAt: 1_000_000,
  });
});

test("clearing a class after a restart falls back to the stored integration class", async () => {
  const { states, registry, db, now, porch } = await sensors();
  registry.updateEntity(porch, { deviceClass: "humidity" });
  states.report("demo.main", porch, { domain: "sensor", value: 41, deviceClass: "temperature" });

  // Startup: a fresh bus, registry and store on the same database.
  const bus = new Bus();
  const events: CoreEvent[] = [];
  bus.onAny((e) => events.push(e));
  const reloaded = new Registry({ db, bus, now });
  const restarted = new StateStore({ db, registry: reloaded, bus, now });
  restarted.restore();
  expect(restarted.get(porch)?.state).toMatchObject({ deviceClass: "humidity" });

  reloaded.updateEntity(porch, { deviceClass: null });
  expect(restarted.get(porch)?.state).toEqual({
    domain: "sensor",
    value: 41,
    deviceClass: "temperature",
  });
  expect(events.filter((e) => e.type === "state_changed")).toMatchObject([
    { entityId: porch, new: { state: { deviceClass: "temperature" }, available: false } },
  ]);
});

test("a rename keeps the reported state, so a later class change still reads through", async () => {
  const { states, registry, db, bus, now, events, porch } = await sensors();
  states.report("demo.main", porch, { domain: "sensor", value: 20, deviceClass: "temperature" });
  const newId = "sensor.porch_air" as EntityId;
  registry.renameEntity(porch, newId);
  events.length = 0;

  registry.updateEntity(newId, { deviceClass: "humidity" });
  expect(states.get(newId)?.state).toMatchObject({ deviceClass: "humidity" });
  expect(events.filter((e) => e.type === "state_changed")).toMatchObject([
    { entityId: newId, new: { state: { deviceClass: "humidity" } } },
  ]);
  registry.updateEntity(newId, { deviceClass: null });
  expect(states.get(newId)?.state).toMatchObject({ deviceClass: "temperature" });

  // What is stored under the new id is still what the integration said.
  registry.updateEntity(newId, { deviceClass: "power" });
  const restarted = new StateStore({ db, registry, bus, now });
  restarted.restore();
  expect(restarted.get(newId)?.state).toMatchObject({ deviceClass: "power" });
  const row = db
    .query<{ state: string }, [string]>("SELECT state FROM last_states WHERE entity_id = ?")
    .get(newId);
  expect(JSON.parse(row?.state ?? "null")).toMatchObject({ deviceClass: "temperature" });
});

test("a removed sensor's reported state goes with it", async () => {
  const { states, registry, events, porch } = await sensors();
  states.report("demo.main", porch, { domain: "sensor", value: 20 });
  registry.removeEntity("demo.main", porch);
  // Re-registered under the same unique id it is a new entity with nothing known.
  const again = registry.registerEntity("demo.main", {
    uniqueId: "p",
    domain: "sensor",
    name: "Porch",
  }).id;
  events.length = 0;
  registry.updateEntity(again, { deviceClass: "humidity" });
  expect(states.get(again)).toBeUndefined();
  expect(events.map((e) => e.type)).toEqual(["entity_updated"]);
});
