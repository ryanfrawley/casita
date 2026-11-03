import { afterEach, describe, expect, test } from "bun:test";
import type { Scheduler } from "@casita/core/types";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import { type Forecast, type Hour, OpenMeteoApi } from "../src/api.ts";
import {
  ATTRIBUTION,
  conditionAhead,
  createOpenMeteoIntegration,
  daytime,
  precipitation,
} from "../src/index.ts";
import { FakeOpenMeteo, RECORDED_AT } from "./fake-cloud.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Sun times in the fixture: today's sunrise (before RECORDED_AT) and sunset, and tomorrow's sunrise. */
const SUNRISE = 1_791_209_651_000;
const SUNSET = 1_791_250_808_000;
const SUNRISE_TOMORROW = 1_791_296_135_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A scheduled callback as the integration asked for it, and whether it was cancelled since. */
interface Scheduled {
  ms: number;
  fn: () => void | Promise<void>;
  cancelled: boolean;
}

async function setup(
  config: Record<string, unknown> = {},
  prepare: (cloud: FakeOpenMeteo) => void = () => {},
  now = RECORDED_AT,
) {
  const cloud = await FakeOpenMeteo.create();
  prepare(cloud);
  const clock = { now };
  const integration = createOpenMeteoIntegration({ fetch: cloud.fetch, now: () => clock.now });
  const t = createTestContext(
    integration.configSchema.parse({ latitude: 47.6, longitude: -122.32, ...config }),
  );
  cleanups.push(() => t.abort());
  // The test context's real timers still run; this only records what was asked, so a test can
  // run the repeating poll at once instead of waiting minutes for it.
  const every: Scheduled[] = [];
  const after: Scheduled[] = [];
  const recording =
    (list: Scheduled[], real: Scheduler["every"]): Scheduler["every"] =>
    (ms, fn) => {
      const entry = { ms, fn, cancelled: false };
      list.push(entry);
      const cancel = real(ms, fn);
      return () => {
        entry.cancelled = true;
        cancel();
      };
    };
  const scheduler: Scheduler = {
    ...t.ctx.scheduler,
    every: recording(every, t.ctx.scheduler.every),
    after: recording(after, t.ctx.scheduler.after),
  };
  await integration.setup({ ...t.ctx, scheduler });
  /** Runs the repeating poll once, as its interval would. */
  const poll = async () => {
    expect(every).toHaveLength(1);
    await every[0]?.fn();
  };
  return { cloud, t, clock, every, after, poll, integration };
}

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(2);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

type Shown = { state: Record<string, unknown>; attributes?: Record<string, unknown> };
const shown = (t: TestContext<unknown>, uniqueId: string) => t.state(uniqueId) as Shown | undefined;
const value = (t: TestContext<unknown>, uniqueId: string) => shown(t, uniqueId)?.state.value;
const daytimeOn = (t: TestContext<unknown>) => shown(t, "daytime")?.state.on;
const conditionNow = (t: TestContext<unknown>) => shown(t, "weather")?.state.condition;

const WEATHER_IDS = [
  "weather",
  "temperature",
  "apparent-temperature",
  "humidity",
  "wind-speed",
  "wind-gusts",
  "pressure",
  "uv-index",
  "precipitation-last-24h",
  "precipitation-next-24h",
  "precipitation-chance",
  "sunrise",
  "sunset",
  "daytime",
];
const AIR_IDS = ["aqi", "pm2-5", "pm10"];
const availableOf = (t: TestContext<unknown>, ids: string[]) =>
  ids.map((id) => t.state(id)?.available);
// By exact host: the fake's `calls(host)` matches a substring, and the air-quality host
// (air-quality-api.open-meteo.com) contains the forecast's.
const forecasts = (cloud: FakeOpenMeteo) =>
  cloud.requests.filter((r) => r.host === "api.open-meteo.com").length;
const airRequests = (cloud: FakeOpenMeteo) =>
  cloud.requests.filter((r) => r.host === "air-quality-api.open-meteo.com").length;
/** One entry per hour of the recorded response, to build a replacement column from. */
const hourTimes = (cloud: FakeOpenMeteo) => cloud.forecast.hourly.time ?? [];

// ───────── discovery and state ─────────

describe("discovery", () => {
  test("registers one device and its entities, named after the label", async () => {
    const { t } = await setup();
    expect([...t.devices.values()]).toMatchObject([
      { uniqueId: "weather", name: "Weather", manufacturer: "Open-Meteo" },
    ]);
    expect([...t.entities.values()].map((e) => [e.id, e.uniqueId, e.name])).toEqual([
      ["weather.weather", "weather", "Weather"],
      ["sensor.weather_temperature", "temperature", "Weather temperature"],
      ["sensor.weather_feels_like", "apparent-temperature", "Weather feels like"],
      ["sensor.weather_humidity", "humidity", "Weather humidity"],
      ["sensor.weather_wind_speed", "wind-speed", "Weather wind speed"],
      ["sensor.weather_wind_gusts", "wind-gusts", "Weather wind gusts"],
      ["sensor.weather_pressure", "pressure", "Weather pressure"],
      ["sensor.weather_uv_index", "uv-index", "Weather UV index"],
      [
        "sensor.weather_precipitation_last_24h",
        "precipitation-last-24h",
        "Weather precipitation last 24h",
      ],
      [
        "sensor.weather_precipitation_next_24h",
        "precipitation-next-24h",
        "Weather precipitation next 24h",
      ],
      [
        "sensor.weather_precipitation_chance",
        "precipitation-chance",
        "Weather precipitation chance",
      ],
      ["sensor.weather_sunrise", "sunrise", "Weather sunrise"],
      ["sensor.weather_sunset", "sunset", "Weather sunset"],
      ["binary_sensor.weather_daytime", "daytime", "Weather daytime"],
      ["sensor.weather_air_quality_index", "aqi", "Weather air quality index"],
      ["sensor.weather_pm2_5", "pm2-5", "Weather PM2.5"],
      ["sensor.weather_pm10", "pm10", "Weather PM10"],
    ]);
    const device = [...t.devices.values()][0]?.id;
    expect([...t.entities.values()].every((e) => e.deviceId === device)).toBe(true);
  });

  test("a label names the device and every entity, for a second place", async () => {
    const { t } = await setup({ label: "Cabin weather" });
    expect([...t.devices.values()][0]?.name).toBe("Cabin weather");
    expect(t.entity("weather").name).toBe("Cabin weather");
    expect(t.entity("weather").id as string).toBe("weather.cabin_weather");
    expect(t.entity("temperature").name).toBe("Cabin weather temperature");
    expect(t.entity("temperature").id as string).toBe("sensor.cabin_weather_temperature");
    expect(t.entity("daytime").id as string).toBe("binary_sensor.cabin_weather_daytime");
    expect(t.entity("pm2-5").name).toBe("Cabin weather PM2.5");
  });

  test("entities are read-only: a command to any of them is refused", async () => {
    const { t } = await setup();
    for (const uniqueId of [...WEATHER_IDS, ...AIR_IDS]) {
      await expect(
        t.command(uniqueId, { domain: "switch", action: "turn_on" } as never),
      ).rejects.toThrow("is read-only");
    }
  });
});

describe("state from the first poll", () => {
  test("the weather entity: conditions now, and the forecast in its attributes", async () => {
    const { t } = await setup();
    const weather = shown(t, "weather");
    expect(weather?.state).toEqual({
      domain: "weather",
      condition: "overcast",
      temperature: 11.8,
      apparentTemperature: 11.2,
      humidity: 83,
      windSpeed: 2.5,
      windBearing: 75,
    });
    const attributes = weather?.attributes ?? {};
    expect(attributes).toMatchObject({
      observedAt: RECORDED_AT,
      precipitation: 0,
      pressure: 1019.7,
      windGusts: 5.8,
      uvIndex: 0.65,
      timeZone: "America/Los_Angeles",
      attribution: ATTRIBUTION,
      // Where the forecast is for, from the config, so a page can work out the sun's height.
      latitude: 47.6,
      longitude: -122.32,
    });
    expect(ATTRIBUTION).toBe("Weather data by Open-Meteo.com");
  });

  test("daily: seven days, today first, each with a daytime condition and no raw code", async () => {
    const { t } = await setup();
    const daily = shown(t, "weather")?.attributes?.daily as Record<string, unknown>[];
    expect(daily).toHaveLength(7);
    expect(daily[0]).toEqual({
      date: "2026-10-05",
      condition: "fog",
      high: 17.3,
      low: 10.3,
      precipitation: 0,
      precipitationProbability: 1,
      sunrise: SUNRISE,
      sunset: SUNSET,
      uvIndexMax: 3.75,
      windSpeedMax: 8.7,
    });
    expect(daily.map((d) => d.condition)).toEqual([
      "fog",
      "fog",
      "overcast",
      "partly-cloudy",
      "drizzle",
      "drizzle",
      "drizzle",
    ]);
    expect(daily.some((d) => "code" in d)).toBe(false);
  });

  test("hourly: from the hour under way on, with a condition and no raw code or isDay", async () => {
    const { t } = await setup();
    const hourly = shown(t, "weather")?.attributes?.hourly as Record<string, unknown>[];
    // 08:30 now: the hour ending at 08:00 is the first one shown, then two days on.
    expect(hourly).toHaveLength(48);
    expect(hourly[0]?.at).toBe(1_791_212_400_000);
    expect(hourly.every((h) => Number(h.at) > RECORDED_AT - HOUR)).toBe(true);
    expect(Object.keys(hourly[0] ?? {}).sort()).toEqual([
      "at",
      "condition",
      "precipitation",
      "precipitationProbability",
      "temperature",
      "windSpeed",
    ]);
  });

  test("sensors: readings now, with their units and device classes", async () => {
    const { t } = await setup();
    const state = (id: string) => shown(t, id)?.state;
    expect(state("temperature")).toEqual({
      domain: "sensor",
      value: 11.8,
      unit: "°C",
      deviceClass: "temperature",
    });
    expect(state("apparent-temperature")).toEqual({
      domain: "sensor",
      value: 11.2,
      unit: "°C",
      deviceClass: "temperature",
    });
    expect(state("humidity")).toEqual({
      domain: "sensor",
      value: 83,
      unit: "%",
      deviceClass: "humidity",
    });
    expect([
      value(t, "wind-speed"),
      value(t, "wind-gusts"),
      value(t, "pressure"),
      value(t, "uv-index"),
    ]).toEqual([2.5, 5.8, 1019.7, 0.65]);
    expect([state("wind-speed")?.unit, state("pressure")?.unit, state("uv-index")?.unit]).toEqual([
      "km/h",
      "hPa",
      undefined,
    ]);
    // Nothing fell or is expected near the recorded time; the highest chance is 1%.
    expect([
      value(t, "precipitation-last-24h"),
      value(t, "precipitation-next-24h"),
      value(t, "precipitation-chance"),
    ]).toEqual([0, 0, 1]);
    expect(state("precipitation-last-24h")?.unit).toBe("mm");
    expect(state("precipitation-chance")?.unit).toBe("%");
  });

  test("sunrise and sunset read as clock times at the place, with the instants alongside", async () => {
    const { t } = await setup();
    expect(shown(t, "sunrise")).toMatchObject({
      state: { domain: "sensor", value: "7:14 am" },
      attributes: { at: SUNRISE, tomorrow: SUNRISE_TOMORROW },
    });
    expect(shown(t, "sunset")).toMatchObject({
      state: { domain: "sensor", value: "6:40 pm" },
      attributes: { at: SUNSET, tomorrow: 1_791_337_090_000 },
    });
  });

  test("a time zone the runtime does not know falls back to the server's clock, not an error", async () => {
    const { t } = await setup({}, (cloud) => {
      cloud.forecast.timezone = "Mars/Olympus_Mons";
    });
    expect(String(value(t, "sunrise"))).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
  });

  test("daytime is on between sunrise and sunset", async () => {
    const { t } = await setup();
    expect(daytimeOn(t)).toBe(true);
  });

  test("air quality: the US index by default, PM2.5 and PM10, with when they were observed", async () => {
    const { t } = await setup();
    expect(shown(t, "aqi")).toMatchObject({
      state: { domain: "sensor", value: 56 },
      attributes: { observedAt: 1_791_212_400_000 },
    });
    expect(shown(t, "pm2-5")?.state).toMatchObject({ value: 13.7, unit: "µg/m³" });
    expect(shown(t, "pm10")?.state).toMatchObject({ value: 13.9, unit: "µg/m³" });
  });

  test('aqi: "european" reports the European index instead', async () => {
    const { t } = await setup({ aqi: "european" });
    expect(value(t, "aqi")).toBe(43);
  });

  test("setup makes one forecast and one air-quality request", async () => {
    const { cloud } = await setup();
    expect(forecasts(cloud)).toBe(1);
    expect(airRequests(cloud)).toBe(1);
    expect(cloud.requests[0]?.query).toMatchObject({ latitude: "47.6", longitude: "-122.32" });
  });

  test("null readings are reported as null values, and missing fields as undefined", async () => {
    const { t } = await setup({}, (cloud) => {
      cloud.forecast.current.temperature_2m = null;
      cloud.forecast.current.relative_humidity_2m = null;
      delete cloud.forecast.current.uv_index;
      cloud.forecast.hourly.precipitation = hourTimes(cloud).map(() => null) as never;
      cloud.forecast.hourly.precipitation_probability = hourTimes(cloud).map(() => null) as never;
      (cloud.forecast.daily.sunrise as (number | null)[])[0] = null;
      cloud.air.current.us_aqi = null;
    });
    expect([
      value(t, "temperature"),
      value(t, "humidity"),
      value(t, "uv-index"),
      value(t, "precipitation-last-24h"),
      value(t, "precipitation-next-24h"),
      value(t, "precipitation-chance"),
      value(t, "sunrise"),
      value(t, "aqi"),
    ]).toEqual([null, null, null, null, null, null, null, null]);
    expect(value(t, "apparent-temperature")).toBe(11.2);
    const weather = shown(t, "weather")?.state ?? {};
    expect(weather.temperature).toBeUndefined();
    expect(weather.humidity).toBeUndefined();
    expect(weather.condition).toBe("overcast");
  });
});

// ───────── precipitation from the forecast ─────────

describe("precipitation sensors", () => {
  test("sum the hours that end in the last and next 24 hours, and take the highest chance", async () => {
    // Hour i of the fixture ends at RECORDED_AT - 24.5 h + i h; now is on the half hour.
    const { t } = await setup({}, (cloud) => {
      const rain = cloud.forecast.hourly.precipitation as number[];
      const chance = cloud.forecast.hourly.precipitation_probability as number[];
      rain[0] = 100; // ended 24.5 h ago: outside
      rain[1] = 1; // ended 23.5 h ago: inside
      rain[24] = 0.25; // ended half an hour ago: inside
      rain[25] = 2; // ends in half an hour: next
      rain[48] = 0.3; // ends in 23.5 h: next
      rain[49] = 50; // ends in 24.5 h: outside
      chance[24] = 99; // past
      chance[48] = 90;
      chance[49] = 100; // too far ahead
    });
    expect(value(t, "precipitation-last-24h")).toBe(1.3);
    expect(value(t, "precipitation-next-24h")).toBe(2.3);
    expect(value(t, "precipitation-chance")).toBe(90);
  });
});

describe("precipitation", () => {
  const NOW = Date.UTC(2026, 9, 5, 12);
  const hour = (at: number, rain?: number, chance?: number): Hour => ({
    at,
    isDay: true,
    precipitation: rain,
    precipitationProbability: chance,
  });

  test("an hour is counted by when it ends: (now - 24 h, now] is the last day", () => {
    const hours = [
      hour(NOW - DAY, 100), // ended exactly a day ago: the day before
      hour(NOW - DAY + 1, 1),
      hour(NOW, 2), // ended now: already fallen
    ];
    expect(precipitation(hours, NOW).last24h).toBe(3);
  });

  test("(now, now + 24 h] is the next day", () => {
    const hours = [
      hour(NOW, 100), // ended now: not ahead
      hour(NOW + 1, 1),
      hour(NOW + DAY, 2), // ends exactly a day on: inside
      hour(NOW + DAY + 1, 100),
    ];
    expect(precipitation(hours, NOW).next24h).toBe(3);
  });

  test("the chance is the highest of the hours ahead, the hour ending now not included", () => {
    const hours = [
      hour(NOW, 0, 100),
      hour(NOW + HOUR, 0, 20),
      hour(NOW + DAY, 0, 70),
      hour(NOW + DAY + 1, 0, 95),
    ];
    expect(precipitation(hours, NOW).chance).toBe(70);
  });

  test("sums are rounded to a tenth of a millimetre", () => {
    const hours = [hour(NOW - 2 * HOUR, 0.1), hour(NOW - HOUR, 0.2), hour(NOW + HOUR, 0.04)];
    expect(precipitation(hours, NOW)).toEqual({ last24h: 0.3, next24h: 0, chance: undefined });
  });

  test("hours with no value are skipped; with none at all a sum is undefined, not zero", () => {
    const hours = [hour(NOW - HOUR, undefined), hour(NOW - 2 * HOUR, 0.5), hour(NOW + HOUR)];
    expect(precipitation(hours, NOW)).toEqual({
      last24h: 0.5,
      next24h: undefined,
      chance: undefined,
    });
  });

  test("no hours at all says nothing", () => {
    expect(precipitation([], NOW)).toEqual({
      last24h: undefined,
      next24h: undefined,
      chance: undefined,
    });
  });

  test("zero is a value: a dry day sums to 0 and a 0% chance is 0", () => {
    expect(precipitation([hour(NOW - HOUR, 0), hour(NOW + HOUR, 0, 0)], NOW)).toEqual({
      last24h: 0,
      next24h: 0,
      chance: 0,
    });
  });
});

// ───────── the condition ahead ─────────

describe("conditionAhead", () => {
  const NOW = Date.UTC(2026, 9, 5, 12);
  /** A forecast with no sun times, so the sky now goes by `isDay`, and these hours. */
  const forecastWith = (code: number | undefined, hours: Hour[], isDay = true): Forecast => ({
    current: { at: NOW, code, isDay },
    hours,
    days: [],
  });
  const hour = (at: number, code: number, isDay = true): Hour => ({ at, code, isDay });

  test("clear now and rain later is rain", () => {
    const forecast = forecastWith(0, [hour(NOW + HOUR, 0), hour(NOW + 5 * HOUR, 61)]);
    expect(conditionAhead(forecast, NOW)).toBe("rain");
  });

  test("the sky now wins when it is the worst", () => {
    const forecast = forecastWith(95, [hour(NOW + HOUR, 61), hour(NOW + 2 * HOUR, 0)]);
    expect(conditionAhead(forecast, NOW)).toBe("thunderstorm");
  });

  test("with no hours ahead it is the sky now", () => {
    expect(conditionAhead(forecastWith(3, []), NOW)).toBe("overcast");
    expect(conditionAhead(forecastWith(0, [], false), NOW)).toBe("clear-night");
  });

  test("of equals the sky now comes first: clear by day stays clear past a clear night", () => {
    const forecast = forecastWith(0, [hour(NOW + HOUR, 0, false)]);
    expect(conditionAhead(forecast, NOW)).toBe("clear");
  });

  test("an hour reads by its own isDay flag", () => {
    const forecast = forecastWith(0, [hour(NOW + HOUR, 2, false)]);
    expect(conditionAhead(forecast, NOW)).toBe("partly-cloudy-night");
  });

  test("the sky now goes by the sun times, not the model's flag", () => {
    // After sunset, a clear sky now is clear-night though current.isDay says day.
    const forecast: Forecast = {
      current: { at: SUNSET + HOUR, code: 0, isDay: true },
      hours: [],
      days: [{ date: "2026-10-05", sunrise: SUNRISE, sunset: SUNSET }],
    };
    expect(conditionAhead(forecast, SUNSET + HOUR)).toBe("clear-night");
  });

  describe("the window is (now, now + 12 h], by when each hour ends", () => {
    test("an hour ending exactly now is behind", () => {
      expect(conditionAhead(forecastWith(0, [hour(NOW, 61)]), NOW)).toBe("clear");
    });

    test("an hour ending a moment after now is ahead", () => {
      expect(conditionAhead(forecastWith(0, [hour(NOW + 1, 61)]), NOW)).toBe("rain");
    });

    test("an hour ending exactly twelve hours on is inside", () => {
      expect(conditionAhead(forecastWith(0, [hour(NOW + 12 * HOUR, 61)]), NOW)).toBe("rain");
    });

    test("an hour ending a moment past twelve hours is outside", () => {
      expect(conditionAhead(forecastWith(0, [hour(NOW + 12 * HOUR + 1, 61)]), NOW)).toBe("clear");
    });

    test("past hours are ignored however bad", () => {
      const forecast = forecastWith(0, [
        hour(NOW - 3 * HOUR, 99),
        hour(NOW - HOUR, 65),
        hour(NOW + HOUR, 2),
      ]);
      expect(conditionAhead(forecast, NOW)).toBe("partly-cloudy");
    });

    test("only the hours inside count, among many on either side", () => {
      const forecast = forecastWith(0, [
        hour(NOW - DAY, 95),
        hour(NOW, 75),
        hour(NOW + 6 * HOUR, 51),
        hour(NOW + 12 * HOUR, 61),
        hour(NOW + 13 * HOUR, 99),
        hour(NOW + DAY, 71),
      ]);
      expect(conditionAhead(forecast, NOW)).toBe("rain");
    });
  });
});

describe("the conditionNext12h attribute", () => {
  /** Every hour clear, and the sky now clear, so one hour's code decides. */
  const allClear = (cloud: FakeOpenMeteo) => {
    cloud.forecast.current.weather_code = 0;
    cloud.forecast.hourly.weather_code = hourTimes(cloud).map(() => 0);
  };
  const ahead = (t: TestContext<unknown>) => shown(t, "weather")?.attributes?.conditionNext12h;
  const codes = (cloud: FakeOpenMeteo) => cloud.forecast.hourly.weather_code as number[];

  test("is on the weather entity from the first poll", async () => {
    const { t } = await setup({}, allClear);
    expect(ahead(t)).toBe("clear");
  });

  test("matches conditionAhead over the recorded forecast", async () => {
    const { t, cloud } = await setup();
    // Read back the forecast the integration read, through the real API reader.
    const forecast = await new OpenMeteoApi(cloud.fetch).forecast(47.6, -122.32);
    expect(ahead(t)).toBe(conditionAhead(forecast, RECORDED_AT));
    // Overcast now, then overcast, clear and clear night: nothing worse than now.
    expect(ahead(t)).toBe("overcast");
  });

  test("changes when a later poll brings rain within twelve hours", async () => {
    const { t, cloud, poll } = await setup({}, allClear);
    expect(ahead(t)).toBe("clear");
    // Hour i of the fixture ends at RECORDED_AT - 24.5 h + i h: index 30 ends in 5.5 h.
    codes(cloud)[30] = 61;
    await poll();
    expect(ahead(t)).toBe("rain");
    expect(conditionNow(t)).toBe("clear");
  });

  test("an hour ending past twelve hours does not change it", async () => {
    const { t, cloud, poll } = await setup({}, allClear);
    codes(cloud)[37] = 95; // ends in 12.5 h
    codes(cloud)[24] = 95; // ended half an hour ago
    await poll();
    expect(ahead(t)).toBe("clear");
    codes(cloud)[36] = 95; // ends in 11.5 h
    await poll();
    expect(ahead(t)).toBe("thunderstorm");
  });
});

// ───────── the sun ─────────

describe("daytime", () => {
  const forecastWith = (days: { sunrise?: number; sunset?: number }[], isDay = true): Forecast => ({
    current: { at: 0, isDay },
    hours: [],
    days: days.map((d, i) => ({ date: `2026-10-0${i + 5}`, ...d })),
  });
  const twoDays = forecastWith([
    { sunrise: SUNRISE, sunset: SUNSET },
    { sunrise: SUNRISE_TOMORROW, sunset: SUNRISE_TOMORROW + 11 * HOUR },
  ]);

  test.each([
    ["before the first sunrise", SUNRISE - 1, false],
    ["at sunrise", SUNRISE, true],
    ["during the day", RECORDED_AT, true],
    ["a moment before sunset", SUNSET - 1, true],
    ["at sunset", SUNSET, false],
    ["overnight", SUNSET + 6 * HOUR, false],
    ["at the next sunrise", SUNRISE_TOMORROW, true],
    ["after the last sunset the forecast knows", SUNRISE_TOMORROW + 12 * HOUR, false],
  ])("%s", (_, now, up) => {
    expect(daytime(twoDays, now)).toBe(up);
  });

  test("the order of the days does not matter", () => {
    const reversed = { ...twoDays, days: [...twoDays.days].reverse() };
    expect(daytime(reversed, SUNSET + HOUR)).toBe(false);
    expect(daytime(reversed, RECORDED_AT)).toBe(true);
  });

  test("with no sun times, the model's own flag decides", () => {
    expect(daytime(forecastWith([], true), RECORDED_AT)).toBe(true);
    expect(daytime(forecastWith([], false), RECORDED_AT)).toBe(false);
    expect(daytime(forecastWith([{}], false), RECORDED_AT)).toBe(false);
  });

  test("a day where the sun does not rise and set in order is skipped", () => {
    // A polar day, as Open-Meteo gives it, puts sunset before sunrise.
    const polar = forecastWith([{ sunrise: SUNSET, sunset: SUNRISE }], false);
    expect(daytime(polar, RECORDED_AT)).toBe(false);
    const halfKnown = forecastWith([{ sunrise: SUNRISE }], true);
    expect(daytime(halfKnown, SUNSET + HOUR)).toBe(true);
  });
});

describe("the daytime sensor and night", () => {
  test("turns off at sunset, without waiting for the next poll", async () => {
    const { t, after, cloud } = await setup({}, () => {}, SUNSET - 5);
    expect(daytimeOn(t)).toBe(true);
    expect(after.at(-1)?.ms).toBe(5);
    await until(() => daytimeOn(t) === false, "daytime off at sunset");
    expect(cloud.calls()).toBe(2); // no poll was needed
  });

  test("turns on at sunrise", async () => {
    const { t, after } = await setup({}, () => {}, SUNRISE_TOMORROW - 5);
    expect(daytimeOn(t)).toBe(false);
    expect(after.at(-1)?.ms).toBe(5);
    await until(() => daytimeOn(t) === true, "daytime on at sunrise");
  });

  test("before today's sunrise it is night, and the turn waits for sunrise", async () => {
    const { t, after } = await setup({}, () => {}, SUNRISE - HOUR);
    expect(daytimeOn(t)).toBe(false);
    expect(after.at(-1)?.ms).toBe(HOUR);
  });

  test("each poll replaces the waiting turn rather than adding another", async () => {
    const { after, poll } = await setup();
    expect(after).toHaveLength(1);
    await poll();
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.cancelled)).toEqual([true, false]);
  });

  test.each([
    [0, "clear-night"],
    [1, "clear-night"],
    [2, "partly-cloudy-night"],
    [3, "overcast"],
    [61, "rain"],
  ])("after sunset, code %i reads as %s, whatever the model's is_day says", async (code, cond) => {
    const { t } = await setup(
      {},
      (cloud) => {
        cloud.forecast.current.weather_code = code;
        cloud.forecast.current.is_day = 1;
      },
      SUNSET + HOUR,
    );
    expect(conditionNow(t)).toBe(cond);
    expect(daytimeOn(t)).toBe(false);
  });

  test("by day a clear sky is clear, though the model's is_day says night", async () => {
    const { t } = await setup({}, (cloud) => {
      cloud.forecast.current.weather_code = 0;
      cloud.forecast.current.is_day = 0;
    });
    expect(conditionNow(t)).toBe("clear");
  });

  test("hourly conditions use each hour's own is_day; daily ones are always the day's", async () => {
    const { t, cloud } = await setup(
      {},
      (cloud) => {
        cloud.forecast.hourly.weather_code = hourTimes(cloud).map(() => 0);
        cloud.forecast.daily.weather_code = (cloud.forecast.daily.time as number[]).map(() => 0);
      },
      SUNSET + HOUR,
    );
    const attributes = shown(t, "weather")?.attributes ?? {};
    const hourly = attributes.hourly as { condition: string }[];
    // `hourly` keeps the last hours of the response; each reads by its own is_day flag.
    const flags = cloud.forecast.hourly.is_day?.slice(-hourly.length) ?? [];
    expect(hourly.map((h) => h.condition)).toEqual(
      flags.map((flag) => (flag ? "clear" : "clear-night")),
    );
    expect(new Set(hourly.map((h) => h.condition))).toEqual(new Set(["clear", "clear-night"]));
    const daily = attributes.daily as { condition: string }[];
    expect(daily.every((d) => d.condition === "clear")).toBe(true);
  });
});

// ───────── the repeating poll and failures ─────────

describe("polling", () => {
  test("polls every pollMinutes", async () => {
    expect((await setup()).every.map((e) => e.ms)).toEqual([15 * 60_000]);
    expect((await setup({ pollMinutes: 5 })).every.map((e) => e.ms)).toEqual([5 * 60_000]);
  });

  test("a poll reads the forecast and air quality again and reports what changed", async () => {
    const { t, cloud, poll } = await setup();
    cloud.forecast.current.temperature_2m = 14.2;
    cloud.air.current.us_aqi = 71;
    await poll();
    expect(value(t, "temperature")).toBe(14.2);
    expect(shown(t, "weather")?.state.temperature).toBe(14.2);
    expect(value(t, "aqi")).toBe(71);
    expect(forecasts(cloud)).toBe(2);
    expect(airRequests(cloud)).toBe(2);
  });

  test("entities go unavailable after three failed polls in a row, not one or two", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    cloud.down = true;
    await poll();
    await poll();
    expect(t.availability).toEqual([]);
    expect(availableOf(t, WEATHER_IDS).every(Boolean)).toBe(true);

    await poll();
    expect(t.availability.map((a) => [a.entityId, a.available])).toEqual(
      WEATHER_IDS.map((id) => [t.entity(id).id, false]),
    );
    expect(availableOf(t, WEATHER_IDS).some(Boolean)).toBe(false);

    // A fourth failure does not mark them again.
    await poll();
    expect(t.availability).toHaveLength(WEATHER_IDS.length);
    expect(t.logs.filter((l) => l.msg === "Open-Meteo poll failed").map((l) => l.data)).toEqual(
      [1, 2, 3, 4].map((failures) => ({
        error: "Cannot reach Open-Meteo: getaddrinfo ENOTFOUND api.open-meteo.com",
        failures,
      })),
    );
  });

  test("the next good poll brings them back, and the count starts again", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    cloud.down = true;
    for (let i = 0; i < 3; i++) await poll();
    expect(availableOf(t, WEATHER_IDS).some(Boolean)).toBe(false);

    cloud.down = false;
    cloud.forecast.current.temperature_2m = 9.4;
    await poll();
    expect(availableOf(t, WEATHER_IDS).every(Boolean)).toBe(true);
    expect(value(t, "temperature")).toBe(9.4);

    const marked = t.availability.length;
    cloud.down = true;
    await poll();
    await poll();
    expect(t.availability).toHaveLength(marked);
  });

  test("going unavailable cancels the waiting sunrise or sunset report", async () => {
    const { cloud, poll, after } = await setup({ airQuality: false });
    cloud.down = true;
    await poll();
    await poll();
    expect(after.at(-1)?.cancelled).toBe(false);
    await poll();
    expect(after.at(-1)?.cancelled).toBe(true);
  });

  test("an HTTP error counts as a failed poll too", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    cloud.status = 503;
    for (let i = 0; i < 3; i++) await poll();
    expect(availableOf(t, WEATHER_IDS).some(Boolean)).toBe(false);
    expect(t.logs.at(-1)?.data).toMatchObject({
      error: "Open-Meteo answered 503: Too many requests",
    });
  });
});

// ───────── setup failures ─────────

describe("setup", () => {
  test("rejects when Open-Meteo cannot be reached, before asking for air quality", async () => {
    let fake: FakeOpenMeteo | undefined;
    await expect(
      setup({}, (cloud) => {
        fake = cloud;
        cloud.down = true;
      }),
    ).rejects.toThrow("Cannot reach Open-Meteo: getaddrinfo ENOTFOUND");
    expect(fake?.requests).toEqual([]);
  });

  test("rejects with Open-Meteo's reason on a 400", async () => {
    // Coordinates the schema would refuse, given straight to setup, are what earns a 400.
    const cloud = await FakeOpenMeteo.create();
    const integration = createOpenMeteoIntegration({ fetch: cloud.fetch, now: () => RECORDED_AT });
    const t = createTestContext({
      latitude: 95,
      longitude: 0,
      label: "Weather",
      pollMinutes: 15,
      airQuality: true,
      aqi: "us" as const,
    });
    cleanups.push(() => t.abort());
    await expect(integration.setup(t.ctx)).rejects.toThrow(
      "Open-Meteo answered 400: Latitude must be in range of -90 to 90°.",
    );
    expect(airRequests(cloud)).toBe(0);
  });

  test("rejects when the request limit is used up", async () => {
    await expect(
      setup({}, (cloud) => {
        cloud.status = 429;
      }),
    ).rejects.toThrow("Open-Meteo's request limit is used up");
  });

  test("a failed setup schedules nothing", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.down = true;
    const integration = createOpenMeteoIntegration({ fetch: cloud.fetch, now: () => RECORDED_AT });
    const t = createTestContext(integration.configSchema.parse({ latitude: 0, longitude: 0 }));
    cleanups.push(() => t.abort());
    const asked: string[] = [];
    const scheduler: Scheduler = {
      every: () => {
        asked.push("every");
        return () => {};
      },
      after: () => {
        asked.push("after");
        return () => {};
      },
      cron: () => {
        asked.push("cron");
        return () => {};
      },
    };
    await expect(integration.setup({ ...t.ctx, scheduler })).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});

// ───────── air quality ─────────

describe("air quality", () => {
  test("its failing does not fail setup or the weather", async () => {
    const { t } = await setup({}, (cloud) => {
      cloud.airDown = true;
    });
    expect(value(t, "temperature")).toBe(11.8);
    expect(availableOf(t, WEATHER_IDS).every(Boolean)).toBe(true);
    expect(AIR_IDS.map((id) => t.state(id))).toEqual([undefined, undefined, undefined]);
    expect(t.logs.at(-1)).toEqual({
      level: "warn",
      msg: "Open-Meteo air quality poll failed",
      data: { error: "Open-Meteo answered 500: Internal", failures: 1 },
    });
  });

  test("its sensors go unavailable after three failures in a row, alone, and come back", async () => {
    const { t, cloud, poll } = await setup();
    cloud.airDown = true;
    await poll();
    await poll();
    expect(t.availability).toEqual([]);
    await poll();
    expect(t.availability.map((a) => [a.entityId, a.available])).toEqual(
      AIR_IDS.map((id) => [t.entity(id).id, false]),
    );
    expect(availableOf(t, AIR_IDS)).toEqual([false, false, false]);
    expect(availableOf(t, WEATHER_IDS).every(Boolean)).toBe(true);

    await poll(); // a fourth does not mark them again
    expect(t.availability).toHaveLength(3);

    cloud.airDown = false;
    await poll();
    expect(availableOf(t, AIR_IDS)).toEqual([true, true, true]);
    expect(value(t, "aqi")).toBe(56);
  });

  test("failures counted from setup: one at setup and two polls make three", async () => {
    const { t, poll } = await setup({}, (cloud) => {
      cloud.airDown = true;
    });
    await poll();
    expect(t.availability).toEqual([]);
    await poll();
    expect(t.availability.map((a) => a.available)).toEqual([false, false, false]);
  });

  test("airQuality: false registers no air sensors and never asks for air quality", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    for (const id of AIR_IDS) expect(() => t.entity(id)).toThrow();
    expect(t.entities.size).toBe(WEATHER_IDS.length);
    await poll();
    await t.runAction("refresh", {});
    expect(airRequests(cloud)).toBe(0);
    expect(forecasts(cloud)).toBe(3);
  });
});

// ───────── actions ─────────

describe("actions", () => {
  test("status says where, what time zone, when observed, and how often, without a request", async () => {
    const { t, cloud } = await setup({ pollMinutes: 30 });
    const before = cloud.requests.length;
    expect(await t.runAction("status", {})).toEqual({
      latitude: 47.6,
      longitude: -122.32,
      timeZone: "America/Los_Angeles",
      observedAt: RECORDED_AT,
      pollMinutes: 30,
    });
    expect(cloud.requests.length).toBe(before);
  });

  test("status reports null for a time zone Open-Meteo did not give", async () => {
    const { t } = await setup({}, (cloud) => {
      delete cloud.forecast.timezone;
    });
    expect(await t.runAction("status", {})).toMatchObject({ timeZone: null });
  });

  test("refresh reads everything now and answers with the status", async () => {
    const { t, cloud } = await setup();
    cloud.forecast.current.temperature_2m = 15;
    cloud.forecast.current.time = RECORDED_AT / 1000 + 900;
    cloud.air.current.pm10 = 20;
    expect(await t.runAction("refresh", {})).toMatchObject({ observedAt: RECORDED_AT + 900_000 });
    expect(value(t, "temperature")).toBe(15);
    expect(value(t, "pm10")).toBe(20);
    expect(forecasts(cloud)).toBe(2);
    expect(airRequests(cloud)).toBe(2);
  });

  test("refresh rejects when the forecast fails, without marking anything unavailable", async () => {
    const { t, cloud } = await setup();
    cloud.down = true;
    for (let i = 0; i < 3; i++) {
      await expect(t.runAction("refresh", {})).rejects.toThrow("Cannot reach Open-Meteo");
    }
    expect(t.availability).toEqual([]);
  });

  test("a good refresh resets the failed-poll count", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    cloud.down = true;
    await poll();
    await poll();
    cloud.down = false;
    await t.runAction("refresh", {});
    cloud.down = true;
    await poll();
    await poll();
    expect(t.availability).toEqual([]);
  });

  test("a good refresh brings unavailable entities back", async () => {
    const { t, cloud, poll } = await setup({ airQuality: false });
    cloud.down = true;
    for (let i = 0; i < 3; i++) await poll();
    cloud.down = false;
    await t.runAction("refresh", {});
    expect(availableOf(t, WEATHER_IDS).every(Boolean)).toBe(true);
  });

  test("actions take no parameters", async () => {
    const { t } = await setup();
    await expect(t.runAction("status", { verbose: true })).rejects.toThrow();
    await expect(t.runAction("refresh", { force: true })).rejects.toThrow();
  });
});

// ───────── cleanup ─────────

test("cleans up on abort: the sunset report and polling stop", async () => {
  const { t, cloud } = await setup({}, () => {}, SUNSET - 5);
  const reports = t.reports.length;
  const requests = cloud.requests.length;
  t.abort();
  await Bun.sleep(20);
  expect(t.reports.length).toBe(reports);
  expect(cloud.requests.length).toBe(requests);
  expect(daytimeOn(t)).toBe(true);
});

// ───────── configuration ─────────

describe("config schema", () => {
  const { configSchema } = createOpenMeteoIntegration();
  const parse = (config: object) => configSchema.safeParse(config);

  test("fills in the defaults", () => {
    expect(configSchema.parse({ latitude: 0, longitude: 0 })).toEqual({
      latitude: 0,
      longitude: 0,
      label: "Weather",
      pollMinutes: 15,
      airQuality: true,
      aqi: "us",
    });
  });

  test.each([
    ["latitude", -90, true],
    ["latitude", 90, true],
    ["latitude", -90.01, false],
    ["latitude", 90.01, false],
    ["longitude", -180, true],
    ["longitude", 180, true],
    ["longitude", -180.01, false],
    ["longitude", 180.01, false],
    ["pollMinutes", 5, true],
    ["pollMinutes", 180, true],
    ["pollMinutes", 4.9, false],
    ["pollMinutes", 181, false],
    ["label", "", false],
    ["aqi", "european", true],
    ["aqi", "china", false],
    ["airQuality", "yes", false],
  ])("%s = %p is accepted: %p", (key, given, ok) => {
    expect(parse({ latitude: 0, longitude: 0, [key]: given }).success).toBe(ok);
  });

  test("latitude and longitude are required, as numbers", () => {
    expect(parse({ longitude: 0 }).success).toBe(false);
    expect(parse({ latitude: 0 }).success).toBe(false);
    expect(parse({ latitude: "47.6", longitude: 0 }).success).toBe(false);
  });

  test("unknown keys are rejected", () => {
    expect(parse({ latitude: 0, longitude: 0, apiKey: "x" }).success).toBe(false);
    expect(parse({ latitude: 0, longitude: 0, pollSeconds: 60 }).success).toBe(false);
  });
});
