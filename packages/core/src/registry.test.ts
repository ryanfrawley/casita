import { expect, test } from "bun:test";
import { Bus } from "./bus.ts";
import { ALIAS_TTL_MS, ENTITY_CLASSES, Registry } from "./registry.ts";
import { createCore } from "./testing.ts";
import type { AreaId, Device, DeviceId, EntityId } from "./types.ts";

const light = (uniqueId: string, name: string) => ({ uniqueId, domain: "light" as const, name });

test("ids are slugged from the name and collisions get _2, _3", async () => {
  const { registry } = await createCore();
  const ids = ["a", "b", "c"].map(
    (u) => registry.registerEntity("demo.main", light(u, "Kitchen Céiling!")).id,
  );
  expect(ids).toEqual([
    "light.kitchen_ceiling",
    "light.kitchen_ceiling_2",
    "light.kitchen_ceiling_3",
  ] as EntityId[]);
  expect(registry.registerEntity("demo.main", { ...light("d", "x"), slug: "Desk Lamp" }).id).toBe(
    "light.desk_lamp" as EntityId,
  );
});

test("registration is idempotent on uniqueId and updates metadata", async () => {
  const { registry, events } = await createCore();
  const first = registry.registerEntity("demo.main", light("a", "Lamp"));
  events.length = 0;
  expect(registry.registerEntity("demo.main", light("a", "Lamp"))).toBe(first);
  expect(events).toEqual([]);

  const updated = registry.registerEntity("demo.main", {
    ...light("a", "Floor Lamp"),
    capabilities: { brightness: true },
  });
  expect(updated.id).toBe(first.id);
  expect(updated.name).toBe("Floor Lamp");
  expect(updated.capabilities).toEqual({ brightness: true });
  expect(events.map((e) => e.type)).toEqual(["entity_updated"]);
  expect(registry.listEntities()).toHaveLength(1);
});

test("the same uniqueId under another instance is a different entity", async () => {
  const { registry } = await createCore();
  const a = registry.registerEntity("mqtt.one", light("a", "Lamp"));
  const b = registry.registerEntity("mqtt.two", light("a", "Lamp"));
  expect(b.id).not.toBe(a.id);
});

test("a renamed entity re-attaches by uniqueId, across restarts", async () => {
  const { registry, db, now } = await createCore();
  const entity = registry.registerEntity("demo.main", light("a", "Lamp"));
  registry.renameEntity(entity.id, "light.reading" as EntityId);

  const reloaded = new Registry({ db, bus: new Bus(), now });
  const again = reloaded.registerEntity("demo.main", light("a", "Lamp"));
  expect(again.id).toBe("light.reading" as EntityId);
  expect(reloaded.listEntities()).toHaveLength(1);
});

test("rename keeps an alias for 30 days, then frees the old id", async () => {
  const { registry, clock, events } = await createCore();
  const oldId = registry.registerEntity("demo.main", light("a", "Lamp")).id;
  const newId = "light.reading" as EntityId;
  registry.renameEntity(oldId, newId);

  expect(events.at(-1)).toMatchObject({ type: "entity_renamed", oldId, entity: { id: newId } });
  expect(registry.getEntity(oldId)).toBeUndefined();
  expect(registry.aliasTarget(oldId)).toBe(newId);
  expect(() => registry.updateEntity(oldId, { hidden: true })).toThrow(
    "was renamed to light.reading",
  );
  // The old id is reserved while the alias lives.
  expect(registry.registerEntity("demo.main", light("b", "Lamp")).id).toBe(
    "light.lamp_2" as EntityId,
  );

  clock.now += ALIAS_TTL_MS;
  expect(registry.aliasTarget(oldId)).toBeUndefined();
  registry.purgeExpiredAliases();
  expect(registry.registerEntity("demo.main", light("c", "Lamp")).id).toBe(oldId);
});

test("rename rejects bad ids, other domains, and ids in use; renaming back is allowed", async () => {
  const { registry } = await createCore();
  const a = registry.registerEntity("demo.main", light("a", "A")).id;
  const b = registry.registerEntity("demo.main", light("b", "B")).id;
  expect(() => registry.renameEntity(a, "light.Bad-Id" as EntityId)).toThrow("must look like");
  expect(() => registry.renameEntity(a, "switch.a" as EntityId)).toThrow("must look like");
  expect(() => registry.renameEntity(a, b)).toThrow("already in use");
  registry.renameEntity(a, "light.c" as EntityId);
  expect(() => registry.renameEntity(b, a)).toThrow("already in use");
  expect(registry.renameEntity("light.c" as EntityId, a).id).toBe(a);
  expect(registry.aliasTarget(a)).toBeUndefined();
  expect(registry.aliasTarget("light.c" as EntityId)).toBe(a);
});

test("entities of an instance that is no longer loaded are orphaned, and recover on registration", async () => {
  const { registry } = await createCore();
  const device = registry.registerDevice("mqtt.old", { uniqueId: "d", name: "Plug" });
  const gone = registry.registerEntity("mqtt.old", { ...light("a", "Gone"), deviceId: device.id });
  const kept = registry.registerEntity("demo.main", light("b", "Kept"));
  expect(() => registry.deleteEntity(gone.id)).toThrow("not orphaned");
  expect(() => registry.deleteDevice(device.id)).toThrow("not orphaned and still has entities");

  registry.markOrphans(new Set(["demo.main"]));
  expect(registry.getEntity(gone.id)?.orphaned).toBe(true);
  expect(registry.getDevice(device.id)?.orphaned).toBe(true);
  expect(registry.getEntity(kept.id)?.orphaned).toBeUndefined();

  expect(
    registry.registerEntity("mqtt.old", { ...light("a", "Gone"), deviceId: device.id }).orphaned,
  ).toBeUndefined();
  registry.markOrphans(new Set(["demo.main"]));
  registry.deleteDevice(device.id);
  expect(registry.getEntity(gone.id)).toBeUndefined();
  expect(registry.getDevice(device.id)).toBeUndefined();
});

test("only the owning instance can remove an entity", async () => {
  const { registry } = await createCore();
  const id = registry.registerEntity("demo.main", light("a", "Lamp")).id;
  expect(() => registry.removeEntity("mqtt.main", id)).toThrow("did not register");
  registry.removeEntity("demo.main", id);
  expect(registry.getEntity(id)).toBeUndefined();
});

test("a live device with no entities left can be deleted; one with entities cannot", async () => {
  const { registry, events } = await createCore();
  const stale = registry.registerDevice("demo.main", { uniqueId: "n4", name: "Node 4" });
  const live = registry.registerDevice("demo.main", { uniqueId: "n5", name: "Node 5" });
  registry.registerEntity("demo.main", { ...light("a", "Lamp"), deviceId: live.id });
  expect(() => registry.deleteDevice(live.id)).toThrow(
    "Node 5 is not orphaned and still has entities",
  );

  events.length = 0;
  registry.deleteDevice(stale.id);
  expect(registry.getDevice(stale.id)).toBeUndefined();
  expect(registry.getDevice(live.id)).toBeDefined();
  expect(events.map((e) => e.type)).toEqual(["device_removed"]);
});

test("a device's id is a slug of its name; collisions get _2, and a rename keeps the id", async () => {
  const { registry, db, bus } = await createCore();
  const ids = ["a", "b"].map(
    (u) => registry.registerDevice("demo.main", { uniqueId: u, name: "Thermostat (Hall)" }).id,
  );
  expect(ids).toEqual(["thermostat_hall", "thermostat_hall_2"] as DeviceId[]);
  registry.updateDevice(ids[0] as DeviceId, { name: "Hallway" });
  expect(registry.getDevice(ids[0] as DeviceId)?.name).toBe("Hallway");
  // Rediscovery under a new name keeps the id too: it is the device's handle, not its label.
  expect(registry.registerDevice("demo.main", { uniqueId: "b", name: "Other" }).id).toBe(
    ids[1] as DeviceId,
  );
  expect(new Registry({ db, bus }).listDevices().map((d) => d.id)).toEqual(ids);
});

test("renameDevice moves its entities and the devices behind it; the old id is free again", async () => {
  const { registry, db, bus, events } = await createCore();
  const hub = registry.registerDevice("demo.main", { uniqueId: "hub", name: "Hub" });
  const bulb = registry.registerDevice("demo.main", {
    uniqueId: "bulb",
    name: "Bulb",
    viaDeviceId: hub.id,
  });
  const lamp = registry.registerEntity("demo.main", { ...light("a", "Lamp"), deviceId: hub.id });
  const other = registry.registerEntity("demo.main", { ...light("b", "Other"), deviceId: bulb.id });
  registry.updateDevice(hub.id, { name: "Bridge" });
  events.length = 0;

  const renamed = registry.renameDevice(hub.id, "bridge" as DeviceId);
  expect(renamed).toMatchObject({ id: "bridge", name: "Bridge", uniqueId: "hub" });
  expect(events).toEqual([{ type: "device_renamed", oldId: "hub" as DeviceId, device: renamed }]);
  expect(registry.getDevice(hub.id)).toBeUndefined();
  expect(registry.getEntity(lamp.id)?.deviceId).toBe("bridge" as DeviceId);
  expect(registry.getEntity(other.id)?.deviceId).toBe(bulb.id);
  expect(registry.getDevice(bulb.id)?.viaDeviceId).toBe("bridge" as DeviceId);
  // Home draws devices in the order they were made; a rename keeps the place.
  expect(registry.listDevices().map((d) => d.id)).toEqual(["bridge", "bulb"] as DeviceId[]);

  // Rediscovery finds the renamed row, the user's name survives, and so does a restart.
  expect(registry.registerDevice("demo.main", { uniqueId: "hub", name: "Hub" }).id).toBe(
    "bridge" as DeviceId,
  );
  const reloaded = new Registry({ db, bus });
  expect(reloaded.getDevice("bridge" as DeviceId)).toMatchObject({ name: "Bridge" });
  expect(reloaded.getEntity(lamp.id)?.deviceId).toBe("bridge" as DeviceId);
  expect(reloaded.getDevice(bulb.id)?.viaDeviceId).toBe("bridge" as DeviceId);

  // The old id can be taken by a new device; a taken or malformed id is refused.
  expect(registry.registerDevice("demo.main", { uniqueId: "new", name: "Hub" }).id).toBe(
    "hub" as DeviceId,
  );
  expect(() => registry.renameDevice(bulb.id, "hub" as DeviceId)).toThrow("already in use");
  expect(() => registry.renameDevice(bulb.id, "Bulb.2" as DeviceId)).toThrow("must look like");
  expect(registry.renameDevice(bulb.id, bulb.id)).toBe(registry.getDevice(bulb.id) as Device);
});

test("only the owning instance can remove a device, and its entities go with it", async () => {
  const { registry, events } = await createCore();
  const device = registry.registerDevice("demo.main", { uniqueId: "d", name: "Lock" });
  const entity = registry.registerEntity("demo.main", {
    ...light("a", "Lamp"),
    deviceId: device.id,
  });
  expect(() => registry.removeDevice("mqtt.main", device.id)).toThrow("did not register");
  events.length = 0;
  registry.removeDevice("demo.main", device.id);
  expect(registry.getDevice(device.id)).toBeUndefined();
  expect(registry.getEntity(entity.id)).toBeUndefined();
  expect(events.map((e) => e.type)).toEqual(["entity_removed", "device_removed"]);
  expect(() => registry.removeDevice("demo.main", device.id)).toThrow("did not register");
});

test("an entity inherits its device's area unless overridden", async () => {
  const { registry } = await createCore();
  const kitchen = registry.createArea("Kitchen");
  const hall = registry.createArea("Hall");
  const device = registry.registerDevice("demo.main", { uniqueId: "d", name: "Strip" });
  const a = registry.registerEntity("demo.main", { ...light("a", "A"), deviceId: device.id });
  const b = registry.registerEntity("demo.main", { ...light("b", "B"), deviceId: device.id });
  registry.updateDevice(device.id, { areaId: kitchen.id });
  registry.updateEntity(b.id, { areaId: hall.id });

  expect(registry.entitiesInArea(kitchen.id).map((e) => e.id)).toEqual([a.id]);
  expect(registry.entitiesInArea(hall.id).map((e) => e.id)).toEqual([b.id]);
  registry.updateEntity(b.id, { areaId: null });
  expect(registry.entitiesInArea(kitchen.id)).toHaveLength(2);
  expect(() => registry.updateEntity(a.id, { areaId: "nope" as AreaId })).toThrow("Unknown area");

  registry.deleteArea(kitchen.id);
  expect(registry.getDevice(device.id)?.areaId).toBeUndefined();
  expect(registry.createArea("Kitchen").id).toBe("kitchen" as AreaId);
  expect(registry.createArea("Kitchen").id).toBe("kitchen_2" as AreaId);
});

test("a chosen icon persists, survives rediscovery and restart, and clears back to the default", async () => {
  const { registry, db, now } = await createCore();
  const kitchen = registry.createArea("Kitchen");
  const device = registry.registerDevice("demo.main", { uniqueId: "d1", name: "Fan unit" });
  const id = registry.registerEntity("demo.main", {
    ...light("a", "0x00158d0001"),
    deviceId: device.id,
  }).id;

  expect(registry.updateEntity(id, { icon: "fan" }).icon).toBe("fan");
  expect(registry.updateDevice(device.id, { icon: "air-vent" }).icon).toBe("air-vent");
  expect(registry.updateArea(kitchen.id, { icon: "flame" })).toEqual({
    id: kitchen.id,
    name: "Kitchen",
    icon: "flame",
  });
  // A rename leaves the icon alone, and the other way round.
  expect(registry.updateArea(kitchen.id, { name: "Galley" })).toMatchObject({
    name: "Galley",
    icon: "flame",
  });
  expect(registry.updateEntity(id, { name: "Ceiling fan" }).icon).toBe("fan");

  const reloaded = new Registry({ db, bus: new Bus(), now });
  expect(reloaded.getEntity(id)?.icon).toBe("fan");
  expect(reloaded.getDevice(device.id)?.icon).toBe("air-vent");
  expect(reloaded.getArea(kitchen.id)?.icon).toBe("flame");
  expect(
    reloaded.registerEntity("demo.main", { ...light("a", "0x00158d0001"), deviceId: device.id })
      .icon,
  ).toBe("fan");

  expect(reloaded.updateEntity(id, { icon: null }).icon).toBeUndefined();
  expect(reloaded.updateDevice(device.id, { icon: null }).icon).toBeUndefined();
  expect(reloaded.updateArea(kitchen.id, { icon: null }).icon).toBeUndefined();
  expect(new Registry({ db, bus: new Bus(), now }).getEntity(id)?.icon).toBeUndefined();
});

test("a user-set name survives rediscovery and restart; flags persist", async () => {
  const { registry, db, now } = await createCore();
  const id = registry.registerEntity("demo.main", light("a", "0x00158d0001")).id;
  registry.updateEntity(id, { name: "Reading lamp", hidden: true, disabled: true });

  const reloaded = new Registry({ db, bus: new Bus(), now });
  const entity = reloaded.registerEntity("demo.main", light("a", "0x00158d0001"));
  expect(entity).toMatchObject({ name: "Reading lamp", hidden: true, disabled: true });
});

// ───────── a person-chosen class for sensors ─────────

const codeOfThrow = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

test("a sensor's or binary sensor's class can be chosen, persists across restart, and clears", async () => {
  const { registry, db, now, events } = await createCore();
  const window = registry.registerEntity("demo.main", {
    uniqueId: "w",
    domain: "binary_sensor",
    name: "Kitchen window",
  }).id;
  const temp = registry.registerEntity("demo.main", {
    uniqueId: "t",
    domain: "sensor",
    name: "Porch",
  }).id;
  events.length = 0;

  expect(registry.updateEntity(window, { deviceClass: "window" }).deviceClass).toBe("window");
  expect(registry.updateEntity(temp, { deviceClass: "temperature" }).deviceClass).toBe(
    "temperature",
  );
  expect(events).toMatchObject([
    { type: "entity_updated", entity: { id: window, deviceClass: "window" } },
    { type: "entity_updated", entity: { id: temp, deviceClass: "temperature" } },
  ]);

  // Another edit leaves the class alone, and so does rediscovery.
  expect(registry.updateEntity(window, { name: "Window" }).deviceClass).toBe("window");
  expect(
    registry.registerEntity("demo.main", {
      uniqueId: "w",
      domain: "binary_sensor",
      name: "Kitchen window",
    }).deviceClass,
  ).toBe("window");

  const reloaded = new Registry({ db, bus: new Bus(), now });
  expect(reloaded.getEntity(window)?.deviceClass).toBe("window");
  expect(reloaded.getEntity(temp)?.deviceClass).toBe("temperature");

  expect(reloaded.updateEntity(window, { deviceClass: null }).deviceClass).toBeUndefined();
  expect(new Registry({ db, bus: new Bus(), now }).getEntity(window)?.deviceClass).toBeUndefined();
  expect(new Registry({ db, bus: new Bus(), now }).getEntity(temp)?.deviceClass).toBe(
    "temperature",
  );
});

test("a class survives a rename of the entity", async () => {
  const { registry, db, now } = await createCore();
  const id = registry.registerEntity("demo.main", {
    uniqueId: "w",
    domain: "binary_sensor",
    name: "Window",
  }).id;
  registry.updateEntity(id, { deviceClass: "window" });
  const renamed = registry.renameEntity(id, "binary_sensor.kitchen_window" as EntityId);
  expect(renamed.deviceClass).toBe("window");
  expect(new Registry({ db, bus: new Bus(), now }).getEntity(renamed.id)?.deviceClass).toBe(
    "window",
  );
});

test("only a sensor or binary sensor takes a class, and only one of its own domain's", async () => {
  const { registry, events } = await createCore();
  const lamp = registry.registerEntity("demo.main", light("a", "Lamp")).id;
  const door = registry.registerEntity("demo.main", {
    uniqueId: "d",
    domain: "binary_sensor",
    name: "Door",
  }).id;
  const power = registry.registerEntity("demo.main", {
    uniqueId: "p",
    domain: "sensor",
    name: "Power",
  }).id;
  registry.updateEntity(door, { deviceClass: "door" });
  events.length = 0;

  expect(() => registry.updateEntity(lamp, { deviceClass: "window" })).toThrow(
    "only a sensor or binary sensor has a class",
  );
  expect(codeOfThrow(() => registry.updateEntity(lamp, { deviceClass: "window" }))).toBe("invalid");
  // A sensor's class on a binary sensor, and the other way round.
  expect(() => registry.updateEntity(door, { deviceClass: "temperature" })).toThrow(
    "temperature is not a binary_sensor class",
  );
  expect(codeOfThrow(() => registry.updateEntity(power, { deviceClass: "window" }))).toBe(
    "invalid",
  );
  expect(codeOfThrow(() => registry.updateEntity(power, { deviceClass: "" }))).toBe("invalid");
  expect(codeOfThrow(() => registry.updateEntity(power, { deviceClass: "Temperature" }))).toBe(
    "invalid",
  );

  // A refused class changes nothing, other fields in the same patch included.
  expect(() =>
    registry.updateEntity(door, { name: "Back door", deviceClass: "humidity" }),
  ).toThrow();
  expect(registry.getEntity(door)).toMatchObject({ name: "Door", deviceClass: "door" });
  expect(registry.getEntity(lamp)?.deviceClass).toBeUndefined();
  expect(events).toEqual([]);
});

test("every class in ENTITY_CLASSES is accepted for its domain", async () => {
  const { registry } = await createCore();
  for (const [domain, classes] of Object.entries(ENTITY_CLASSES)) {
    const id = registry.registerEntity("demo.main", {
      uniqueId: domain,
      domain: domain as "sensor" | "binary_sensor",
      name: domain,
    }).id;
    for (const c of classes ?? []) {
      expect(registry.updateEntity(id, { deviceClass: c }).deviceClass).toBe(c as never);
    }
  }
  expect(Object.keys(ENTITY_CLASSES).sort()).toEqual(["binary_sensor", "sensor"]);
});
