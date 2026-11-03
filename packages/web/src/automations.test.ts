import { describe, expect, test } from "bun:test";
import { compile, type Registry } from "@casita/core/casa";
import { automationIdOf, nameProblem, TEMPLATES, templateSource } from "./automations.ts";

const REGISTRY: Registry = {
  entities: [
    { id: "binary_sensor.hall_motion", domain: "binary_sensor", name: "Hall motion" },
    { id: "light.hall", domain: "light", name: "Hall light" },
    { id: "switch.porch", domain: "switch", name: "Porch" },
  ],
  areas: [],
  devices: [],
};

describe("automationIdOf", () => {
  test("splits PascalCase into underscores", () => {
    expect(automationIdOf("HallLight")).toBe("hall_light");
    expect(automationIdOf("Evening")).toBe("evening");
    expect(automationIdOf("Lights2Off")).toBe("lights2_off");
    expect(automationIdOf("HVACNight")).toBe("hvac_night");
  });
});

describe("nameProblem", () => {
  test("wants a PascalCase name whose id is free", () => {
    expect(nameProblem("", [])).toBe("Give it a name");
    expect(nameProblem("hall light", [])).toBe("A name is PascalCase, such as HallLight");
    expect(nameProblem("hallLight", [])).toBe("A name is PascalCase, such as HallLight");
    expect(nameProblem("HallLight", ["hall_light"])).toBe(
      "There is already an automation hall_light",
    );
    expect(nameProblem("HallLight", ["porch"])).toBeUndefined();
  });
});

describe("templates", () => {
  test("wait for every field to be picked", () => {
    const motion = TEMPLATES.find((t) => t.id === "motion");
    if (!motion) throw new Error("no motion template");
    expect(templateSource(motion, "Hall", { sensor: "binary_sensor.hall_motion" })).toBeUndefined();
    expect(
      templateSource(motion, "Hall", { sensor: "binary_sensor.hall_motion", light: "light.hall" }),
    ).toContain("after 5m { call light.hall.turn_off }");
  });

  test("every template compiles against the fixture house", () => {
    const pick = (domains: string[]) =>
      REGISTRY.entities.find((e) => domains.includes(e.domain))?.id ?? "";
    for (const template of TEMPLATES) {
      const picks = Object.fromEntries(template.fields.map((f) => [f.key, pick(f.domains)]));
      const source = templateSource(template, "Example", picks);
      expect(source, template.id).toBeDefined();
      const result = compile({ source: source ?? "", registry: REGISTRY, automationOnly: true });
      expect(
        result.diagnostics.map((d) => `${d.code} ${d.message}`),
        template.id,
      ).toEqual([]);
      expect(result.automation?.name).toBe("Example");
    }
  });
});
