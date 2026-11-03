import { expect, test } from "bun:test";
import { Bus } from "../bus.ts";
import { Registry } from "../registry.ts";
import type { DeviceId, EntityId } from "../types.ts";
import { rewriteSource, slugDeviceIds } from "./device-slugs.ts";
import { openDatabase } from "./index.ts";

const HUB = "dev_3f9a1c2b7e4d";
const LAMP = "dev_0a0a0a0a0a0a";
const LAMP_2 = "dev_b1b1b1b1b1b1";

/** A database as the server left it before device ids were slugs. */
async function before() {
  const db = await openDatabase(":memory:");
  const device = (id: string, name: string, at: number, via?: string) =>
    db
      .query(
        `INSERT INTO devices (id, unique_id, integration_id, name, via_device_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, id, "demo.main", name, via ?? null, at, at);
  device(HUB, "Hue Bridge", 1);
  device(LAMP, "Lamp", 2, HUB);
  device(LAMP_2, "Lamp", 3, HUB);
  // Made by hand already under the new rule; it must keep its id and win the plain slug.
  device("hub", "Hub", 4);
  db.query(
    `INSERT INTO entities (id, unique_id, integration_id, device_id, domain, name, created_at, updated_at)
     VALUES ('light.lamp', 'l', 'demo.main', ?, 'light', 'Lamp', 5, 5)`,
  ).run(LAMP);
  const page = `page Home {\n  Card { of: device.${LAMP} }\n  for d in area.hall.devices where d != device.${HUB} { DeviceCard { of: d } }\n}\n`;
  db.query(
    "INSERT INTO pages (id, name, source, compiled, theme_refs, updated_at) VALUES ('home', 'Home', ?, '{}', '[]', 6)",
  ).run(page);
  db.query(
    "INSERT INTO page_versions (page_id, version, source, saved_at) VALUES ('home', 1, ?, 6)",
  ).run(`page Home { Card { of: device.${LAMP_2} } }`);
  db.query(
    "INSERT INTO automations (id, name, source, compiled, updated_at) VALUES ('a', 'A', ?, '{}', 7)",
  ).run(`automation A { on light.lamp changed { for e in device.${HUB}.entities { } } }`);
  db.query(
    "INSERT INTO sensors (id, name, source, compiled, updated_at) VALUES ('s', 'S', ?, '{}', 8)",
  ).run(`sensor S { value: count(device.${LAMP}.entities) }`);
  return db;
}

test("random device ids become slugs of their names, oldest first, and references follow", async () => {
  const db = await before();
  expect(slugDeviceIds(db)).toEqual([
    { from: HUB, to: "hue_bridge" },
    { from: LAMP, to: "lamp" },
    { from: LAMP_2, to: "lamp_2" },
  ]);

  const registry = new Registry({ db, bus: new Bus() });
  expect(registry.listDevices().map((d) => [d.id, d.name, d.viaDeviceId])).toEqual([
    ["hue_bridge", "Hue Bridge", undefined],
    ["lamp", "Lamp", "hue_bridge"],
    ["lamp_2", "Lamp", "hue_bridge"],
    ["hub", "Hub", undefined],
  ]);
  expect(registry.getEntity("light.lamp" as EntityId)?.deviceId).toBe("lamp" as DeviceId);

  const source = (table: string, where = "1") =>
    db.query<{ source: string }, []>(`SELECT source FROM ${table} WHERE ${where}`).get()?.source;
  expect(source("pages")).toBe(
    "page Home {\n  Card { of: device.lamp }\n  for d in area.hall.devices where d != device.hue_bridge { DeviceCard { of: d } }\n}\n",
  );
  expect(source("page_versions")).toBe("page Home { Card { of: device.lamp_2 } }");
  expect(source("automations")).toBe(
    "automation A { on light.lamp changed { for e in device.hue_bridge.entities { } } }",
  );
  expect(source("sensors")).toBe("sensor S { value: count(device.lamp.entities) }");

  // Done once: a second start finds nothing to do.
  expect(slugDeviceIds(db)).toEqual([]);
});

test("a fresh database has nothing to move", async () => {
  expect(slugDeviceIds(await openDatabase(":memory:"))).toEqual([]);
});

test("rewriteSource touches only whole references to the ids it was given", () => {
  const changes = [{ from: HUB, to: "hub" }];
  expect(rewriteSource(`device.${HUB}.name + device.${LAMP}.name`, changes)).toBe(
    `device.hub.name + device.${LAMP}.name`,
  );
  // A string or a longer word that happens to contain the id is not a reference.
  expect(rewriteSource(`"device.${HUB}x" ${HUB}`, changes)).toBe(`"device.${HUB}x" ${HUB}`);
});
