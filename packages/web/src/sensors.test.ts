import { describe, expect, test } from "bun:test";
import { compile, type Registry } from "@casita/core/casa";
import {
  SENSOR_TEMPLATES,
  sensorIdOf,
  sensorNameProblem,
  templateSource,
  words,
} from "./sensors.ts";

const REGISTRY: Registry = {
  entities: [
    { id: "binary_sensor.hall_door", domain: "binary_sensor", name: "Hall door" },
    { id: "lock.front", domain: "lock", name: "Front door" },
    { id: "sensor.living_temp", domain: "sensor", name: "Living" },
  ],
  areas: [],
  devices: [],
};

describe("words", () => {
  test("spaces a PascalCase name into an entity's name", () => {
    expect(words("KitchenDoor")).toBe("Kitchen door");
    expect(words("HouseTemp")).toBe("House temp");
    expect(words("HVACNight")).toBe("HVAC night");
    expect(words("Warm")).toBe("Warm");
  });
});

describe("sensorNameProblem", () => {
  test("wants a PascalCase name whose id is free", () => {
    expect(sensorNameProblem("", [])).toBe("Give it a name");
    expect(sensorNameProblem("kitchen door", [])).toBe("A name is PascalCase, such as KitchenDoor");
    expect(sensorNameProblem("KitchenDoor", ["kitchen_door"])).toBe(
      "There is already a sensor kitchen_door",
    );
    expect(sensorNameProblem("KitchenDoor", ["porch"])).toBeUndefined();
    expect(sensorIdOf("KitchenDoor")).toBe("kitchen_door");
  });
});

describe("templates", () => {
  test("every template compiles against the fixture house as the sensor it names", () => {
    const pick = (domains: string[], skip: string[]) =>
      REGISTRY.entities.find((e) => domains.includes(e.domain) && !skip.includes(e.id))?.id ?? "";
    for (const template of SENSOR_TEMPLATES) {
      const picks: Record<string, string> = {};
      for (const field of template.fields) {
        picks[field.key] = pick(field.domains, Object.values(picks));
      }
      // The fixture has one numeric sensor, so the average's second reading is the first again.
      if (template.id === "average") picks.b = picks.a ?? "";
      const source = templateSource(template, "Example", picks);
      expect(source, template.id).toBeDefined();
      const result = compile({ source: source ?? "", registry: REGISTRY, sensorOnly: true });
      expect(
        result.diagnostics.map((d) => `${d.code} ${d.message}`),
        template.id,
      ).toEqual([]);
      expect(result.sensor?.name, template.id).toBe("Example");
    }
  });
});
