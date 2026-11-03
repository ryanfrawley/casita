import { expect, test } from "bun:test";
import { CoreError } from "../errors.ts";
import { createCore } from "../testing.ts";
import type { CoreEvent } from "../types.ts";
import { AutomationStore } from "./automations.ts";
import type { Registry } from "./check.ts";
import { REGISTRY } from "./fixtures.ts";

const HALL =
  "automation HallLight {\n  on switch.porch changed to .On { call light.hall.turn_on }\n}\n";
const HALL_OFF =
  "automation HallLight {\n  on switch.porch changed to .Off { call light.hall.turn_off }\n}\n";

async function setup(registry: () => Registry = () => REGISTRY) {
  const core = await createCore();
  const { db, bus, now } = core;
  return { ...core, store: new AutomationStore({ db, bus, now, registry }) };
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

const changed = (id: string): CoreEvent => ({ type: "automation_changed", automationId: id });

test("saving a compiling source stores the automation, a first version, and announces it", async () => {
  const { store, events, now } = await setup();
  const result = store.save("hall_light", HALL, "ry");
  expect(result.ok).toBe(true);
  expect(result.automation).toMatchObject({
    id: "hall_light",
    name: "HallLight",
    enabled: true,
    handlers: 1,
    entities: ["light.hall", "switch.porch"],
    updatedAt: now(),
    updatedBy: "ry",
  });
  expect(result.automation?.compiled).toHaveLength(1);
  expect(events).toEqual([changed("hall_light")]);
  expect(store.getSource("hall_light")).toEqual({
    source: HALL,
    versions: [{ version: 1, savedAt: now(), savedBy: "ry" }],
  });
});

test("a second save adds a version, listed newest first", async () => {
  const { store } = await setup();
  store.save("hall_light", HALL, "ry");
  store.save("hall_light", HALL_OFF);
  const { source, versions } = store.getSource("hall_light");
  expect(source).toBe(HALL_OFF);
  expect(versions.map((v) => [v.version, v.savedBy])).toEqual([
    [2, undefined],
    [1, "ry"],
  ]);
});

test("a source that does not compile is reported and nothing is stored or announced", async () => {
  const { store, events } = await setup();
  const unknown = store.save("x", "automation X { on light.nope changed { } }");
  expect(unknown.ok).toBe(false);
  expect(unknown.diagnostics.map((d) => d.code)).toContain("E010");
  const page = store.save("x", "page Home { Stack { } }");
  expect(page.ok).toBe(false);
  expect(page.diagnostics.map((d) => d.code)).toContain("E001");
  expect(store.get("x")).toBeUndefined();
  expect(events).toEqual([]);
});

test("an id outside lowercase letters, digits and underscores is refused as invalid", async () => {
  const { store, events } = await setup();
  expect(codeOf(() => store.save("Hall-Light", HALL))).toBe("invalid");
  expect(store.list()).toEqual([]);
  expect(events).toEqual([]);
});

test("checking a source reports its diagnostics without storing anything", async () => {
  const { store, events } = await setup();
  expect(store.check(HALL)).toEqual([]);
  expect(store.check("automation X { on light.nope changed { } }").map((d) => d.code)).toContain(
    "E010",
  );
  expect(store.list()).toEqual([]);
  expect(events).toEqual([]);
});

test("automations list by name, and an unknown id or version is not found", async () => {
  const { store } = await setup();
  store.save("b", "automation Zed {\n  on switch.porch changed { call light.hall.turn_on }\n}\n");
  store.save("z", HALL);
  expect(store.list().map((a) => a.name)).toEqual(["HallLight", "Zed"]);
  expect(store.get("nope")).toBeUndefined();
  expect(codeOf(() => store.getSource("nope"))).toBe("not_found");
  expect(codeOf(() => store.versionSource("z", 99))).toBe("not_found");
});

test("reverting saves the old version's source again as a new version", async () => {
  const { store } = await setup();
  store.save("hall_light", HALL);
  store.save("hall_light", HALL_OFF);
  expect(store.revert("hall_light", 1, "ry").ok).toBe(true);
  const { source, versions } = store.getSource("hall_light");
  expect(source).toBe(HALL);
  expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
  expect(versions[0]?.savedBy).toBe("ry");
});

test("disabling flips the switch without a new version and is announced", async () => {
  const { store, events } = await setup();
  store.save("hall_light", HALL);
  events.length = 0;
  expect(store.setEnabled("hall_light", false).enabled).toBe(false);
  expect(store.get("hall_light")?.enabled).toBe(false);
  expect(store.getSource("hall_light").versions).toHaveLength(1);
  expect(events).toEqual([changed("hall_light")]);
  expect(codeOf(() => store.setEnabled("nope", true))).toBe("not_found");
});

test("deleting removes the automation and its versions and is announced", async () => {
  const { store, events, db } = await setup();
  store.save("hall_light", HALL);
  store.save("hall_light", HALL_OFF);
  events.length = 0;
  store.delete("hall_light");
  expect(store.get("hall_light")).toBeUndefined();
  const count = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM automation_versions WHERE automation_id = ?",
    )
    .get("hall_light");
  expect(count?.n).toBe(0);
  expect(events).toEqual([changed("hall_light")]);
  expect(codeOf(() => store.delete("hall_light"))).toBe("not_found");
});

test("refreshing an up-to-date house changes nothing", async () => {
  const { store, events } = await setup();
  store.save("hall_light", HALL);
  events.length = 0;
  expect(store.refresh()).toEqual({ refreshed: [], failed: [] });
  expect(events).toEqual([]);
});

test("refreshing recompiles a stale stored compile without saving a version", async () => {
  const { store, events, db } = await setup();
  const saved = store.save("hall_light", HALL).automation;
  // Stands in for a compile from an older compiler.
  db.query("UPDATE automations SET compiled = ? WHERE id = ?").run(
    '{"handlers":[],"entities":[]}',
    "hall_light",
  );
  events.length = 0;
  expect(store.refresh()).toEqual({ refreshed: ["hall_light"], failed: [] });
  expect(store.get("hall_light")).toEqual(saved);
  expect(store.getSource("hall_light").versions).toHaveLength(1);
  expect(events).toEqual([changed("hall_light")]);
});

test("refreshing names an automation that no longer compiles and leaves it as it was", async () => {
  const current: Registry = { ...REGISTRY, entities: [...REGISTRY.entities] };
  const { store, events } = await setup(() => current);
  const saved = store.save("hall_light", HALL).automation;
  current.entities = current.entities.filter((e) => e.id !== "light.hall");
  events.length = 0;
  const { refreshed, failed } = store.refresh();
  expect(refreshed).toEqual([]);
  expect(failed).toEqual([{ id: "hall_light", message: expect.any(String) }]);
  expect(failed[0]?.message).not.toBe("");
  expect(store.get("hall_light")).toEqual(saved);
  expect(events).toEqual([]);
});
