// Rachio's public REST API (https://rachio.readme.io): the calls this integration makes,
// with the daily request budget tracked from the rate-limit headers.

import { z } from "zod";

const BASE = "https://api.rach.io/1/public";

/** Rachio allows 3,500 requests a day per account, reset at midnight UTC. */
export const DAILY_LIMIT = 3500;

const zone = z.looseObject({
  id: z.string(),
  zoneNumber: z.number(),
  name: z.string(),
  enabled: z.boolean().default(true),
  /** Epoch milliseconds and seconds of the last run, scheduled or manual. */
  lastWateredDate: z.number().optional(),
  lastWateredDuration: z.number().optional(),
});

const scheduleRule = z.looseObject({
  name: z.string().default("Schedule"),
  enabled: z.boolean().default(true),
  /** Rachio's own wording, e.g. "Every Mon, Thu, Sat end by sunrise". */
  summary: z.string().optional(),
  /** DAY_OF_WEEK_0 (Sunday) to DAY_OF_WEEK_6, or interval and odd/even types. */
  scheduleJobTypes: z.array(z.string()).default([]),
  zones: z.array(z.looseObject({ zoneId: z.string() })).default([]),
});
export type RachioScheduleRule = z.infer<typeof scheduleRule>;

const device = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(), // ONLINE | OFFLINE
  on: z.boolean().default(true), // false: standby, no schedules run
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  rainDelayExpirationDate: z.number().optional(),
  rainSensorTripped: z.boolean().optional(),
  /** IANA zone the controller's schedules run in. */
  timeZone: z.string().optional(),
  scheduleRules: z.array(scheduleRule).default([]),
  flexScheduleRules: z.array(scheduleRule).default([]),
  zones: z.array(zone).default([]),
});
export type RachioDevice = z.infer<typeof device>;

const person = z.looseObject({ id: z.string(), devices: z.array(device).default([]) });

/** `{}` when nothing is running. */
const schedule = z.looseObject({
  status: z.string().optional(), // PROCESSING while watering
  zoneId: z.string().optional(),
  zoneStartDate: z.number().optional(),
  zoneDuration: z.number().optional(), // seconds
});
export type RachioSchedule = z.infer<typeof schedule>;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class RachioError extends Error {
  constructor(
    message: string,
    /** When the request budget resets, if that is why the call failed. */
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "RachioError";
  }
}

export class RachioApi {
  /** Requests left today, as of the last response; undefined before the first one. */
  remaining?: number;
  private resetAt?: number;

  constructor(
    private readonly apiKey: string,
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every controller on the account, with its zones. Two requests. */
  async devices(): Promise<RachioDevice[]> {
    const info = z.looseObject({ id: z.string() }).parse(await this.request("GET", "/person/info"));
    return person.parse(await this.request("GET", `/person/${info.id}`)).devices;
  }

  async currentSchedule(deviceId: string): Promise<RachioSchedule> {
    return schedule.parse(
      (await this.request("GET", `/device/${deviceId}/current_schedule`)) ?? {},
    );
  }

  /** Runs one zone for `seconds` (at most three hours). */
  startZone(zoneId: string, seconds: number): Promise<unknown> {
    return this.request("PUT", "/zone/start", {
      id: zoneId,
      duration: Math.min(10_800, Math.round(seconds)),
    });
  }

  stopWater(deviceId: string): Promise<unknown> {
    return this.request("PUT", "/device/stop_water", { id: deviceId });
  }

  /** Skips schedules for `seconds`; zero cancels a delay. */
  rainDelay(deviceId: string, seconds: number): Promise<unknown> {
    return this.request("PUT", "/device/rain_delay", {
      id: deviceId,
      duration: Math.round(seconds),
    });
  }

  /** Standby off or on: whether the controller runs its schedules. */
  setEnabled(deviceId: string, enabled: boolean): Promise<unknown> {
    return this.request("PUT", `/device/${enabled ? "on" : "off"}`, { id: deviceId });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (
      this.remaining !== undefined &&
      this.remaining <= 0 &&
      this.resetAt &&
      this.now() < this.resetAt
    ) {
      throw new RachioError("Rachio's daily request limit is used up", this.resetAt);
    }
    let response: Response;
    try {
      response = await this.fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new RachioError(
        `Cannot reach Rachio: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // An absent or empty header says nothing; Number("") would read as zero.
    const remaining = Number(response.headers.get("x-ratelimit-remaining")?.trim() || Number.NaN);
    const reset = Date.parse(response.headers.get("x-ratelimit-reset") ?? "");
    if (Number.isFinite(remaining)) this.remaining = remaining;
    if (Number.isFinite(reset)) this.resetAt = reset;

    if (response.status === 401 || response.status === 403)
      throw new RachioError("Rachio rejected the API key");
    if (response.status === 429) {
      this.remaining = 0;
      throw new RachioError("Rachio's daily request limit is used up", this.resetAt);
    }
    if (!response.ok) {
      const detail = z
        .looseObject({ error: z.string() })
        .safeParse(await response.json().catch(() => undefined));
      throw new RachioError(
        `Rachio answered ${response.status}${detail.success ? `: ${detail.data.error}` : ""}`,
      );
    }
    return response.status === 204 ? undefined : response.json().catch(() => undefined);
  }
}
