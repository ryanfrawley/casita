import { describe, expect, test } from "bun:test";
import { isUnavailable } from "@casita/core/casa";
import { EMPTY, type House } from "../store.ts";
import { parseOverride, registryOf } from "./page-editor.tsx";

describe("parseOverride", () => {
  test("an empty or blank field is no override", () => {
    expect(parseOverride("")).toBeUndefined();
    expect(parseOverride("   ")).toBeUndefined();
  });

  test("unavailable, in any case, is the unavailable value", () => {
    for (const text of ["unavailable", "Unavailable", "UNAVAILABLE", "  unavailable "]) {
      expect(isUnavailable(parseOverride(text))).toBe(true);
    }
  });

  test("a number is a number", () => {
    expect(parseOverride("21.5")).toBe(21.5);
    expect(parseOverride("-3")).toBe(-3);
    expect(parseOverride("0")).toBe(0);
    expect(parseOverride(" 7 ")).toBe(7);
  });

  test("an enum value is its name, with or without the dot", () => {
    expect(parseOverride(".On")).toBe("On");
    expect(parseOverride("On")).toBe("On");
    expect(parseOverride("Closed")).toBe("Closed");
  });

  test("true and false are booleans", () => {
    expect(parseOverride("true")).toBe(true);
    expect(parseOverride("false")).toBe(false);
  });

  test("anything else is the text as typed, trimmed", () => {
    expect(parseOverride("hello")).toBe("hello");
    expect(parseOverride("  two words ")).toBe("two words");
    // Not quite a number: kept as text.
    expect(parseOverride("1e3")).toBe("1e3");
    expect(parseOverride(".5")).toBe(".5");
  });
});

describe("registryOf", () => {
  const house = (integrations: House["integrations"]): House => ({ ...EMPTY, integrations });
  const LED = { name: "led_notify", schema: { type: "object", properties: {} } };

  test("no integrations listed is none known, so `run` goes unchecked", () => {
    expect(registryOf(house([])).integrations).toBeUndefined();
  });

  test("each instance by its id; a running one's actions, as listed", () => {
    expect(
      registryOf(
        house([
          { integrationId: "zwave-js.main", status: "running", actions: [LED] },
          { integrationId: "mqtt.main", status: "running", actions: [] },
        ]),
      ).integrations,
    ).toEqual([
      { id: "zwave-js.main", actions: [LED] },
      { id: "mqtt.main", actions: [] },
    ]);
  });

  test("an instance that isn't running is known, but not what it offers", () => {
    for (const status of ["starting", "error", "stopped"]) {
      expect(
        registryOf(house([{ integrationId: "zwave-js.main", status, actions: [LED] }]))
          .integrations,
      ).toEqual([{ id: "zwave-js.main", actions: undefined }]);
    }
  });

  test("a running instance listed without actions offers none known", () => {
    expect(registryOf(house([{ integrationId: "hue.2", status: "running" }])).integrations).toEqual(
      [{ id: "hue.2", actions: undefined }],
    );
  });
});
