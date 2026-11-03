import { describe, expect, test } from "bun:test";
import {
  FORECAST_DAYS,
  FORECAST_HOURS,
  OpenMeteoApi,
  OpenMeteoError,
  PAST_HOURS,
} from "../src/api.ts";
import { FakeOpenMeteo, RECORDED_AT } from "./fake-cloud.ts";

const LAT = 47.6;
const LON = -122.32;

/** A fetch that answers every request the same way and records what it was asked. */
function answering(status: number, body: unknown) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  return { api: new OpenMeteoApi(fetch), sent };
}

async function rejection(promise: Promise<unknown>): Promise<OpenMeteoError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OpenMeteoError) return err;
    throw err;
  }
  throw new Error("expected an OpenMeteoError");
}

/** The smallest forecast body the schema accepts, with the given daily times and offset. */
const forecastBody = (offset: number, days: number[], extra: object = {}) => ({
  utc_offset_seconds: offset,
  current: { time: 0 },
  hourly: { time: [] },
  daily: { time: days },
  ...extra,
});

// ───────── requests ─────────

describe("requests", () => {
  test("the forecast is one GET to /v1/forecast asking for every variable, in unix time", async () => {
    const cloud = await FakeOpenMeteo.create();
    await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(cloud.requests).toEqual([
      {
        host: "api.open-meteo.com",
        query: {
          latitude: "47.6",
          longitude: "-122.32",
          current:
            "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation," +
            "weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index",
          hourly:
            "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,is_day",
          daily:
            "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum," +
            "precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max",
          past_hours: "24",
          forecast_hours: "48",
          forecast_days: "7",
          timeformat: "unixtime",
          timezone: "auto",
        },
      },
    ]);
    expect([PAST_HOURS, FORECAST_HOURS, FORECAST_DAYS]).toEqual([24, 48, 7]);
  });

  test("air quality is one GET to the air-quality host for the index, PM2.5 and PM10", async () => {
    const cloud = await FakeOpenMeteo.create();
    await new OpenMeteoApi(cloud.fetch).airQuality(LAT, LON);
    expect(cloud.requests).toEqual([
      {
        host: "air-quality-api.open-meteo.com",
        query: {
          latitude: "47.6",
          longitude: "-122.32",
          current: "us_aqi,european_aqi,pm2_5,pm10",
          timeformat: "unixtime",
          timezone: "auto",
        },
      },
    ]);
  });

  test("the paths are the documented ones", async () => {
    const { api, sent } = answering(200, forecastBody(0, []));
    await api.forecast(LAT, LON);
    expect(new URL(sent[0]?.url ?? "").pathname).toBe("/v1/forecast");
    const air = answering(200, { current: { time: 0 } });
    await air.api.airQuality(LAT, LON);
    expect(new URL(air.sent[0]?.url ?? "").pathname).toBe("/v1/air-quality");
  });

  test("every request carries an abort signal, so a hung connection times out", async () => {
    const { api, sent } = answering(200, forecastBody(0, []));
    await api.forecast(LAT, LON);
    expect(sent[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ───────── reading the forecast ─────────

describe("forecast", () => {
  test("reads the recorded response: conditions now, in epoch milliseconds", async () => {
    const cloud = await FakeOpenMeteo.create();
    const forecast = await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(forecast.timeZone).toBe("America/Los_Angeles");
    expect(forecast.current).toEqual({
      at: RECORDED_AT,
      code: 3,
      isDay: true,
      temperature: 11.8,
      apparentTemperature: 11.2,
      humidity: 83,
      precipitation: 0,
      pressure: 1019.7,
      windSpeed: 2.5,
      windBearing: 75,
      windGusts: 5.8,
      uvIndex: 0.65,
    });
  });

  test("reads a day back and two ahead of hours, oldest first", async () => {
    const cloud = await FakeOpenMeteo.create();
    const { hours } = await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(hours).toHaveLength(72);
    expect(hours[0]?.at).toBe(1_791_126_000_000);
    expect(hours.at(-1)?.at).toBe(1_791_381_600_000);
    for (const [i, hour] of hours.entries()) {
      if (i > 0) expect(hour.at - (hours[i - 1]?.at ?? 0)).toBe(3_600_000);
      expect(typeof hour.isDay).toBe("boolean");
    }
  });

  test("reads a week of days, today first, with sun times in milliseconds", async () => {
    const cloud = await FakeOpenMeteo.create();
    const { days } = await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(days[0]).toEqual({
      date: "2026-10-05",
      code: 45,
      high: 17.3,
      low: 10.3,
      precipitation: 0,
      precipitationProbability: 1,
      sunrise: 1_791_209_651_000,
      sunset: 1_791_250_808_000,
      uvIndexMax: 3.75,
      windSpeedMax: 8.7,
    });
  });

  test("a null reading becomes undefined, now, by the hour, and by the day", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.forecast.current.temperature_2m = null;
    cloud.forecast.current.weather_code = null;
    (cloud.forecast.hourly.precipitation as (number | null)[])[0] = null;
    (cloud.forecast.daily.sunrise as (number | null)[])[0] = null;
    const forecast = await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(forecast.current.temperature).toBeUndefined();
    expect(forecast.current.code).toBeUndefined();
    expect(forecast.hours[0]?.precipitation).toBeUndefined();
    expect(forecast.hours[1]?.precipitation).toBe(0);
    expect(forecast.days[0]?.sunrise).toBeUndefined();
    expect(forecast.days[0]?.sunset).toBe(1_791_250_808_000);
  });

  test("a variable left out of the response altogether reads as undefined", async () => {
    const cloud = await FakeOpenMeteo.create();
    delete cloud.forecast.current.uv_index;
    delete cloud.forecast.hourly.precipitation_probability;
    delete cloud.forecast.daily.uv_index_max;
    delete cloud.forecast.timezone;
    const forecast = await new OpenMeteoApi(cloud.fetch).forecast(LAT, LON);
    expect(forecast.current.uvIndex).toBeUndefined();
    expect(forecast.hours.every((h) => h.precipitationProbability === undefined)).toBe(true);
    expect(forecast.days.every((d) => d.uvIndexMax === undefined)).toBe(true);
    expect(forecast.timeZone).toBeUndefined();
  });

  test("is_day: 0 is night, anything else (1, or missing) is day", async () => {
    const night = answering(200, forecastBody(0, [], { current: { time: 0, is_day: 0 } }));
    expect((await night.api.forecast(LAT, LON)).current.isDay).toBe(false);
    const day = answering(200, forecastBody(0, [], { current: { time: 0, is_day: 1 } }));
    expect((await day.api.forecast(LAT, LON)).current.isDay).toBe(true);
    const unknown = answering(200, forecastBody(0, []));
    expect((await unknown.api.forecast(LAT, LON)).current.isDay).toBe(true);
  });
});

// ───────── daily dates ─────────

describe("daily dates", () => {
  const dates = async (offset: number, days: number[]) => {
    const { api } = answering(200, forecastBody(offset, days));
    return (await api.forecast(LAT, LON)).days.map((d) => d.date);
  };
  const seconds = (iso: string) => Date.parse(iso) / 1000;

  test("each day's start, read with the place's offset, is its local date", async () => {
    // Midnight in Seattle (UTC-7) on two days in October.
    expect(
      await dates(-25_200, [seconds("2026-10-05T07:00:00Z"), seconds("2026-10-06T07:00:00Z")]),
    ).toEqual(["2026-10-05", "2026-10-06"]);
  });

  test("east of UTC and on a half-hour offset", async () => {
    // Midnight in Kolkata (UTC+5:30) falls on the day before in UTC.
    expect(await dates(19_800, [seconds("2026-10-04T18:30:00Z")])).toEqual(["2026-10-05"]);
  });

  test("a day after clocks fall back starts an hour later than today's offset says", async () => {
    // Asked on Oct 31 at UTC-7; Nov 2 starts at midnight PST, 08:00 UTC, which UTC-7 reads as 1 am.
    expect(
      await dates(-25_200, [
        seconds("2026-10-31T07:00:00Z"),
        seconds("2026-11-01T07:00:00Z"),
        seconds("2026-11-02T08:00:00Z"),
        seconds("2026-11-03T08:00:00Z"),
      ]),
    ).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  test("a day after clocks spring forward starts an hour earlier, and is still its own date", async () => {
    // Asked on Mar 13 at UTC-8; Mar 15 starts at midnight PDT, 07:00 UTC, which UTC-8 reads as
    // 11 pm the day before. Truncating instead of rounding would name it Mar 14 twice.
    expect(
      await dates(-28_800, [
        seconds("2027-03-13T08:00:00Z"),
        seconds("2027-03-14T08:00:00Z"),
        seconds("2027-03-15T07:00:00Z"),
        seconds("2027-03-16T07:00:00Z"),
      ]),
    ).toEqual(["2027-03-13", "2027-03-14", "2027-03-15", "2027-03-16"]);
  });

  test("the southern hemisphere's change, east of UTC", async () => {
    // Sydney moves from UTC+10 to UTC+11 on Oct 4 2026; asked on Oct 3 at +10.
    expect(
      await dates(36_000, [
        seconds("2026-10-02T14:00:00Z"),
        seconds("2026-10-03T14:00:00Z"),
        seconds("2026-10-04T13:00:00Z"),
      ]),
    ).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
  });

  test("no offset in the response reads as UTC", async () => {
    const { api } = answering(200, {
      current: { time: 0 },
      hourly: { time: [] },
      daily: { time: [seconds("2026-10-05T00:00:00Z")] },
    });
    expect((await api.forecast(LAT, LON)).days.map((d) => d.date)).toEqual(["2026-10-05"]);
  });
});

// ───────── air quality ─────────

describe("airQuality", () => {
  test("reads the recorded response", async () => {
    const cloud = await FakeOpenMeteo.create();
    expect(await new OpenMeteoApi(cloud.fetch).airQuality(LAT, LON)).toEqual({
      at: 1_791_212_400_000,
      usAqi: 56,
      europeanAqi: 43,
      pm25: 13.7,
      pm10: 13.9,
    });
  });

  test("null readings become undefined", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.air.current.us_aqi = null;
    cloud.air.current.pm10 = null;
    const air = await new OpenMeteoApi(cloud.fetch).airQuality(LAT, LON);
    expect(air.usAqi).toBeUndefined();
    expect(air.pm10).toBeUndefined();
    expect(air.pm25).toBe(13.7);
  });
});

// ───────── errors ─────────

describe("errors", () => {
  test("an unreachable API is an OpenMeteoError saying so", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.down = true;
    const err = await rejection(new OpenMeteoApi(cloud.fetch).forecast(LAT, LON));
    expect(err.name).toBe("OpenMeteoError");
    expect(err.message).toBe("Cannot reach Open-Meteo: getaddrinfo ENOTFOUND api.open-meteo.com");
  });

  test("a thrown non-Error is still worded", async () => {
    const api = new OpenMeteoApi(() => Promise.reject("socket hang up"));
    expect((await rejection(api.forecast(LAT, LON))).message).toBe(
      "Cannot reach Open-Meteo: socket hang up",
    );
  });

  test("a 400 carries Open-Meteo's reason", async () => {
    const cloud = await FakeOpenMeteo.create();
    const err = await rejection(new OpenMeteoApi(cloud.fetch).forecast(95, LON));
    expect(err.message).toBe("Open-Meteo answered 400: Latitude must be in range of -90 to 90°.");
  });

  test("429 says the request limit is used up", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.status = 429;
    expect((await rejection(new OpenMeteoApi(cloud.fetch).forecast(LAT, LON))).message).toBe(
      "Open-Meteo's request limit is used up",
    );
    expect((await rejection(new OpenMeteoApi(cloud.fetch).airQuality(LAT, LON))).message).toBe(
      "Open-Meteo's request limit is used up",
    );
  });

  test("an error with no reason, or no JSON body, gives the status alone", async () => {
    expect(
      (await rejection(answering(502, "<html>Bad gateway</html>").api.forecast(LAT, LON))).message,
    ).toBe("Open-Meteo answered 502");
    expect((await rejection(answering(500, { error: true }).api.forecast(LAT, LON))).message).toBe(
      "Open-Meteo answered 500",
    );
  });

  test("the air-quality API failing is an OpenMeteoError too", async () => {
    const cloud = await FakeOpenMeteo.create();
    cloud.airDown = true;
    expect((await rejection(new OpenMeteoApi(cloud.fetch).airQuality(LAT, LON))).message).toBe(
      "Open-Meteo answered 500: Internal",
    );
  });
});
