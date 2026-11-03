import { describe, expect, test } from "bun:test";
import type { EntityId, EntityState, StateRecord } from "../types.ts";
import { overridden, pretending, pretendOne } from "./pretend.ts";
import { type Host, UNAVAILABLE } from "./values.ts";

const rec = (
  id: string,
  state: EntityState,
  attributes?: StateRecord["attributes"],
): StateRecord => ({
  entityId: id as EntityId,
  state,
  ...(attributes ? { attributes } : {}),
  available: true,
  changedAt: 1_000,
  updatedAt: 2_000,
});

const WEATHER = rec(
  "weather.home",
  { domain: "weather", condition: "clear", temperature: 9 },
  { conditionNext12h: "clear", uv: 3 },
);

describe("overridden", () => {
  test("weather: the member is the condition, kebab-cased, its other fields kept", () => {
    expect(overridden(WEATHER, "weather.home", "PartlyCloudyNight")).toEqual({
      ...WEATHER,
      state: { domain: "weather", condition: "partly-cloudy-night", temperature: 9 },
    });
  });

  test("weather: a one-word member is the lowercase condition", () => {
    expect(overridden(WEATHER, "weather.home", "Rain").state).toMatchObject({ condition: "rain" });
  });

  test("Unavailable makes the record unavailable and keeps its state", () => {
    const out = overridden(WEATHER, "weather.home", UNAVAILABLE);
    expect(out.available).toBe(false);
    expect(out.state).toBe(WEATHER.state);
  });

  test("with no record, one is made for the entity", () => {
    const out = overridden(undefined, "sensor.x", 21);
    expect(out).toMatchObject({
      entityId: "sensor.x",
      state: { domain: "sensor", value: 21 },
      available: true,
    });
  });
});

describe("pretendOne", () => {
  test("a plain id overrides the entity's value", () => {
    expect(pretendOne(WEATHER, "weather.home", "Fog")).toEqual(
      overridden(WEATHER, "weather.home", "Fog"),
    );
  });

  test("id#attr sets that attribute and keeps the state and the other attributes", () => {
    expect(pretendOne(WEATHER, "weather.home#conditionNext12h", "rain")).toEqual({
      ...WEATHER,
      attributes: { conditionNext12h: "rain", uv: 3 },
    });
  });

  test("id#attr adds an attribute the record does not have", () => {
    const bare = rec("sensor.x", { domain: "sensor", value: 1 });
    expect(pretendOne(bare, "sensor.x#battery", 12).attributes).toEqual({ battery: 12 });
  });

  test("Unavailable on an attribute is null, as plain data", () => {
    const out = pretendOne(WEATHER, "weather.home#uv", UNAVAILABLE);
    expect(out.attributes).toEqual({ conditionNext12h: "clear", uv: null });
    expect(out.available).toBe(true);
  });

  test("with no record, one is made for the entity and given the attribute", () => {
    const out = pretendOne(undefined, "sensor.x#battery", 12);
    expect(out).toMatchObject({
      entityId: "sensor.x",
      state: { domain: "sensor" },
      attributes: { battery: 12 },
      available: true,
    });
  });

  test("the record passed in is not changed", () => {
    const before = structuredClone(WEATHER);
    pretendOne(WEATHER, "weather.home#uv", 9);
    pretendOne(WEATHER, "weather.home", "Rain");
    expect(WEATHER).toEqual(before);
  });
});

describe("pretending", () => {
  const HALL = rec("light.hall", { domain: "light", on: false, brightness: 0.4 }, { scene: "x" });
  const HALLWAY = rec("light.hallway", { domain: "light", on: false });
  const records: Record<string, StateRecord> = {
    "weather.home": WEATHER,
    "light.hall": HALL,
    "light.hallway": HALLWAY,
  };
  const base = (): Host =>
    ({
      state: (id: string) => records[id],
      entities: () => [],
      timezone: "Europe/Dublin",
      now: () => 42,
    }) as unknown as Host;

  test("an id's value and attributes are all applied", () => {
    const host = pretending(base(), {
      "light.hall": "On",
      "light.hall#scene": "evening",
      "light.hall#extra": 1,
    });
    expect(host.state("light.hall")).toEqual({
      ...HALL,
      state: { domain: "light", on: true, brightness: 0.4 },
      attributes: { scene: "evening", extra: 1 },
    });
  });

  test("the order of the keys does not matter: a value after an attribute keeps it", () => {
    const host = pretending(base(), { "light.hall#scene": "evening", "light.hall": "On" });
    expect(host.state("light.hall")).toMatchObject({
      state: { on: true },
      attributes: { scene: "evening" },
    });
  });

  test("other ids, including ones the pretended id is a prefix of, read as reported", () => {
    const host = pretending(base(), { "light.hall": "On", "weather.home#uv": 8 });
    expect(host.state("light.hallway")).toBe(HALLWAY);
    expect(host.state("sensor.none")).toBeUndefined();
    expect(host.state("weather.home")?.attributes).toEqual({ conditionNext12h: "clear", uv: 8 });
    expect(host.state("weather.home")?.state).toBe(WEATHER.state);
    // A longer id that starts with the one read is another entity.
    expect(pretending(base(), { "light.hallway": "On" }).state("light.hall")).toBe(HALL);
  });

  test("an entity with no state can be pretended", () => {
    const host = pretending(base(), { "sensor.none": 5 });
    expect(host.state("sensor.none")?.state).toEqual({ domain: "sensor", value: 5 });
  });

  test("the host's other methods and fields are left alone", () => {
    const inner = base();
    const host = pretending(inner, { "light.hall": "On" });
    expect(host.timezone).toBe("Europe/Dublin");
    expect(host.now()).toBe(42);
    expect(host.entities()).toEqual([]);
    expect(inner.state("light.hall")).toBe(HALL);
  });

  test("with nothing pretended, every record is the host's own", () => {
    const host = pretending(base(), {});
    expect(host.state("light.hall")).toBe(HALL);
  });
});
