// The sun's height: the real one from a place and a moment, the stand-in for when the place is
// not known, and the easing that keeps a deep night from dwarfing the day.

import { describe, expect, test } from "bun:test";
import { eased, modelElevation, SUNRISE_ELEVATION, solarElevation } from "./sun-math.ts";

const HOUR = 3_600_000;

describe("solarElevation", () => {
  // Seattle (Redmond) on Saturday 10 October 2026, with Open-Meteo's sunrise and sunset for it.
  const LAT = 47.74922;
  const LON = -122.103131;
  const RISE = 1_791_642_027_000;
  const SET = 1_791_682_165_000;

  test("at Open-Meteo's sunrise and sunset the sun's centre is where an official one is", () => {
    expect(Math.abs(solarElevation(RISE, LAT, LON) - SUNRISE_ELEVATION)).toBeLessThan(0.1);
    expect(Math.abs(solarElevation(SET, LAT, LON) - SUNRISE_ELEVATION)).toBeLessThan(0.1);
  });

  test("half way between them is solar noon, about 35.4° up in mid October", () => {
    expect(Math.abs(solarElevation((RISE + SET) / 2, LAT, LON) - 35.4)).toBeLessThan(0.2);
  });

  test("twelve hours after noon it is about 49° down", () => {
    const midnight = (RISE + SET) / 2 + 12 * HOUR;
    expect(Math.abs(solarElevation(midnight, LAT, LON) + 49)).toBeLessThan(0.5);
  });

  test("it is above the horizon by day and below it by night", () => {
    expect(solarElevation(RISE + HOUR, LAT, LON)).toBeGreaterThan(0);
    expect(solarElevation(SET - HOUR, LAT, LON)).toBeGreaterThan(0);
    expect(solarElevation(RISE - HOUR, LAT, LON)).toBeLessThan(SUNRISE_ELEVATION);
    expect(solarElevation(SET + HOUR, LAT, LON)).toBeLessThan(SUNRISE_ELEVATION);
  });

  test("at the equator at an equinox noon it is all but overhead", () => {
    // 20 March 2026: the equinox is at 14:46 UTC, and noon on the Greenwich meridian comes
    // about seven minutes late by the equation of time. The declination is a fraction of a degree.
    const noon = Date.UTC(2026, 2, 20, 12, 7);
    const elevation = solarElevation(noon, 0, 0);
    expect(elevation).toBeGreaterThan(89.5);
    expect(elevation).toBeLessThanOrEqual(90);
  });

  test("in the polar night it never rises, all day", () => {
    // Longyearbyen, Svalbard, at the December solstice.
    for (let h = 0; h < 24; h += 0.25) {
      expect(solarElevation(Date.UTC(2026, 11, 21) + h * HOUR, 78.22, 15.65)).toBeLessThan(0);
    }
  });

  test("in the midnight sun it never sets", () => {
    // The same place at the June solstice.
    for (let h = 0; h < 24; h += 0.25) {
      expect(solarElevation(Date.UTC(2026, 5, 21) + h * HOUR, 78.22, 15.65)).toBeGreaterThan(0);
    }
  });

  test("it is always an angle between straight down and straight up", () => {
    for (const [lat, lon] of [
      [90, 0],
      [-90, 0],
      [0, 180],
      [0, -180],
    ] as const) {
      for (let h = 0; h < 24; h += 3) {
        const elevation = solarElevation(Date.UTC(2026, 5, 21) + h * HOUR, lat, lon);
        expect(elevation).toBeGreaterThanOrEqual(-90);
        expect(elevation).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe("SUNRISE_ELEVATION", () => {
  test("is 50′ below the horizon: 34′ of refraction and 16′ of the sun's half width", () => {
    expect(SUNRISE_ELEVATION).toBe(-0.833);
  });
});

describe("modelElevation", () => {
  test("crosses the sunrise elevation at sunrise and sunset", () => {
    expect(modelElevation(0.25, 0.25, 0.75)).toBeCloseTo(SUNRISE_ELEVATION);
    expect(modelElevation(0.75, 0.25, 0.75)).toBeCloseTo(SUNRISE_ELEVATION);
    // A day not centred on noon crosses at its own ends.
    expect(modelElevation(0.3, 0.3, 0.8)).toBeCloseTo(SUNRISE_ELEVATION);
    expect(modelElevation(0.8, 0.3, 0.8)).toBeCloseTo(SUNRISE_ELEVATION);
  });

  test("peaks half way between them", () => {
    const peak = modelElevation(0.55, 0.3, 0.8);
    for (const t of [0.3, 0.4, 0.5, 0.54, 0.56, 0.6, 0.7, 0.8]) {
      expect(modelElevation(t, 0.3, 0.8)).toBeLessThan(peak);
    }
    // Scaled to read like a mid-latitude day: 40° above the sunrise elevation.
    expect(peak).toBeCloseTo(40 + SUNRISE_ELEVATION);
  });

  test("is the same either side of the peak", () => {
    expect(modelElevation(0.4, 0.25, 0.75)).toBeCloseTo(modelElevation(0.6, 0.25, 0.75));
    expect(modelElevation(0.1, 0.25, 0.75)).toBeCloseTo(modelElevation(0.9, 0.25, 0.75));
  });

  test("is above the sunrise elevation by day and below it by night", () => {
    for (const t of [0.3, 0.5, 0.7]) {
      expect(modelElevation(t, 0.25, 0.75)).toBeGreaterThan(SUNRISE_ELEVATION);
    }
    for (const t of [0, 0.1, 0.2, 0.8, 0.9, 1]) {
      expect(modelElevation(t, 0.25, 0.75)).toBeLessThan(SUNRISE_ELEVATION);
    }
  });

  test("is deepest half a day from its peak, across midnight", () => {
    // A 12-hour day centred on noon is deepest at both midnights.
    expect(modelElevation(0, 0.25, 0.75)).toBeCloseTo(modelElevation(1, 0.25, 0.75));
    expect(modelElevation(0, 0.25, 0.75)).toBeLessThan(modelElevation(0.05, 0.25, 0.75));
  });

  test("a day with no length gives a finite curve, on the horizon at its moment", () => {
    expect(modelElevation(0.5, 0.5, 0.5)).toBeCloseTo(SUNRISE_ELEVATION);
    expect(Number.isFinite(modelElevation(0, 0.5, 0.5))).toBe(true);
    expect(modelElevation(0, 0.5, 0.5)).toBeLessThan(SUNRISE_ELEVATION);
  });
});

describe("eased", () => {
  test("above the sunrise elevation it is the height above it, unchanged", () => {
    expect(eased(SUNRISE_ELEVATION)).toBe(0);
    expect(eased(10)).toBeCloseTo(10 - SUNRISE_ELEVATION);
    expect(eased(60)).toBeCloseTo(60 - SUNRISE_ELEVATION);
  });

  test("below it, it stays below zero, and a lower sun is still lower", () => {
    let last = 0;
    for (const elevation of [-1, -5, -20, -45, -70, -90]) {
      const height = eased(elevation);
      expect(height).toBeLessThan(last);
      last = height;
    }
  });

  test("it runs through the horizon without a step", () => {
    const eps = 1e-6;
    expect(eased(SUNRISE_ELEVATION - eps)).toBeCloseTo(0, 5);
    expect(eased(SUNRISE_ELEVATION + eps)).toBeCloseTo(0, 5);
  });

  test("its slope is 1 on both sides of the horizon, so there is no corner", () => {
    const eps = 1e-4;
    const below = (eased(SUNRISE_ELEVATION) - eased(SUNRISE_ELEVATION - eps)) / eps;
    const above = (eased(SUNRISE_ELEVATION + eps) - eased(SUNRISE_ELEVATION)) / eps;
    expect(below).toBeCloseTo(1, 3);
    expect(above).toBeCloseTo(1, 3);
  });

  test("far below, it is held to the depth", () => {
    expect(eased(-90)).toBeGreaterThan(-30);
    expect(eased(-1000)).toBeCloseTo(-30);
    // A night 60° deep is eased to less than the depth, not twice a 30° day.
    expect(Math.abs(eased(-60))).toBeLessThan(eased(30));
  });

  test("the depth can be given", () => {
    expect(eased(-1000, 10)).toBeCloseTo(-10);
    expect(eased(-90, 10)).toBeGreaterThan(-10);
    // It changes only the night.
    expect(eased(20, 10)).toBe(eased(20));
  });
});
