import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/index.ts";
import type { Domain } from "../types.ts";
import type { Registry } from "./check.ts";
import { compile } from "./compile.ts";
import {
  homeFromLegacy,
  type LegacyArea,
  type LegacyDevice,
  type LegacyEntity,
  type LegacyHouse,
  legacyHouse,
} from "./legacy.ts";

const entity = (id: string, extra: Partial<LegacyEntity> = {}): LegacyEntity => ({
  id,
  domain: id.split(".")[0] ?? "",
  ...extra,
});

const device = (id: string, name: string, extra: Partial<LegacyDevice> = {}): LegacyDevice => ({
  id,
  name,
  ...extra,
});

const area = (id: string, name: string, extra: Partial<LegacyArea> = {}): LegacyArea => ({
  id,
  name,
  ...extra,
});

const registryOf = (house: LegacyHouse): Registry => ({
  entities: house.entities.map((e) => ({ id: e.id, domain: e.domain as Domain })),
  areas: house.areas.map((a) => ({ id: a.id, name: a.name })),
  devices: house.devices.map((d) => ({ id: d.id, name: d.name })),
  icons: ["lightbulb", "car", "thermometer"],
});

const compiled = (house: LegacyHouse) => {
  const source = homeFromLegacy(house);
  const result = compile({ source, registry: registryOf(house), requirePage: true });
  return { source, result };
};

describe("homeFromLegacy", () => {
  test("an empty house is a page of loops that fills in as things arrive", () => {
    const { source, result } = compiled({ areas: [], devices: [], entities: [], cards: [] });
    expect(result.diagnostics).toEqual([]);
    expect(source).toContain("for a in sort(areas, (a) => a.name) {");
    expect(source).toContain("AreaCard { of: a  span: 3 }");
    // Each area is headed by its own name and icon, as Home drew it.
    expect(source).toContain("Area { of: of  facts: facts");
    expect(source).not.toMatch(/\bRoom(Card)? \{/);
    expect(source).toContain('Area { name: "Not in a room"');
    expect(source).toContain("Greeting {}");
    expect(source).not.toContain("Forecast");
  });

  test("a house with nothing arranged is rooms by loop, the weather on top", () => {
    const house: LegacyHouse = {
      areas: [area("kitchen", "Kitchen"), area("hall", "Hall")],
      devices: [device("d1", "Lamp", { areaId: "kitchen" })],
      entities: [entity("weather.home"), entity("light.lamp"), entity("sensor.3d_printer")],
      cards: [],
    };
    const { source, result } = compiled(house);
    expect(result.diagnostics).toEqual([]);
    expect(source).toContain("Greeting { weather: weather.home }");
    expect(source).toContain("Forecast { weather: weather.home  when: screen != .Phone }");
    expect(source).not.toContain("area.kitchen");
    expect(result.themeRefs).toEqual([]);
  });

  test("an arranged room is written out: width, chips, cards and hidden devices", () => {
    const house: LegacyHouse = {
      areas: [
        area("kitchen", "Kitchen", { display: { columns: 2, facts: false } }),
        area("hall", "Hall"),
      ],
      devices: [
        device("d1", "Lamp", { areaId: "kitchen" }),
        device("d2", "Meter", {
          areaId: "kitchen",
          card: {
            name: "Power",
            icon: "thermometer",
            accent: "ember",
            size: "sm",
            header: false,
            activeWhen: "never",
            readings: [
              { id: "sensor.power", display: "headline", label: "Now" },
              { id: "sensor.power", display: "history", range: "week" },
              {
                id: "sensor.battery",
                display: "bar",
                tone: "sage",
                low: 20,
                target: "sensor.limit",
              },
              { id: "sensor.battery", display: "value", tone: "neutral" },
              { id: "sensor.gone", display: "row" },
              { id: "sensor.battery#voltage", display: "status" },
            ],
          },
        }),
        device("d3", "Hidden", { areaId: "kitchen", homeHidden: true }),
        device("d4", "Thing", {
          areaId: "hall",
          card: { activeWhen: "light.lamp", readings: [{ id: "light.lamp", display: "row" }] },
        }),
      ],
      entities: [
        entity("light.lamp"),
        entity("sensor.power"),
        entity("sensor.battery"),
        entity("sensor.limit"),
        entity("sensor.secret"),
        entity("climate.hall"),
      ],
      cards: [
        {
          id: "mixed",
          areaId: "hall",
          config: {
            name: "Mixed",
            accent: "lamp",
            readings: [
              { id: "sensor.power", display: "value" },
              { id: "sensor.battery", display: "bar", tone: "accent" },
            ],
          },
        },
        {
          id: "loose",
          config: { name: "Loose", readings: [{ id: "sensor.power", display: "row" }] },
        },
        {
          id: "lit",
          config: {
            name: "Lit",
            readings: [
              { id: "light.lamp", display: "row" },
              { id: "sensor.power", display: "row" },
            ],
          },
        },
      ],
    };
    const { source, result } = compiled(house);
    expect(result.diagnostics).toEqual([]);
    expect(source).toContain("Area { of: area.kitchen  span: 2  facts: false");
    expect(source).toContain(
      "for d in sort(area.kitchen.devices, (d) => d.name) where d != device.d3 && d != device.d2 { DeviceCard { of: d } }",
    );
    expect(source).not.toContain("DeviceCard { of: device.d1 }");
    expect(source).toContain(
      'Card { name: "Power"  icon: "thermometer"  accent: accents.ember  size: .Sm  header: false  active: false',
    );
    expect(source).toContain('Headline { of: sensor.power  label: "Now" }');
    expect(source).toContain("History { of: sensor.power  range: .Week }");
    expect(source).toContain(
      "Bar { of: sensor.battery  color: accents.sage  low: 20  target: sensor.limit.value }",
    );
    expect(source).toContain("Value { of: sensor.battery }");
    expect(source).not.toContain("sensor.gone");
    expect(source).toContain("Status { of: sensor.battery#voltage }");
    expect(source).toContain("active: light.lamp.value == .On");
    // A device's card with no icon chosen takes the device's own; a loose card has none.
    expect(source).toContain(
      'Card { name: "Thing"  icon: device.d4.icon  active: light.lamp.value == .On',
    );
    expect(source).toContain("Card { name: of.name  icon: of.icon  active:");
    expect(source).toContain('Card { name: "Mixed"  accent: accents.lamp  active: false');
    expect(source).toContain("Bar { of: sensor.battery }");
    expect(source).toContain(
      'Area { name: "Not in a room"  when: any(entities, (e) => e.area == null)',
    );
    expect(source).toContain('Card { name: "Loose"  active: false');
    expect(source).toContain(
      'Card { name: "Lit"  active: any([light.lamp], (e) => e.value == .On)',
    );
    expect(source).toContain(
      "for a in sort(areas, (a) => a.name) where a != area.hall && a != area.kitchen {",
    );
    expect(result.themeRefs).toEqual(["accents.ember", "accents.lamp", "accents.sage"]);
  });

  test("the same house gives the same page", () => {
    const house: LegacyHouse = {
      areas: [area("a", "A")],
      devices: [],
      entities: [entity("light.x")],
      cards: [],
    };
    expect(homeFromLegacy(house)).toBe(homeFromLegacy(house));
  });
});

describe("legacyHouse", () => {
  test("reads the arrangement from the old columns, and copes when they are gone", async () => {
    const db = await openDatabase(":memory:");
    const at = 1;
    db.query("INSERT INTO areas (id, name, created_at, display) VALUES (?, ?, ?, ?)").run(
      "kitchen",
      "Kitchen",
      at,
      JSON.stringify({ columns: 2 }),
    );
    db.query(
      `INSERT INTO devices (id, unique_id, integration_id, name, created_at, updated_at, area_id, card, home_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("d1", "u1", "test.main", "Lamp", at, at, "kitchen", JSON.stringify({ readings: [] }), 0);
    db.query(
      `INSERT INTO entities (id, unique_id, integration_id, domain, name, capabilities, created_at, updated_at, device_id, hidden, disabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("light.lamp", "u2", "test.main", "light", "Lamp", "{}", at, at, "d1", 0, 1);
    db.query(
      "INSERT INTO cards (id, area_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "mixed",
      "kitchen",
      JSON.stringify({ name: "Mixed", readings: [{ id: "light.lamp", display: "row" }] }),
      at,
      at,
    );
    expect(legacyHouse(db)).toEqual({
      areas: [{ id: "kitchen", name: "Kitchen", display: { columns: 2 } }],
      devices: [
        {
          id: "d1",
          name: "Lamp",
          areaId: "kitchen",
          card: { readings: [] },
          homeHidden: undefined,
        },
      ],
      entities: [{ id: "light.lamp", domain: "light", hidden: undefined, disabled: true }],
      cards: [
        {
          id: "mixed",
          areaId: "kitchen",
          config: { name: "Mixed", readings: [{ id: "light.lamp", display: "row" }] },
        },
      ],
    });

    // After migration 010 the columns and the table are gone; nothing was arranged.
    db.exec("ALTER TABLE areas DROP COLUMN display");
    db.exec("ALTER TABLE devices DROP COLUMN card");
    db.exec("ALTER TABLE devices DROP COLUMN home_hidden");
    db.exec("DROP TABLE cards");
    expect(legacyHouse(db)).toEqual({
      areas: [{ id: "kitchen", name: "Kitchen", display: undefined }],
      devices: [
        { id: "d1", name: "Lamp", areaId: "kitchen", card: undefined, homeHidden: undefined },
      ],
      entities: [{ id: "light.lamp", domain: "light", hidden: undefined, disabled: true }],
      cards: [],
    });
    expect(
      compile({
        source: homeFromLegacy(legacyHouse(db)),
        registry: {
          entities: [{ id: "light.lamp", domain: "light" }],
          areas: [{ id: "kitchen" }],
          devices: [{ id: "d1" }],
        },
        requirePage: true,
      }).ok,
    ).toBe(true);
    db.close();
  });
});
