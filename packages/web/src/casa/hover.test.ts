import { describe, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { entityView } from "../model.ts";
import { EMPTY, type House } from "../store.ts";
import { describeReference } from "./hover.ts";
import type { Reference } from "./language.ts";

const NOW = 1_700_000_000_000;

const entity = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  domain: id.split(".")[0],
  name,
  integrationId: "test.main",
  capabilities: {},
  level: "control",
  controllable: true,
  ...extra,
});

const state = (id: string, state: Row, extra: Row = {}): Row => ({
  entityId: id,
  state: { domain: id.split(".")[0], ...state },
  available: true,
  changedAt: NOW - 1000,
  updatedAt: NOW - 500,
  ...extra,
});

const device = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  name,
  integrationId: "test.main",
  ...extra,
});

function house(parts: { entities?: Row[]; devices?: Row[]; areas?: Row[]; states?: Row[] }): House {
  return {
    ...EMPTY,
    entities: parts.entities ?? [],
    devices: parts.devices ?? [],
    areas: parts.areas ?? [],
    states: new Map((parts.states ?? []).map((record) => [String(record.entityId), record])),
  };
}

const ref = (kind: Reference["kind"], id: string): Reference => ({
  kind,
  id,
  from: 0,
  to: id.length,
});

const HOUSE = house({
  areas: [
    { id: "hall", name: "Hall" },
    { id: "attic", name: "Attic" },
    { id: "porch", name: "Porch" },
  ],
  devices: [
    device("dev_lamp", "Hall lamp", { manufacturer: "IKEA", model: "TRADFRI", areaId: "hall" }),
    device("dev_plug", "Plug", { manufacturer: "Aqara", areaId: "hall" }),
    device("dev_dead", "Dead switch", { areaId: "hall" }),
    device("dev_bare", "Bare device"),
  ],
  entities: [
    entity("light.hall", "Hall light", { deviceId: "dev_lamp", effectiveAreaId: "hall" }),
    entity("sensor.hall_power", "Lamp power", {
      deviceId: "dev_lamp",
      effectiveAreaId: "hall",
      controllable: false,
    }),
    entity("switch.dead", "Dead", { deviceId: "dev_dead", effectiveAreaId: "hall" }),
    entity("switch.loose", "Loose switch"),
    entity("lock.porch", "Porch lock", { effectiveAreaId: "porch" }),
  ],
  states: [
    state("light.hall", { on: true, brightness: 0.5 }),
    state("sensor.hall_power", { value: 12, unit: "W" }),
    state("switch.dead", { on: false }, { available: false }),
    state("switch.loose", { on: false }),
    state("lock.porch", { locked: true }),
  ],
});

const find = (id: string) => HOUSE.entities.find((e) => e.id === id) as Row;

describe("describeReference of an entity", () => {
  test("a known entity is found and titled by its name", () => {
    const info = describeReference(HOUSE, ref("entity", "light.hall"), NOW);
    expect(info).toMatchObject({
      kind: "entity",
      id: "light.hall",
      found: true,
      title: "Hall light",
    });
  });

  test("the first line is its domain and the summary its row would show", () => {
    const info = describeReference(HOUSE, ref("entity", "light.hall"), NOW);
    const summary = entityView(HOUSE, find("light.hall"), NOW).summary;
    expect(summary.length).toBeGreaterThan(0);
    expect(info.lines[0]).toBe(`light · ${summary}`);
  });

  test("the second line says the area and the device when it has both", () => {
    const info = describeReference(HOUSE, ref("entity", "light.hall"), NOW);
    expect(info.lines).toHaveLength(2);
    expect(info.lines[1]).toBe("in Hall · on Hall lamp");
  });

  test("an entity with an area but no device says only the area", () => {
    const info = describeReference(HOUSE, ref("entity", "lock.porch"), NOW);
    expect(info.lines[1]).toBe("in Porch");
  });

  test("an entity with neither area nor device has only the one line", () => {
    const info = describeReference(HOUSE, ref("entity", "switch.loose"), NOW);
    expect(info.lines).toHaveLength(1);
    expect(info.lines[0]?.startsWith("switch · ")).toBe(true);
  });

  test("an area id the house does not have is left out rather than shown raw", () => {
    const odd = house({
      entities: [entity("switch.x", "X", { effectiveAreaId: "nowhere" })],
      states: [state("switch.x", { on: true })],
    });
    expect(describeReference(odd, ref("entity", "switch.x"), NOW).lines).toHaveLength(1);
  });

  test("a command still waiting on the device shows its waiting text", () => {
    const pending = { ...HOUSE, pending: new Map([["light.hall", "Turning off…"]]) };
    const info = describeReference(pending, ref("entity", "light.hall"), NOW);
    expect(info.lines[0]).toBe("light · Turning off…");
  });
});

describe("describeReference of a device", () => {
  test("a known device is found and titled by its name", () => {
    const info = describeReference(HOUSE, ref("device", "dev_lamp"), NOW);
    expect(info).toMatchObject({ kind: "device", id: "dev_lamp", found: true, title: "Hall lamp" });
  });

  test("its first line is the manufacturer and model", () => {
    const info = describeReference(HOUSE, ref("device", "dev_lamp"), NOW);
    expect(info.lines[0]).toBe("IKEA · TRADFRI");
  });

  test("its last line gives the area and how many entities are on it", () => {
    const info = describeReference(HOUSE, ref("device", "dev_lamp"), NOW);
    expect(info.lines[1]).toBe("in Hall · 2 entities");
  });

  test("a maker with no model is the manufacturer alone", () => {
    const info = describeReference(HOUSE, ref("device", "dev_plug"), NOW);
    expect(info.lines[0]).toBe("Aqara");
  });

  test("one entity is counted in the singular", () => {
    const info = describeReference(HOUSE, ref("device", "dev_dead"), NOW);
    expect(info.lines.at(-1)).toContain("1 entity");
    expect(info.lines.at(-1)).not.toContain("1 entities");
  });

  test("a device that is not online has its status appended", () => {
    const info = describeReference(HOUSE, ref("device", "dev_dead"), NOW);
    expect(info.lines).toEqual(["in Hall · 1 entity · unavailable"]);
  });

  test("an orphaned device says so, as its sheet does", () => {
    const orphaned = house({ devices: [device("dev_o", "Old", { orphaned: true })] });
    const info = describeReference(orphaned, ref("device", "dev_o"), NOW);
    expect(info.lines).toEqual(["0 entities · orphaned"]);
  });

  test("a device with no maker and no area has only the count line", () => {
    const info = describeReference(HOUSE, ref("device", "dev_bare"), NOW);
    expect(info.lines).toEqual(["0 entities"]);
  });
});

describe("describeReference of an area", () => {
  test("a known area is found and titled by its name", () => {
    const info = describeReference(HOUSE, ref("area", "hall"), NOW);
    expect(info).toMatchObject({ kind: "area", id: "hall", found: true, title: "Hall" });
  });

  test("it counts the devices in it and the entities whose area it is", () => {
    const info = describeReference(HOUSE, ref("area", "hall"), NOW);
    expect(info.lines).toEqual(["3 devices · 3 entities"]);
  });

  test("one of each is counted in the singular", () => {
    const one = house({
      areas: [{ id: "den", name: "Den" }],
      devices: [device("dev_d", "D", { areaId: "den" })],
      entities: [entity("switch.d", "D", { deviceId: "dev_d", effectiveAreaId: "den" })],
    });
    expect(describeReference(one, ref("area", "den"), NOW).lines).toEqual(["1 device · 1 entity"]);
  });

  test("an empty area counts none of either in the plural", () => {
    const info = describeReference(HOUSE, ref("area", "attic"), NOW);
    expect(info.lines).toEqual(["0 devices · 0 entities"]);
  });
});

describe("describeReference of something the house does not have", () => {
  for (const kind of ["entity", "device", "area"] as const) {
    test(`a missing ${kind} is not found, is titled by its id, and says so`, () => {
      const info = describeReference(HOUSE, ref(kind, "nope.nothing"), NOW);
      expect(info).toEqual({
        kind,
        id: "nope.nothing",
        found: false,
        title: "nope.nothing",
        lines: [`No ${kind} with this id is in the house.`],
      });
    });
  }

  test("a device id is not looked up among the entities", () => {
    expect(describeReference(HOUSE, ref("entity", "dev_lamp"), NOW).found).toBe(false);
    expect(describeReference(HOUSE, ref("device", "light.hall"), NOW).found).toBe(false);
  });
});
