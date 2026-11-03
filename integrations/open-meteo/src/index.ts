// Weather for one place from Open-Meteo: conditions now and the forecast as a weather entity,
// the readings worth a history as sensors, sun times, and air quality. No account or key.

import type {
  EntityId,
  IntegrationContext,
  SensorState,
  WeatherCondition,
} from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import {
  type AirQuality,
  type Fetch,
  type Forecast,
  type Hour,
  OpenMeteoApi,
  OpenMeteoError,
} from "./api.ts";
import { condition, worst } from "./condition.ts";

const configSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Names the device and its entities; give a second place its own ("Cabin weather"). */
  label: z.string().min(1).default("Weather"),
  /** How often to ask. Open-Meteo's own values move every fifteen minutes at most. */
  pollMinutes: z.number().min(5).max(180).default(15),
  /** Also read the air-quality model: an index, PM2.5 and PM10. */
  airQuality: z.boolean().default(true),
  /** Which air quality index the index sensor reports. */
  aqi: z.enum(["us", "european"]).default("us"),
});
type Config = z.infer<typeof configSchema>;
type Ctx = IntegrationContext<Config>;

export interface OpenMeteoOptions {
  fetch?: Fetch;
  now?: () => number;
}

/** Open-Meteo's data is CC BY 4.0, which asks that it be credited where it is shown. */
export const ATTRIBUTION = "Weather data by Open-Meteo.com";

/** Failed polls in a row before the entities are marked unavailable. */
const MAX_FAILURES = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far ahead `conditionNext12h` looks. */
const AHEAD = 12 * HOUR;

/**
 * The most severe sky from now through the next twelve hours: the conditions now and every
 * hour that ends in that span, so clear now with rain this afternoon is rain.
 */
export function conditionAhead(forecast: Forecast, now: number): WeatherCondition {
  const sky = condition(forecast.current.code, daytime(forecast, now));
  const hours = forecast.hours
    .filter((hour) => hour.at > now && hour.at <= now + AHEAD)
    .map((hour) => condition(hour.code, hour.isDay));
  return worst([sky, ...hours]) ?? sky;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * What fell in the day before `now` and what is expected in the day after, in mm, with the
 * highest chance of any in that day. Undefined where the hours do not reach.
 */
export function precipitation(
  hours: Hour[],
  now: number,
): { last24h?: number; next24h?: number; chance?: number } {
  const sum = (from: number, to: number) => {
    const fell = hours
      .filter((hour) => hour.at > from && hour.at <= to)
      .flatMap((hour) => (hour.precipitation === undefined ? [] : [hour.precipitation]));
    return fell.length ? tenth(fell.reduce((a, b) => a + b, 0)) : undefined;
  };
  const chances = hours
    .filter((hour) => hour.at > now && hour.at <= now + DAY)
    .flatMap((hour) =>
      hour.precipitationProbability === undefined ? [] : [hour.precipitationProbability],
    );
  return {
    last24h: sum(now - DAY, now),
    next24h: sum(now, now + DAY),
    chance: chances.length ? Math.max(...chances) : undefined,
  };
}

/** Every sunrise and sunset the forecast knows, in order. */
function sunTurns(forecast: Forecast): { at: number; day: boolean }[] {
  return forecast.days
    .flatMap(({ sunrise, sunset }) =>
      // Where the sun does not rise or set there is no pair to go by.
      sunrise && sunset && sunrise < sunset
        ? [
            { at: sunrise, day: true },
            { at: sunset, day: false },
          ]
        : [],
    )
    .sort((a, b) => a.at - b.at);
}

/**
 * Whether the sun is up at `now`, from the forecast's sun times: to the minute, where the
 * model's own flag covers a quarter of an hour. That flag is the fallback where there are none.
 */
export function daytime(forecast: Forecast, now: number): boolean {
  const turns = sunTurns(forecast);
  const last = turns.findLast((turn) => turn.at <= now);
  if (last) return last.day;
  const next = turns[0];
  return next ? !next.day : forecast.current.isDay;
}

/** "7:12 am", on the clock of the place the forecast is for. */
function clockIn(timeZone: string | undefined): (ms: number) => string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = format(timeZone);
  } catch {
    // A zone name the runtime does not know falls back to the server's zone, not to an error.
    formatter = format(undefined);
  }
  return (ms) => formatter.format(ms).toLowerCase().replace(/\s/g, " ");
}

interface Reading<T> {
  key: string;
  name: string;
  unit?: string;
  deviceClass?: SensorState["deviceClass"];
  value: (from: T) => number | undefined;
}

interface Snapshot {
  forecast: Forecast;
  rain: ReturnType<typeof precipitation>;
}

const READINGS: Reading<Snapshot>[] = [
  {
    key: "temperature",
    name: "temperature",
    unit: "°C",
    deviceClass: "temperature",
    value: ({ forecast }) => forecast.current.temperature,
  },
  {
    key: "apparent-temperature",
    name: "feels like",
    unit: "°C",
    deviceClass: "temperature",
    value: ({ forecast }) => forecast.current.apparentTemperature,
  },
  {
    key: "humidity",
    name: "humidity",
    unit: "%",
    deviceClass: "humidity",
    value: ({ forecast }) => forecast.current.humidity,
  },
  {
    key: "wind-speed",
    name: "wind speed",
    unit: "km/h",
    value: ({ forecast }) => forecast.current.windSpeed,
  },
  {
    key: "wind-gusts",
    name: "wind gusts",
    unit: "km/h",
    value: ({ forecast }) => forecast.current.windGusts,
  },
  {
    key: "pressure",
    name: "pressure",
    unit: "hPa",
    value: ({ forecast }) => forecast.current.pressure,
  },
  { key: "uv-index", name: "UV index", value: ({ forecast }) => forecast.current.uvIndex },
  {
    key: "precipitation-last-24h",
    name: "precipitation last 24h",
    unit: "mm",
    value: ({ rain }) => rain.last24h,
  },
  {
    key: "precipitation-next-24h",
    name: "precipitation next 24h",
    unit: "mm",
    value: ({ rain }) => rain.next24h,
  },
  {
    key: "precipitation-chance",
    name: "precipitation chance",
    unit: "%",
    value: ({ rain }) => rain.chance,
  },
];

const airReadings = (aqi: Config["aqi"]): Reading<AirQuality>[] => [
  {
    key: "aqi",
    name: "air quality index",
    value: (air) => (aqi === "us" ? air.usAqi : air.europeanAqi),
  },
  { key: "pm2-5", name: "PM2.5", unit: "µg/m³", value: (air) => air.pm25 },
  { key: "pm10", name: "PM10", unit: "µg/m³", value: (air) => air.pm10 },
];

type Sensor<T> = { id: EntityId; reading: Reading<T> };

class Station {
  private readonly weather: EntityId;
  private readonly sensors: Sensor<Snapshot>[];
  private readonly sunrise: EntityId;
  private readonly sunset: EntityId;
  private readonly daytime: EntityId;
  private readonly air: Sensor<AirQuality>[];
  private failures = 0;
  private airFailures = 0;
  /** Cancels the report waiting for the next sunrise or sunset. */
  private cancelTurn?: () => void;
  timeZone?: string;
  /** When the conditions last read were observed. */
  observedAt?: number;

  constructor(
    private readonly ctx: Ctx,
    private readonly api: OpenMeteoApi,
    private readonly now: () => number,
  ) {
    const { label } = ctx.config;
    const deviceId = ctx.registerDevice({
      uniqueId: "weather",
      name: label,
      manufacturer: "Open-Meteo",
    }).id;
    const sensor = <T>(reading: Reading<T>): Sensor<T> => ({
      id: ctx.registerEntity({
        uniqueId: reading.key,
        domain: "sensor",
        name: `${label} ${reading.name}`,
        deviceId,
      }).id,
      reading,
    });
    this.weather = ctx.registerEntity({
      uniqueId: "weather",
      domain: "weather",
      name: label,
      deviceId,
    }).id;
    this.sensors = READINGS.map(sensor);
    this.sunrise = sensor({ key: "sunrise", name: "sunrise", value: () => undefined }).id;
    this.sunset = sensor({ key: "sunset", name: "sunset", value: () => undefined }).id;
    this.daytime = ctx.registerEntity({
      uniqueId: "daytime",
      domain: "binary_sensor",
      name: `${label} daytime`,
      deviceId,
    }).id;
    this.air = ctx.config.airQuality ? airReadings(ctx.config.aqi).map(sensor) : [];
  }

  /** Reads the forecast and reports everything that comes from it. Throws if it cannot. */
  async refresh(): Promise<void> {
    const { latitude, longitude } = this.ctx.config;
    this.show(await this.api.forecast(latitude, longitude));
    this.failures = 0;
  }

  /** Reads air quality, if asked for. Never throws: the weather does not depend on it. */
  async refreshAir(): Promise<void> {
    const { ctx } = this;
    if (this.air.length === 0) return;
    try {
      const air = await this.api.airQuality(ctx.config.latitude, ctx.config.longitude);
      for (const { id, reading } of this.air) this.report(id, reading, air, { observedAt: air.at });
      this.airFailures = 0;
    } catch (err) {
      this.airFailures++;
      ctx.log.warn("Open-Meteo air quality poll failed", {
        error: err instanceof Error ? err.message : String(err),
        failures: this.airFailures,
      });
      if (this.airFailures === MAX_FAILURES) {
        for (const { id } of this.air) ctx.setAvailable(id, false);
      }
    }
  }

  async poll(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.failed(err);
    }
    await this.refreshAir();
  }

  private failed(err: unknown): void {
    const { ctx } = this;
    this.failures++;
    ctx.log.warn("Open-Meteo poll failed", {
      error: err instanceof Error ? err.message : String(err),
      failures: this.failures,
    });
    // A forecast stays true for a while; only after several misses is it too old to show.
    if (this.failures !== MAX_FAILURES) return;
    this.cancelTurn?.();
    for (const id of [
      this.weather,
      ...this.sensors.map((s) => s.id),
      this.sunrise,
      this.sunset,
      this.daytime,
    ]) {
      ctx.setAvailable(id, false);
    }
  }

  private report<T>(id: EntityId, reading: Reading<T>, from: T, attributes?: object): void {
    this.ctx.reportState(
      id,
      {
        domain: "sensor",
        value: reading.value(from) ?? null,
        unit: reading.unit,
        deviceClass: reading.deviceClass,
      },
      attributes && { ...attributes },
    );
  }

  private show(forecast: Forecast): void {
    const { ctx } = this;
    const now = this.now();
    const { current } = forecast;
    const up = daytime(forecast, now);
    this.timeZone = forecast.timeZone;
    this.observedAt = current.at;

    ctx.reportState(
      this.weather,
      {
        domain: "weather",
        condition: condition(current.code, up),
        temperature: current.temperature,
        apparentTemperature: current.apparentTemperature,
        humidity: current.humidity,
        windSpeed: current.windSpeed,
        windBearing: current.windBearing,
      },
      {
        observedAt: current.at,
        precipitation: current.precipitation,
        pressure: current.pressure,
        windGusts: current.windGusts,
        uvIndex: current.uvIndex,
        // The worst of now and the next twelve hours, for "rain later" on a switch's LEDs.
        conditionNext12h: conditionAhead(forecast, now),
        timeZone: forecast.timeZone,
        // Where the forecast is for, so a page can work out the sun's height at any moment.
        latitude: ctx.config.latitude,
        longitude: ctx.config.longitude,
        daily: forecast.days.map(({ code, ...day }) => ({
          ...day,
          condition: condition(code, true),
        })),
        // From the hour under way onward.
        hourly: forecast.hours
          .filter((hour) => hour.at > now - HOUR)
          .map(({ code, isDay, ...hour }) => ({ ...hour, condition: condition(code, isDay) })),
        attribution: ATTRIBUTION,
      },
    );

    const snapshot = { forecast, rain: precipitation(forecast.hours, now) };
    for (const { id, reading } of this.sensors) this.report(id, reading, snapshot);

    const clock = clockIn(forecast.timeZone);
    const [today, tomorrow] = forecast.days;
    for (const [id, key] of [
      [this.sunrise, "sunrise"],
      [this.sunset, "sunset"],
    ] as const) {
      const at = today?.[key];
      ctx.reportState(
        id,
        { domain: "sensor", value: at === undefined ? null : clock(at) },
        { at, tomorrow: tomorrow?.[key] },
      );
    }

    ctx.reportState(this.daytime, { domain: "binary_sensor", on: up });
    // The sun does not wait for the next poll: report its next turn when it happens.
    this.cancelTurn?.();
    const next = sunTurns(forecast).find((turn) => turn.at > now);
    this.cancelTurn =
      next &&
      ctx.scheduler.after(next.at - now, () => {
        ctx.reportState(this.daytime, { domain: "binary_sensor", on: next.day });
      });
  }
}

/** `fetch` and the clock are injectable for tests. */
export const createOpenMeteoIntegration = (options: OpenMeteoOptions = {}) =>
  defineIntegration({
    id: "open-meteo",
    name: "Open-Meteo weather",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const station = new Station(ctx, new OpenMeteoApi(options.fetch), options.now ?? Date.now);

      // Bad coordinates or an unreachable API reject setup; the host retries with backoff.
      await station.refresh();
      await station.refreshAir();
      ctx.scheduler.every(ctx.config.pollMinutes * 60_000, () => station.poll());

      const status = () => ({
        latitude: ctx.config.latitude,
        longitude: ctx.config.longitude,
        timeZone: station.timeZone ?? null,
        observedAt: station.observedAt ?? null,
        pollMinutes: ctx.config.pollMinutes,
      });
      ctx.registerAction("refresh", z.strictObject({}), async () => {
        await station.refresh();
        await station.refreshAir();
        return status();
      });
      ctx.registerAction("status", z.strictObject({}), async () => status());
    },
  });

export { OpenMeteoError };
export default createOpenMeteoIntegration();
