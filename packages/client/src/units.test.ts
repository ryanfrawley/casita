import { afterEach, expect, test } from "bun:test";
import { degrees, degreeUnit, inUnits, setUnits, toCelsius, unitSystem } from "./units.ts";

// Other test files assume metric, the default.
afterEach(() => setUnits("metric"));

test("the unit system starts as metric and follows setUnits", () => {
  expect(unitSystem()).toBe("metric");
  setUnits("imperial");
  expect(unitSystem()).toBe("imperial");
  setUnits("metric");
  expect(unitSystem()).toBe("metric");
});

test.each([
  [21.5, "°C", 70.7, "°F"],
  [100, "km", 62.137, "mi"],
  [100, "km/h", 62.137, "mph"],
  [10, "m", 32.808, "ft"],
  [10, "m/s", 22.369, "mph"],
  [2.54, "cm", 1, "in"],
  [25.4, "mm", 1, "in"],
  [2, "bar", 29.008, "psi"],
  [200, "kPa", 29.008, "psi"],
  [10, "kg", 22.046, "lb"],
  [10, "L", 2.642, "gal"],
])("imperial shows %p %s as about %p %s", (value, unit, expected, shownUnit) => {
  setUnits("imperial");
  const shown = inUnits(value, unit);
  expect(shown.unit).toBe(shownUnit);
  expect(shown.value).toBeCloseTo(expected, 3);
});

test.each([
  [70.7, "°F", 21.5, "°C"],
  [62.137, "mi", 100, "km"],
  [62.137, "mph", 100, "km/h"],
  [32.808, "ft", 10, "m"],
  [1, "in", 25.4, "mm"],
  [29.008, "psi", 2, "bar"],
  [22.046, "lb", 10, "kg"],
  [2.642, "gal", 10, "L"],
])("metric shows %p %s as about %p %s", (value, unit, expected, shownUnit) => {
  const shown = inUnits(value, unit);
  expect(shown.unit).toBe(shownUnit);
  expect(shown.value).toBeCloseTo(expected, 2);
});

test("a unit already in the system's own terms comes back as it is", () => {
  expect(inUnits(21.5, "°C")).toEqual({ value: 21.5, unit: "°C" });
  expect(inUnits(5, "km")).toEqual({ value: 5, unit: "km" });
  setUnits("imperial");
  expect(inUnits(70, "°F")).toEqual({ value: 70, unit: "°F" });
  expect(inUnits(5, "mi")).toEqual({ value: 5, unit: "mi" });
});

test("converting there and back returns the original reading", () => {
  const pairs: [number, string][] = [
    [21.5, "°C"],
    [-12.3, "°C"],
    [123.4, "km"],
    [88, "km/h"],
    [3.5, "m"],
    [2.2, "bar"],
    [75, "kg"],
    [40, "L"],
  ];
  for (const [value, unit] of pairs) {
    setUnits("imperial");
    const there = inUnits(value, unit);
    setUnits("metric");
    const back = inUnits(there.value, there.unit);
    expect(back.unit).toBe(unit);
    expect(back.value).toBeCloseTo(value, 5);
  }
});

test("−40 is the same in both scales, and freezing and boiling land where they should", () => {
  setUnits("imperial");
  expect(inUnits(-40, "°C").value).toBeCloseTo(-40, 10);
  expect(inUnits(0, "°C").value).toBe(32);
  expect(inUnits(100, "°C").value).toBe(212);
  setUnits("metric");
  expect(inUnits(-40, "°F").value).toBeCloseTo(-40, 10);
  expect(inUnits(32, "°F").value).toBe(0);
  expect(inUnits(212, "°F").value).toBe(100);
});

test("zero and negative distances convert by scale alone", () => {
  setUnits("imperial");
  expect(inUnits(0, "km").value).toBe(0);
  expect(inUnits(-10, "m").value).toBeCloseTo(-32.808, 3);
});

test("units that only look convertible, and unknown units, pass through untouched", () => {
  for (const system of ["metric", "imperial"] as const) {
    setUnits(system);
    for (const unit of ["M", "C", "F", "°c", "°f", "min", "%", "K", "kW", "", " °C", "KM"]) {
      expect(inUnits(12, unit)).toEqual({ value: 12, unit });
    }
  }
});

test("units named like Object prototype members are not mistaken for rules", () => {
  for (const system of ["metric", "imperial"] as const) {
    setUnits(system);
    for (const unit of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(inUnits(7, unit)).toEqual({ value: 7, unit });
    }
  }
});

test("degrees and degreeUnit read a Celsius temperature in the system's scale", () => {
  expect(degrees(21.5)).toBe(21.5);
  expect(degreeUnit()).toBe("°C");
  setUnits("imperial");
  expect(degrees(21.5)).toBeCloseTo(70.7, 10);
  expect(degrees(-40)).toBeCloseTo(-40, 10);
  expect(degreeUnit()).toBe("°F");
});

test("toCelsius undoes degrees in either system", () => {
  for (const system of ["metric", "imperial"] as const) {
    setUnits(system);
    for (const celsius of [-40, -0.5, 0, 18, 21.7, 37, 100]) {
      expect(toCelsius(degrees(celsius))).toBeCloseTo(celsius, 10);
    }
  }
  setUnits("imperial");
  expect(toCelsius(72)).toBeCloseTo(22.222, 3);
  setUnits("metric");
  expect(toCelsius(72)).toBe(72);
});
