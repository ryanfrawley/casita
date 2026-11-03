// Tesla vehicles through the Fleet API, read-only: battery, range, charging, temperatures,
// lock state. Commands are not implemented; they need signed requests (see README).

import type { EntityId, EntityState, IntegrationContext, SensorState } from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import {
  type Fetch,
  REGIONS,
  type Region,
  TeslaApi,
  TeslaError,
  type Tokens,
  type VehicleData,
} from "./api.ts";

const configSchema = z.strictObject({
  /** From the application created at developer.tesla.com. */
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  region: z.enum(Object.keys(REGIONS) as [Region, ...Region[]]).default("na"),
  /** Must match a redirect URI allowed on the Tesla application. */
  redirectUri: z.url(),
  /** Optional starting refresh token; otherwise use the authorize_url action. */
  refreshToken: z.string().optional(),
  /**
   * How often to read each vehicle that is awake. Every read is billed by Tesla and
   * frequent reads keep the car from sleeping, so this is deliberately slow.
   */
  pollMinutes: z.number().min(1).default(30),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

export interface TeslaOptions {
  fetch?: Fetch;
  now?: () => number;
}

/** Stored tokens, tagged with the config token they started from so a new one takes over. */
type Stored = Tokens & { seed?: string };
const TOKENS_KEY = "tokens";
const STATE_KEY = "oauth_state";
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

type Reading = { key: string; label: string; state(data: VehicleData): EntityState | undefined } & (
  | { domain: "sensor" }
  | { domain: "binary_sensor" }
  | { domain: "lock" }
);

const sensor = (
  key: string,
  label: string,
  unit: string,
  deviceClass: SensorState["deviceClass"],
  read: (data: VehicleData) => number | null | undefined,
): Reading => ({
  key,
  label,
  domain: "sensor",
  state(data) {
    const value = read(data);
    return typeof value === "number" ? { domain: "sensor", value, unit, deviceClass } : undefined;
  },
});

/** What each vehicle exposes. Units are as Tesla reports them: miles, kW, °C. */
const READINGS: Reading[] = [
  sensor("battery", "battery", "%", "battery", (d) => d.charge_state?.battery_level),
  sensor("range", "range", "mi", undefined, (d) => d.charge_state?.battery_range),
  sensor("charge-limit", "charge limit", "%", undefined, (d) => d.charge_state?.charge_limit_soc),
  sensor("charger-power", "charger power", "kW", "power", (d) => d.charge_state?.charger_power),
  sensor(
    "time-to-full",
    "time to full charge",
    "min",
    undefined,
    (d) => d.charge_state?.minutes_to_full_charge,
  ),
  sensor(
    "inside-temp",
    "inside temperature",
    "°C",
    "temperature",
    (d) => d.climate_state?.inside_temp,
  ),
  sensor(
    "outside-temp",
    "outside temperature",
    "°C",
    "temperature",
    (d) => d.climate_state?.outside_temp,
  ),
  sensor("odometer", "odometer", "mi", undefined, (d) =>
    typeof d.vehicle_state?.odometer === "number"
      ? Math.round(d.vehicle_state.odometer)
      : undefined,
  ),
  {
    key: "charging",
    label: "charging",
    domain: "binary_sensor",
    state: (d) =>
      d.charge_state?.charging_state
        ? {
            domain: "binary_sensor",
            on: ["Charging", "Starting"].includes(d.charge_state.charging_state),
          }
        : undefined,
  },
  {
    key: "plugged-in",
    label: "plugged in",
    domain: "binary_sensor",
    state: (d) =>
      d.charge_state?.charging_state
        ? { domain: "binary_sensor", on: d.charge_state.charging_state !== "Disconnected" }
        : undefined,
  },
  {
    key: "locked",
    label: "doors",
    domain: "lock",
    state: (d) =>
      typeof d.vehicle_state?.locked === "boolean"
        ? { domain: "lock", locked: d.vehicle_state.locked }
        : undefined,
  },
];

class Garage {
  /** VIN → its entities, by reading key; "awake" is the sleep-state sensor. */
  private readonly vehicles = new Map<string, Map<string, EntityId>>();
  /** What each car last said about itself; a sleeping car says nothing. */
  private readonly known = new Map<string, { model?: string; firmware?: string }>();
  private refreshing?: Promise<string>;
  lastPoll?: number;
  lastError?: string;

  constructor(
    private readonly ctx: Ctx,
    private readonly api: TeslaApi,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.vehicles.size;
  }

  async authorized(): Promise<boolean> {
    return (await this.stored()) !== undefined;
  }

  /** Stored tokens, unless config names a different starting refresh token than they came from. */
  private async stored(): Promise<Stored | undefined> {
    const seed = this.ctx.config.refreshToken;
    const stored = await this.ctx.storage.get<Stored>(TOKENS_KEY);
    if (stored && (seed === undefined || stored.seed === seed)) return stored;
    return seed ? { accessToken: "", refreshToken: seed, expiresAt: 0, seed } : undefined;
  }

  async save(tokens: Tokens, seed?: string): Promise<void> {
    await this.ctx.storage.set<Stored>(TOKENS_KEY, { ...tokens, seed });
  }

  /**
   * A usable access token, refreshing (and persisting the rotated refresh token) when needed.
   * Callers share one attempt from the moment the stored tokens are read: the refresh token
   * is single use, so two refreshes from the same one would lock the account out.
   */
  private accessToken(): Promise<string> {
    this.refreshing ??= (async () => {
      const stored = await this.stored();
      if (!stored)
        throw new TeslaError("Not authorized with Tesla yet; run the authorize_url action", true);
      if (stored.accessToken && stored.expiresAt - EXPIRY_MARGIN_MS > this.now())
        return stored.accessToken;
      const tokens = await this.api.refresh(stored.refreshToken);
      await this.save(tokens, stored.seed);
      return tokens.accessToken;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Lists the vehicles, then reads each one that is awake. Sleeping cars are left asleep. */
  async poll(): Promise<void> {
    const { ctx, api } = this;
    try {
      const token = await this.accessToken();
      const vehicles = await api.vehicles(token);
      // A car that has left the account goes from here too.
      for (const [vin, entities] of this.vehicles) {
        if (vehicles.some((v) => v.vin === vin)) continue;
        for (const id of entities.values()) ctx.removeEntity(id);
        this.vehicles.delete(vin);
      }
      for (const vehicle of vehicles) {
        const name = vehicle.display_name || `Tesla ${vehicle.vin.slice(-6)}`;
        const online = vehicle.state === "online";
        const data = online ? await api.vehicleData(token, vehicle.vin) : undefined;
        const known = {
          model: data?.vehicle_config?.car_type ?? this.known.get(vehicle.vin)?.model,
          firmware: data?.vehicle_state?.car_version ?? this.known.get(vehicle.vin)?.firmware,
        };
        this.known.set(vehicle.vin, known);
        const deviceId = ctx.registerDevice({
          uniqueId: vehicle.vin,
          name,
          manufacturer: "Tesla",
          model: known.model,
          firmware: known.firmware,
        }).id;

        let entities = this.vehicles.get(vehicle.vin);
        if (!entities) {
          entities = new Map();
          this.vehicles.set(vehicle.vin, entities);
        }
        const entity = (key: string, domain: Reading["domain"], label: string) => {
          const id = ctx.registerEntity({
            uniqueId: `${vehicle.vin}-${key}`,
            domain,
            name: `${name} ${label}`,
            deviceId,
          }).id;
          entities.set(key, id);
          return id;
        };
        ctx.reportState(entity("awake", "binary_sensor", "awake"), {
          domain: "binary_sensor",
          on: data !== undefined,
        });
        for (const reading of READINGS) {
          const id = entity(reading.key, reading.domain, reading.label);
          // While the car sleeps, the last values it reported stay as they are.
          const state = data ? reading.state(data) : undefined;
          if (state) ctx.reportState(id, state);
          else ctx.setAvailable(id, true);
        }
      }
      this.lastPoll = this.now();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      ctx.log.warn("Tesla poll failed", { error: this.lastError });
      // Without a valid login nothing is known any more; a passing network error changes nothing.
      if (err instanceof TeslaError && err.reauthorize) {
        for (const entities of this.vehicles.values())
          for (const id of entities.values()) ctx.setAvailable(id, false);
      }
    }
  }
}

/** `fetch` and the clock are injectable for tests. */
export const createTeslaIntegration = (options: TeslaOptions = {}) =>
  defineIntegration({
    id: "tesla",
    name: "Tesla",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const now = options.now ?? Date.now;
      const { clientId, clientSecret, region, redirectUri } = ctx.config;
      const api = new TeslaApi({
        clientId,
        clientSecret,
        region,
        redirectUri,
        fetch: options.fetch,
        now,
      });
      const garage = new Garage(ctx, api, now);

      ctx.registerAction("authorize_url", z.strictObject({}), async () => {
        const state = crypto.randomUUID();
        await ctx.storage.set(STATE_KEY, state);
        return {
          url: api.authorizeUrl(state),
          next: "Open the url, log in, then pass the `code` from the redirect to complete_authorization.",
        };
      });
      ctx.registerAction(
        "complete_authorization",
        z.strictObject({ code: z.string().min(1), state: z.string().optional() }),
        async ({ code, state }) => {
          const expected = await ctx.storage.get<string>(STATE_KEY);
          if (state !== undefined && state !== expected)
            throw new Error("That state does not match the last authorize_url");
          await garage.save(await api.exchangeCode(code), ctx.config.refreshToken);
          await ctx.storage.delete(STATE_KEY);
          await garage.poll();
          if (garage.lastError) throw new Error(garage.lastError);
          return { vehicles: garage.size };
        },
      );
      ctx.registerAction(
        "register_partner",
        z.strictObject({ domain: z.string().min(1) }),
        async ({ domain }) => ({
          registered: await api.registerPartner(domain),
        }),
      );
      ctx.registerAction("refresh", z.strictObject({}), async () => {
        await garage.poll();
        if (garage.lastError) throw new Error(garage.lastError);
        return { vehicles: garage.size };
      });
      ctx.registerAction("status", z.strictObject({}), async () => ({
        authorized: await garage.authorized(),
        vehicles: garage.size,
        lastPoll: garage.lastPoll ?? null,
        lastError: garage.lastError ?? null,
      }));

      if (await garage.authorized()) await garage.poll();
      else ctx.log.warn("not authorized with Tesla yet; run the authorize_url action");
      ctx.scheduler.every(ctx.config.pollMinutes * 60_000, async () => {
        if (await garage.authorized()) await garage.poll();
      });
    },
  });

export default createTeslaIntegration();
