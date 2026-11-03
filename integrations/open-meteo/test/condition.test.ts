import { describe, expect, test } from "bun:test";
import type { WeatherCondition } from "@casita/core/types";
import { condition, severity, worst } from "../src/condition.ts";

describe("condition", () => {
  test.each<[number, WeatherCondition]>([
    [0, "clear"],
    [1, "clear"],
    [2, "partly-cloudy"],
    [3, "overcast"],
    [45, "fog"],
    [48, "fog"],
    [51, "drizzle"],
    [53, "drizzle"],
    [55, "drizzle"],
    [56, "drizzle"],
    [57, "drizzle"],
    [61, "rain"],
    [63, "rain"],
    [65, "pouring"],
    [66, "rain"],
    [67, "pouring"],
    [71, "snow"],
    [73, "snow"],
    [75, "snow"],
    [77, "snow"],
    [80, "rain"],
    [81, "rain"],
    [82, "pouring"],
    [85, "snow"],
    [86, "snow"],
    [95, "thunderstorm"],
    [96, "thunderstorm"],
    [99, "thunderstorm"],
  ])("WMO code %i by day is %s", (code, expected) => {
    expect(condition(code, true)).toBe(expected);
  });

  test.each<[number, WeatherCondition]>([
    [0, "clear-night"],
    [1, "clear-night"],
    [2, "partly-cloudy-night"],
  ])("WMO code %i at night is %s", (code, expected) => {
    expect(condition(code, false)).toBe(expected);
  });

  test.each([3, 45, 61, 65, 71, 95])(
    "WMO code %i reads the same by night as by day, having no night picture",
    (code) => {
      expect(condition(code, false)).toBe(condition(code, true));
    },
  );

  test.each([4, 10, 50, 100, -1, 2.5, Number.NaN])("an unknown code %p is cloudy", (code) => {
    expect(condition(code, true)).toBe("cloudy");
    expect(condition(code, false)).toBe("cloudy");
  });

  test("no code at all is cloudy, by day and by night", () => {
    expect(condition(undefined, true)).toBe("cloudy");
    expect(condition(undefined, false)).toBe("cloudy");
  });
});

/** Least to most severe, a night sky beside its day one. */
const ORDER: WeatherCondition[][] = [
  ["clear", "clear-night"],
  ["partly-cloudy", "partly-cloudy-night"],
  ["cloudy"],
  ["overcast"],
  ["haze"],
  ["fog"],
  ["windy"],
  ["drizzle"],
  ["rain"],
  ["pouring"],
  ["snow"],
  ["hail"],
  ["thunderstorm"],
  ["tornado"],
];
// Every condition the core knows, so typecheck fails if one is added without a rank here.
const ALL: Record<WeatherCondition, true> = {
  clear: true,
  "clear-night": true,
  "partly-cloudy": true,
  "partly-cloudy-night": true,
  cloudy: true,
  overcast: true,
  fog: true,
  haze: true,
  drizzle: true,
  rain: true,
  pouring: true,
  snow: true,
  hail: true,
  thunderstorm: true,
  windy: true,
  tornado: true,
};

describe("severity", () => {
  test("every condition has a rank", () => {
    for (const c of Object.keys(ALL) as WeatherCondition[])
      expect(severity(c)).toBeGreaterThanOrEqual(0);
    expect(ORDER.flat().sort() as string[]).toEqual(Object.keys(ALL).sort());
  });

  test("ranks run from a clear sky to a tornado, each step more severe than the last", () => {
    const ranks = ORDER.map((group) => severity(group[0] as WeatherCondition));
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1] as number);
  });

  test.each<[WeatherCondition, WeatherCondition]>([
    ["clear-night", "clear"],
    ["partly-cloudy-night", "partly-cloudy"],
  ])("%s ranks the same as %s", (night, day) => {
    expect(severity(night)).toBe(severity(day));
  });
});

describe("worst", () => {
  test("nothing to choose from is undefined", () => {
    expect(worst([])).toBeUndefined();
  });

  test("one condition is itself", () => {
    expect(worst(["fog"])).toBe("fog");
  });

  test("picks the most severe wherever it is", () => {
    expect(worst(["clear", "rain", "cloudy"])).toBe("rain");
    expect(worst(["thunderstorm", "clear", "drizzle"])).toBe("thunderstorm");
    expect(worst(["clear", "partly-cloudy", "snow"])).toBe("snow");
  });

  test("follows the order end to end: each condition beats every one before it", () => {
    const flat = ORDER.map((group) => group[0] as WeatherCondition);
    for (let i = 1; i < flat.length; i++) {
      expect(worst(flat.slice(0, i + 1))).toBe(flat[i] as WeatherCondition);
      expect(worst(flat.slice(0, i + 1).reverse())).toBe(flat[i] as WeatherCondition);
    }
  });

  test("of equals, the earliest wins", () => {
    expect(worst(["rain", "rain"])).toBe("rain");
    expect(worst(["clear-night", "clear"])).toBe("clear-night");
    expect(worst(["clear", "clear-night"])).toBe("clear");
    expect(worst(["partly-cloudy-night", "partly-cloudy", "clear"])).toBe("partly-cloudy-night");
    expect(worst(["clear", "partly-cloudy", "partly-cloudy-night"])).toBe("partly-cloudy");
  });

  test("a night sky is no less severe than its day one, nor more", () => {
    expect(worst(["clear-night", "partly-cloudy"])).toBe("partly-cloudy");
    expect(worst(["partly-cloudy-night", "clear"])).toBe("partly-cloudy-night");
    expect(worst(["clear-night", "cloudy"])).toBe("cloudy");
  });

  test("takes any iterable, a generator included", () => {
    function* skies(): Generator<WeatherCondition> {
      yield "clear";
      yield "hail";
      yield "snow";
    }
    expect(worst(skies())).toBe("hail");
    expect(worst(new Set<WeatherCondition>(["windy", "fog"]))).toBe("windy");
  });
});
