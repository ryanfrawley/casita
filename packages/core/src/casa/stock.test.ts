import { describe, expect, test } from "bun:test";
import type { Domain } from "../types.ts";
import type { Registry } from "./check.ts";
import { compile } from "./compile.ts";
import { EMPTY_HOUSE_HINT, stockHome } from "./stock.ts";

const registry = (ids: string[], areas: string[] = [], devices: string[] = []): Registry => ({
  entities: ids.map((id) => ({ id, domain: id.split(".")[0] as Domain })),
  areas: areas.map((id) => ({ id, name: id })),
  devices: devices.map((id) => ({ id, name: id })),
  icons: ["lightbulb", "car", "thermometer"],
});

const compiled = (reg: Registry) =>
  compile({ source: stockHome(), registry: reg, requirePage: true });

describe("stockHome", () => {
  test("compiles against an empty house without a diagnostic", () => {
    const result = compiled(registry([]));
    expect(result.diagnostics).toEqual([]);
    expect(result.themeRefs).toEqual([]);
  });

  test("compiles against a furnished house the same way", () => {
    const result = compiled(
      registry(
        ["weather.home", "light.lamp", "climate.hall", "sensor.outside", "lock.front"],
        ["kitchen", "hall"],
        ["d1", "d2"],
      ),
    );
    expect(result.diagnostics).toEqual([]);
  });

  test("names nothing in the house, so it fits any house", () => {
    const source = stockHome();
    expect(source).not.toMatch(/\b(area|device|light|sensor|weather)\.[a-z0-9_]+/);
  });

  test("finds the weather and the house as they are, not as they were", () => {
    const source = stockHome();
    expect(source).toContain(
      'Forecast { weather: first(filter(entities, (e) => e.domain == "weather"))',
    );
    expect(source).toContain("for a in sort(areas, (a) => a.name) { AreaCard { of: a  span: 3 } }");
    expect(source).toContain(
      'Area { name: "Not in a room"  when: any(entities, (e) => e.area == null)',
    );
    expect(source).toContain("when: count(entities) == 0");
    expect(source).toContain(JSON.stringify(EMPTY_HOUSE_HINT));
    expect(source).not.toMatch(/legacy|before Casa|arranged/i);
  });

  test("is the same text every time", () => {
    expect(stockHome()).toBe(stockHome());
  });
});
