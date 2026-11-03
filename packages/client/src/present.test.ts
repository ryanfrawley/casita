// The terminal-free presenter. Wording per domain is covered through the CLI's wrapper in
// packages/cli/src/present.test.ts; this file covers what the client adds: the `was` field for an
// unavailable entity, and output that is plain text the web app can render as it likes.

import { afterEach, describe, expect, test } from "bun:test";
import { present, type Row, type Shown, weatherWord } from "./present.ts";
import { setUnits } from "./units.ts";

const NOW = Date.UTC(2026, 9, 4, 2, 42);
const record = (state: object, extra: object = {}): Row => ({
  state,
  available: true,
  changedAt: NOW - 240_000,
  ...extra,
});
const gone = (state: object) => record(state, { available: false });

afterEach(() => {
  setUnits("metric");
});

describe("present: an unavailable entity", () => {
  test.each([
    ["a light with brightness", { domain: "light", on: true, brightness: 0.4 }, "On · 40%"],
    ["a light that was off", { domain: "light", on: false }, "Off"],
    ["a cover part open", { domain: "cover", motion: "stopped", position: 0.35 }, "35% open"],
    ["a closed cover", { domain: "cover", motion: "stopped", position: 0 }, "Closed"],
    ["a locked lock", { domain: "lock", locked: true }, "Locked"],
    ["a jammed lock", { domain: "lock", locked: true, jammed: true }, "Jammed"],
    ["a metric sensor", { domain: "sensor", value: 21.46, unit: "°C" }, "21.5 °C"],
    [
      "a sensor in Fahrenheit, shown in metric",
      { domain: "sensor", value: 70, unit: "°F" },
      "21.1 °C",
    ],
    ["a binary sensor", { domain: "binary_sensor", on: true, deviceClass: "leak" }, "Wet · 4 min"],
  ])("%s reads Unavailable, muted, and says what it was", (_, state, was) => {
    expect(present(gone(state), NOW)).toEqual({ text: "Unavailable", tone: "muted", was });
  });

  test("drops the level its last state had", () => {
    const shown = present(gone({ domain: "light", on: true, brightness: 0.4 }), NOW);
    expect(shown.level).toBeUndefined();
    expect("level" in shown).toBe(false);
    const cover = present(gone({ domain: "cover", position: 0.35 }), NOW);
    expect("level" in cover).toBe(false);
  });

  test("a sensor's last reading follows the unit system", () => {
    setUnits("imperial");
    expect(present(gone({ domain: "sensor", value: 20, unit: "°C" }), NOW).was).toBe("68 °F");
    expect(present(gone({ domain: "sensor", value: 10, unit: "km" }), NOW).was).toBe("6.2 mi");
  });

  test("a sensor with no last reading was Unknown", () => {
    expect(present(gone({ domain: "sensor", value: null, unit: "W" }), NOW).was).toBe("Unknown");
  });

  test("the text carries no CLI decoration, only the word", () => {
    const shown = present(gone({ domain: "cover", position: 0 }), NOW);
    expect(shown.text).toBe("Unavailable");
    expect(shown.text).not.toContain("╱");
    expect(shown.was).not.toContain("was");
  });
});

describe("present: an available entity", () => {
  test.each([
    ["light", { domain: "light", on: true }],
    ["cover", { domain: "cover", position: 0.5 }],
    ["lock", { domain: "lock", locked: false }],
    ["sensor", { domain: "sensor", value: 3, unit: "kW" }],
    ["climate", { domain: "climate", mode: "heat", currentTemp: 20 }],
    ["button", { domain: "button" }],
  ])("a %s has no was", (_, state) => {
    expect("was" in present(record(state), NOW)).toBe(false);
  });

  test("a record with no availability flag counts as available", () => {
    const shown = present({ state: { domain: "switch", on: true } }, NOW);
    expect(shown).toEqual({ text: "On", tone: "on" });
  });

  test("no record at all has no was", () => {
    expect(present(undefined, NOW)).toEqual({ text: "No state yet", tone: "muted" });
  });
});

describe("present: tone per domain", () => {
  test.each<[string, object, Shown["tone"]]>([
    ["light on", { domain: "light", on: true, brightness: 0.4 }, "on"],
    ["light off", { domain: "light", on: false }, "muted"],
    ["switch on", { domain: "switch", on: true }, "on"],
    ["switch off", { domain: "switch", on: false }, "muted"],
    ["cover opening", { domain: "cover", motion: "opening" }, "pending"],
    ["cover stopped mid-way", { domain: "cover" }, "plain"],
    ["cover closed", { domain: "cover", position: 0 }, "muted"],
    ["lock locked", { domain: "lock", locked: true }, "good"],
    ["lock jammed", { domain: "lock", jammed: true }, "warn"],
    ["sensor reading", { domain: "sensor", value: 1140, unit: "ppm" }, "plain"],
    ["sensor unknown", { domain: "sensor", value: null }, "muted"],
    ["motion detected", { domain: "binary_sensor", on: true, deviceClass: "motion" }, "on"],
    ["smoke detected", { domain: "binary_sensor", on: true, deviceClass: "smoke" }, "warn"],
    ["door closed", { domain: "binary_sensor", on: false, deviceClass: "door" }, "muted"],
    ["climate heating", { domain: "climate", mode: "heat" }, "on"],
    ["climate off", { domain: "climate", mode: "off" }, "muted"],
    ["button never pressed", { domain: "button" }, "muted"],
    ["button pressed", { domain: "button", pressedAt: NOW - 60_000 }, "plain"],
    ["unknown domain", { domain: "vacuum" }, "plain"],
  ])("%s is %s", (_, state, tone) => {
    expect(present(record(state), NOW).tone).toBe(tone);
  });
});

describe("present: weather", () => {
  const weather = (state: object = {}) => ({ domain: "weather", condition: "overcast", ...state });

  test.each([
    ["the condition and temperature", weather({ temperature: 11.8 }), "Overcast · 11.8°C"],
    ["a whole-degree temperature", weather({ temperature: 12 }), "Overcast · 12°C"],
    ["below freezing", weather({ condition: "snow", temperature: -3.24 }), "Snow · -3.2°C"],
    ["no temperature", weather(), "Overcast"],
    ["a null temperature", weather({ temperature: null }), "Overcast"],
    ["a clear night reads as clear", weather({ condition: "clear-night" }), "Clear"],
    [
      "a partly cloudy night",
      weather({ condition: "partly-cloudy-night", temperature: 8 }),
      "Partly cloudy · 8°C",
    ],
    ["pouring is heavy rain", weather({ condition: "pouring" }), "Heavy rain"],
    ["a condition it does not know reads as itself", weather({ condition: "sleet" }), "sleet"],
  ])("%s", (_, state, text) => {
    expect(present(record(state), NOW)).toEqual({ text, tone: "plain" });
  });

  test("in imperial, the temperature is in Fahrenheit", () => {
    setUnits("imperial");
    expect(present(record(weather({ temperature: 11.8 })), NOW).text).toBe("Overcast · 53.2°F");
    expect(present(record(weather({ temperature: -40 })), NOW).text).toBe("Overcast · -40°F");
  });

  test("unavailable reads Unavailable and says what it was", () => {
    expect(present(gone(weather({ condition: "rain", temperature: 9.5 })), NOW)).toEqual({
      text: "Unavailable",
      tone: "muted",
      was: "Rain · 9.5°C",
    });
  });

  test("weatherWord names every condition, and an unknown one by itself", () => {
    expect(weatherWord("thunderstorm")).toBe("Thunderstorm");
    expect(weatherWord("partly-cloudy")).toBe("Partly cloudy");
    expect(weatherWord("tornado")).toBe("Tornado");
    expect(weatherWord("sleet")).toBe("sleet");
    // A key Object.prototype has is not a condition.
    expect(weatherWord("toString")).toBe("toString");
  });
});

describe("present: plain text only", () => {
  // Every shape the presenter knows, available and not, in both unit systems.
  const states: object[] = [
    { domain: "light", on: true, brightness: 0.4 },
    { domain: "light", on: false },
    { domain: "switch", on: true },
    { domain: "cover", motion: "closing", position: 0.5 },
    { domain: "cover", position: 0.35 },
    { domain: "cover", position: 1 },
    { domain: "lock", locked: true },
    { domain: "lock", jammed: true },
    { domain: "sensor", value: 21.46, unit: "°C" },
    { domain: "sensor", value: "offline" },
    { domain: "sensor", value: null },
    { domain: "binary_sensor", on: true, deviceClass: "leak" },
    { domain: "binary_sensor", on: false, deviceClass: "motion" },
    { domain: "climate", mode: "heat", currentTemp: 21.5, targetTemp: 21 },
    { domain: "button", pressedAt: NOW - 600_000 },
    { domain: "button", pressedAt: NOW - 7 * 3_600_000 },
    { domain: "button" },
    { domain: "weather", condition: "rain", temperature: 9.5 },
    { domain: "vacuum", docked: true },
  ];
  const outputs = (): Shown[] => [
    present(undefined, NOW),
    ...states.flatMap((state) => [present(record(state), NOW), present(gone(state), NOW)]),
  ];
  const text = (shown: Shown) => `${shown.text}${shown.was ?? ""}`;

  test("no output contains an ANSI escape, in metric", () => {
    for (const shown of outputs()) expect(text(shown)).not.toContain("\x1b");
  });

  test("no output contains an ANSI escape, in imperial", () => {
    setUnits("imperial");
    for (const shown of outputs()) expect(text(shown)).not.toContain("\x1b");
  });

  test("no output contains the CLI's unavailable glyph", () => {
    for (const shown of outputs()) expect(text(shown)).not.toContain("╱");
  });
});

describe("present: a word that names a moment", () => {
  const sunrise = { domain: "sensor", value: "7:29 am" };
  const at = (value: unknown) => ({ attributes: { at: value } });

  test("a word sensor says when it became so", () => {
    expect(present(record(sunrise), NOW)).toEqual({ text: "7:29 am · 4 min", tone: "plain" });
  });

  test("a word with a numeric at is its own time, and gets no since", () => {
    expect(present(record(sunrise, at(NOW + 3_600_000)), NOW)).toEqual({
      text: "7:29 am",
      tone: "plain",
    });
  });

  test("an at of zero is still a moment", () => {
    expect(present(record(sunrise, at(0)), NOW).text).toBe("7:29 am");
  });

  test.each([
    ["a string at", "2026-10-04T07:29:00Z"],
    ["a null at", null],
  ])("%s is not a moment, so the since stays", (_, value) => {
    expect(present(record(sunrise, at(value)), NOW).text).toBe("7:29 am · 4 min");
  });

  test("other attributes leave the since alone", () => {
    expect(present(record(sunrise, { attributes: { kind: "sunrise" } }), NOW).text).toBe(
      "7:29 am · 4 min",
    );
  });

  test("a moment keeps its unit", () => {
    const shown = present(record({ ...sunrise, unit: "local" }, at(NOW)), NOW);
    expect(shown.text).toBe("7:29 am local");
  });

  test("a number with an at is a reading as before", () => {
    const shown = present(record({ domain: "sensor", value: 3, unit: "kW" }, at(NOW)), NOW);
    expect(shown.text).toBe("3 kW");
  });

  test("unavailable, it was the word with no since", () => {
    expect(present(record(sunrise, { available: false, ...at(NOW) }), NOW)).toEqual({
      text: "Unavailable",
      tone: "muted",
      was: "7:29 am",
    });
  });
});
