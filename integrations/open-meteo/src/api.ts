// Open-Meteo's forecast and air-quality APIs (https://open-meteo.com/en/docs): the two calls
// this integration makes, read into plain values with times in epoch milliseconds.

import { z } from "zod";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY = "https://air-quality-api.open-meteo.com/v1/air-quality";

const CURRENT = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "is_day",
  "precipitation",
  "weather_code",
  "pressure_msl",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
];
const HOURLY = [
  "temperature_2m",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
  "is_day",
];
const DAILY = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "sunrise",
  "sunset",
  "uv_index_max",
  "wind_speed_10m_max",
];

/** How many hours back and ahead the hourly values reach. */
export const PAST_HOURS = 24;
export const FORECAST_HOURS = 48;
export const FORECAST_DAYS = 7;

/** A model can have no value for a variable at some hour; that comes as null. */
const reading = z.number().nullish();
const readings = z.array(z.number().nullable()).default([]);

const forecastSchema = z.looseObject({
  /** The place's offset from UTC now, which is what the daily dates are worked out with. */
  utc_offset_seconds: z.number().default(0),
  timezone: z.string().optional(),
  current: z.looseObject({
    time: z.number(),
    temperature_2m: reading,
    relative_humidity_2m: reading,
    apparent_temperature: reading,
    is_day: reading,
    precipitation: reading,
    weather_code: reading,
    pressure_msl: reading,
    wind_speed_10m: reading,
    wind_direction_10m: reading,
    wind_gusts_10m: reading,
    uv_index: reading,
  }),
  hourly: z.looseObject({
    time: z.array(z.number()),
    temperature_2m: readings,
    precipitation_probability: readings,
    precipitation: readings,
    weather_code: readings,
    wind_speed_10m: readings,
    is_day: readings,
  }),
  daily: z.looseObject({
    time: z.array(z.number()),
    weather_code: readings,
    temperature_2m_max: readings,
    temperature_2m_min: readings,
    precipitation_sum: readings,
    precipitation_probability_max: readings,
    sunrise: readings,
    sunset: readings,
    uv_index_max: readings,
    wind_speed_10m_max: readings,
  }),
});

const airQualitySchema = z.looseObject({
  current: z.looseObject({
    time: z.number(),
    us_aqi: reading,
    european_aqi: reading,
    pm2_5: reading,
    pm10: reading,
  }),
});

/** Temperatures in °C, speeds in km/h, precipitation in mm, pressure in hPa. */
export interface Conditions {
  at: number;
  /** WMO weather code. */
  code?: number;
  isDay: boolean;
  temperature?: number;
  apparentTemperature?: number;
  humidity?: number;
  /** Fallen in the last fifteen minutes. */
  precipitation?: number;
  pressure?: number;
  windSpeed?: number;
  windBearing?: number;
  windGusts?: number;
  uvIndex?: number;
}

export interface Hour {
  /** When the hour ends: its precipitation is what fell in the hour before `at`. */
  at: number;
  code?: number;
  isDay: boolean;
  temperature?: number;
  precipitation?: number;
  precipitationProbability?: number;
  windSpeed?: number;
}

export interface Day {
  /** The local date, "2026-10-05". */
  date: string;
  code?: number;
  high?: number;
  low?: number;
  precipitation?: number;
  precipitationProbability?: number;
  sunrise?: number;
  sunset?: number;
  uvIndexMax?: number;
  windSpeedMax?: number;
}

export interface Forecast {
  /** IANA zone of the place, as Open-Meteo resolved it from the coordinates. */
  timeZone?: string;
  current: Conditions;
  /** The last day and the next two, oldest first. */
  hours: Hour[];
  /** Today first. */
  days: Day[];
}

export interface AirQuality {
  at: number;
  usAqi?: number;
  europeanAqi?: number;
  pm25?: number;
  pm10?: number;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenMeteoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeteoError";
  }
}

const DAY_SECONDS = 86_400;
const value = (list: (number | null)[], index: number): number | undefined =>
  list[index] ?? undefined;
const ms = (seconds: number | undefined): number | undefined =>
  seconds === undefined ? undefined : seconds * 1000;

/**
 * The local date of a day that starts at `seconds`. Rounded to the nearest day, since the
 * offset is today's and a day past a clock change starts an hour to either side of it.
 */
const localDate = (seconds: number, offset: number): string =>
  new Date(Math.round((seconds + offset) / DAY_SECONDS) * DAY_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);

/** An answer that is not the shape expected is Open-Meteo's failure, said in plain words. */
function read<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new OpenMeteoError("Open-Meteo sent an answer that could not be read");
  return parsed.data;
}

export class OpenMeteoApi {
  constructor(private readonly fetch: Fetch = globalThis.fetch) {}

  /** Conditions now, hourly values a day back and two ahead, and a week of days. One request. */
  async forecast(latitude: number, longitude: number): Promise<Forecast> {
    const raw = read(
      forecastSchema,
      await this.request(FORECAST, {
        latitude,
        longitude,
        current: CURRENT.join(","),
        hourly: HOURLY.join(","),
        daily: DAILY.join(","),
        past_hours: PAST_HOURS,
        forecast_hours: FORECAST_HOURS,
        forecast_days: FORECAST_DAYS,
        timeformat: "unixtime",
        timezone: "auto",
      }),
    );
    const { current, hourly, daily } = raw;
    return {
      timeZone: raw.timezone,
      current: {
        at: current.time * 1000,
        code: current.weather_code ?? undefined,
        isDay: current.is_day !== 0,
        temperature: current.temperature_2m ?? undefined,
        apparentTemperature: current.apparent_temperature ?? undefined,
        humidity: current.relative_humidity_2m ?? undefined,
        precipitation: current.precipitation ?? undefined,
        pressure: current.pressure_msl ?? undefined,
        windSpeed: current.wind_speed_10m ?? undefined,
        windBearing: current.wind_direction_10m ?? undefined,
        windGusts: current.wind_gusts_10m ?? undefined,
        uvIndex: current.uv_index ?? undefined,
      },
      hours: hourly.time.map((time, i) => ({
        at: time * 1000,
        code: value(hourly.weather_code, i),
        isDay: value(hourly.is_day, i) !== 0,
        temperature: value(hourly.temperature_2m, i),
        precipitation: value(hourly.precipitation, i),
        precipitationProbability: value(hourly.precipitation_probability, i),
        windSpeed: value(hourly.wind_speed_10m, i),
      })),
      days: daily.time.map((time, i) => ({
        date: localDate(time, raw.utc_offset_seconds),
        code: value(daily.weather_code, i),
        high: value(daily.temperature_2m_max, i),
        low: value(daily.temperature_2m_min, i),
        precipitation: value(daily.precipitation_sum, i),
        precipitationProbability: value(daily.precipitation_probability_max, i),
        sunrise: ms(value(daily.sunrise, i)),
        sunset: ms(value(daily.sunset, i)),
        uvIndexMax: value(daily.uv_index_max, i),
        windSpeedMax: value(daily.wind_speed_10m_max, i),
      })),
    };
  }

  /** Air quality now, from the nearest cell of the air-quality model. One request. */
  async airQuality(latitude: number, longitude: number): Promise<AirQuality> {
    const { current } = read(
      airQualitySchema,
      await this.request(AIR_QUALITY, {
        latitude,
        longitude,
        current: "us_aqi,european_aqi,pm2_5,pm10",
        timeformat: "unixtime",
        timezone: "auto",
      }),
    );
    return {
      at: current.time * 1000,
      usAqi: current.us_aqi ?? undefined,
      europeanAqi: current.european_aqi ?? undefined,
      pm25: current.pm2_5 ?? undefined,
      pm10: current.pm10 ?? undefined,
    };
  }

  private async request(base: string, params: Record<string, string | number>): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, param] of Object.entries(params)) query.set(key, String(param));
    let response: Response;
    try {
      response = await this.fetch(`${base}?${query}`, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new OpenMeteoError(
        `Cannot reach Open-Meteo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status === 429) throw new OpenMeteoError("Open-Meteo's request limit is used up");
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      // Errors come as `{ error: true, reason }`.
      const detail = z.looseObject({ reason: z.string() }).safeParse(body);
      throw new OpenMeteoError(
        `Open-Meteo answered ${response.status}${detail.success ? `: ${detail.data.reason}` : ""}`,
      );
    }
    return body;
  }
}
