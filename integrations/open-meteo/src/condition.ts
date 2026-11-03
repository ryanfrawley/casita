// WMO weather codes (the ones Open-Meteo reports) as the core's weather conditions, and
// which of several conditions is the most severe.

import type { WeatherCondition } from "@casita/core/types";

const CONDITIONS: Record<number, WeatherCondition> = {
  0: "clear",
  1: "clear", // mainly clear
  2: "partly-cloudy",
  3: "overcast",
  45: "fog",
  48: "fog", // depositing rime
  51: "drizzle",
  53: "drizzle",
  55: "drizzle",
  56: "drizzle", // freezing
  57: "drizzle",
  61: "rain",
  63: "rain",
  65: "pouring",
  66: "rain", // freezing
  67: "pouring",
  71: "snow",
  73: "snow",
  75: "snow",
  77: "snow", // snow grains
  80: "rain", // showers
  81: "rain",
  82: "pouring",
  85: "snow", // snow showers
  86: "snow",
  95: "thunderstorm",
  96: "thunderstorm", // with hail
  99: "thunderstorm",
};

const NIGHT: Partial<Record<WeatherCondition, WeatherCondition>> = {
  clear: "clear-night",
  "partly-cloudy": "partly-cloudy-night",
};

/** A code this table does not know reads as cloudy, the least that can be said of a sky. */
export function condition(code: number | undefined, isDay: boolean): WeatherCondition {
  const known = code === undefined ? undefined : CONDITIONS[code];
  const day = known ?? "cloudy";
  return isDay ? day : (NIGHT[day] ?? day);
}

/** Least to most severe; a night sky ranks as its day one. */
const SEVERITY: readonly WeatherCondition[][] = [
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

export const severity = (c: WeatherCondition): number =>
  SEVERITY.findIndex((rank) => rank.includes(c));

/** The most severe of these conditions; the earliest of equals. Undefined for none. */
export function worst(conditions: Iterable<WeatherCondition>): WeatherCondition | undefined {
  let found: WeatherCondition | undefined;
  for (const c of conditions) if (found === undefined || severity(c) > severity(found)) found = c;
  return found;
}
