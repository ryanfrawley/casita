// The health scales: which band a reading is in, and where it is drawn along a track that gives
// every band an equal share.

import { describe, expect, test } from "bun:test";
import { placeOn, SCALES, type ScaleName } from "./scales.ts";

const label = (scale: ScaleName, value: number) => placeOn(SCALES[scale], value).label;
const position = (scale: ScaleName, value: number) => placeOn(SCALES[scale], value).position;

describe("placeOn: band edges", () => {
  test.each<[ScaleName, number, string]>([
    ["pm25", 0, "Good"],
    ["pm25", 9, "Good"],
    ["pm25", 9.1, "Moderate"],
    ["pm25", 35.4, "Moderate"],
    ["pm25", 35.5, "Sensitive groups"],
    ["pm25", 125.5, "Very unhealthy"],
    ["pm25", 325.4, "Hazardous"],
    ["pm10", 54, "Good"],
    ["pm10", 55, "Moderate"],
    ["uv", 2, "Low"],
    // A reading is rounded to the scale's decimals first, as the WHO rounds UV: 2.49 is 2.
    ["uv", 2.49, "Low"],
    ["uv", 2.5, "Moderate"],
    ["uv", 2.99, "Moderate"],
    ["uv", 3, "Moderate"],
    ["pm25", 9.04, "Good"],
    ["pm25", 9.05, "Moderate"],
    ["uv", 8, "Very high"],
    ["uv", 11, "Extreme"],
    ["aqi", 50, "Good"],
    ["aqi", 51, "Moderate"],
    ["aqi", 301, "Hazardous"],
    ["eaqi", 20, "Good"],
    ["eaqi", 21, "Fair"],
    ["eaqi", 100.5, "Extremely poor"],
  ])("%s %d is %s", (scale, value, expected) => {
    expect(label(scale, value)).toBe(expected);
  });

  test("the band's index and tone come with its word", () => {
    expect(placeOn(SCALES.pm25, 40)).toMatchObject({ band: 2, label: "Sensitive groups", tone: 3 });
    expect(placeOn(SCALES.uv, 1)).toMatchObject({ band: 0, label: "Low", tone: 1 });
  });
});

describe("placeOn: position", () => {
  test("zero is the start of the track", () => {
    expect(position("pm25", 0)).toBe(0);
    expect(position("aqi", 0)).toBe(0);
  });

  test("a band's upper bound is the end of its share", () => {
    // PM2.5 has six bands, so each is a sixth of the track.
    expect(position("pm25", 9)).toBeCloseTo(1 / 6);
    expect(position("pm25", 35.4)).toBeCloseTo(2 / 6);
    expect(position("pm25", 325.4)).toBeCloseTo(1);
    // UV has five.
    expect(position("uv", 2)).toBeCloseTo(1 / 5);
    expect(position("uv", 14)).toBeCloseTo(1);
  });

  test("the middle of a band is the middle of its share", () => {
    expect(position("aqi", 25)).toBeCloseTo(0.5 / 6);
    expect(position("aqi", 75)).toBeCloseTo(1.5 / 6);
    // PM2.5's Unhealthy band runs from 55.4 to 125.4.
    expect(position("pm25", 90.4)).toBeCloseTo(3.5 / 6);
  });

  test("the position runs linearly within a band, however wide the band is", () => {
    // A quarter into the narrow first band and a quarter into the wide fifth.
    expect(position("pm25", 2.25)).toBeCloseTo(0.25 / 6);
    expect(position("pm25", 125.4 + 25)).toBeCloseTo(4.25 / 6);
  });

  test("the position never goes back as the value rises", () => {
    for (const scale of Object.keys(SCALES) as ScaleName[]) {
      let last = -1;
      for (let value = 0; value <= 700; value += 0.5) {
        const now = position(scale, value);
        expect(now).toBeGreaterThanOrEqual(last);
        last = now;
      }
    }
  });
});

describe("placeOn: out of range", () => {
  test("a value past the last band is in the last band, at the end of the track", () => {
    expect(placeOn(SCALES.pm25, 500)).toEqual({
      band: 5,
      label: "Hazardous",
      tone: 6,
      position: 1,
    });
    expect(placeOn(SCALES.uv, 20)).toEqual({ band: 4, label: "Extreme", tone: 5, position: 1 });
    expect(position("aqi", Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("a value that is not a number is at the start, never NaN along the track", () => {
    expect(placeOn(SCALES.uv, Number.NaN)).toEqual({ band: 0, label: "Low", tone: 1, position: 0 });
  });

  test("a negative value is in the first band, at the start of the track", () => {
    expect(placeOn(SCALES.aqi, -5)).toEqual({ band: 0, label: "Good", tone: 1, position: 0 });
    expect(position("uv", -0.01)).toBe(0);
  });
});

describe("SCALES", () => {
  test.each(Object.entries(SCALES))("%s's bands strictly increase", (_, scale) => {
    const bounds = scale.bands.map((band) => band.upTo);
    expect(bounds[0]).toBeGreaterThan(0);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i] as number).toBeGreaterThan(bounds[i - 1] as number);
    }
  });

  test.each(Object.entries(SCALES))("%s's tones run from 1 up a step a band", (_, scale) => {
    expect(scale.bands.map((band) => band.tone as number)).toEqual(
      scale.bands.map((_, i) => i + 1),
    );
  });

  test("the particle scales are in µg/m³ and the indexes have no unit", () => {
    expect(SCALES.pm25.unit).toBe("µg/m³");
    expect(SCALES.pm10.unit).toBe("µg/m³");
    expect([SCALES.uv.unit, SCALES.aqi.unit, SCALES.eaqi.unit]).toEqual(["", "", ""]);
  });

  test("each scale is titled for what it measures, the two air quality indexes alike", () => {
    expect(Object.fromEntries(Object.entries(SCALES).map(([name, s]) => [name, s.title]))).toEqual({
      uv: "UV index",
      pm25: "PM2.5",
      pm10: "PM10",
      aqi: "Air quality",
      eaqi: "Air quality",
    });
  });
});
