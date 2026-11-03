// Tesla's Fleet API (https://developer.tesla.com/docs/fleet-api): OAuth tokens, the partner
// registration call, and the read-only vehicle endpoints this integration uses.

import { z } from "zod";

const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
export const REGIONS = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com", // North America and Asia-Pacific
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com", // Europe, Middle East, Africa
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
} as const;
export type Region = keyof typeof REGIONS;

/** Reading vehicle data. Commands would need vehicle_cmds and signed requests. */
const SCOPES = "openid offline_access vehicle_device_data";

const tokenResponse = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().default(28_800),
});

const vehicle = z.looseObject({
  vin: z.string(),
  display_name: z.string().nullish(),
  /** online | asleep | offline */
  state: z.string().default("offline"),
});
export type Vehicle = z.infer<typeof vehicle>;

const number = z.number().nullish();
export const vehicleData = vehicle.extend({
  charge_state: z
    .looseObject({
      battery_level: number,
      battery_range: number, // miles
      charge_limit_soc: number,
      charging_state: z.string().nullish(), // Disconnected | Stopped | Charging | Complete
      charger_power: number, // kW
      minutes_to_full_charge: number,
    })
    .optional(),
  climate_state: z.looseObject({ inside_temp: number, outside_temp: number }).optional(), // °C
  vehicle_state: z
    .looseObject({
      locked: z.boolean().nullish(),
      odometer: number,
      car_version: z.string().nullish(),
    })
    .optional(),
  vehicle_config: z.looseObject({ car_type: z.string().nullish() }).optional(),
});
export type VehicleData = z.infer<typeof vehicleData>;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** `reauthorize` means the user has to log in again; retrying will not help. */
export class TeslaError extends Error {
  constructor(
    message: string,
    readonly reauthorize = false,
  ) {
    super(message);
    this.name = "TeslaError";
  }
}

export interface TeslaApiOptions {
  clientId: string;
  clientSecret: string;
  region: Region;
  redirectUri: string;
  fetch?: Fetch;
  now?: () => number;
}

export class TeslaApi {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly base: string;

  constructor(private readonly opts: TeslaApiOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.base = REGIONS[opts.region];
  }

  /** Where the owner logs in and grants access; Tesla then redirects to `redirectUri` with a code. */
  authorizeUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    const query = {
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      scope: SCOPES,
      state,
    };
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  exchangeCode(code: string): Promise<Tokens> {
    return this.token({
      grant_type: "authorization_code",
      code,
      audience: this.base,
      redirect_uri: this.opts.redirectUri,
    });
  }

  /** Refresh tokens are single use: the one returned replaces the one passed in. */
  refresh(refreshToken: string): Promise<Tokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken);
  }

  /**
   * One-time setup per region: tells Tesla which domain hosts the app's public key
   * (at /.well-known/appspecific/com.tesla.3p.public-key.pem).
   */
  async registerPartner(domain: string): Promise<unknown> {
    const partner = await this.token({
      grant_type: "client_credentials",
      scope: SCOPES,
      audience: this.base,
    });
    return this.call("POST", "/api/1/partner_accounts", partner.accessToken, { domain });
  }

  /** Every vehicle on the account with its sleep state. Does not wake anything. */
  async vehicles(accessToken: string): Promise<Vehicle[]> {
    return z.array(vehicle).parse(await this.call("GET", "/api/1/vehicles", accessToken));
  }

  /** Live data from a vehicle that is online; undefined if it has gone to sleep. */
  async vehicleData(accessToken: string, vin: string): Promise<VehicleData | undefined> {
    const endpoints = "charge_state;climate_state;vehicle_state;vehicle_config";
    const path = `/api/1/vehicles/${vin}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`;
    const data = await this.call("GET", path, accessToken, undefined, [408]);
    return data === undefined ? undefined : vehicleData.parse(data);
  }

  private async token(params: Record<string, string>, fallbackRefresh?: string): Promise<Tokens> {
    const response = await this.send(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        ...params,
      }).toString(),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = z.looseObject({ error: z.string() }).safeParse(body);
      const code = error.success ? error.data.error : String(response.status);
      // The grant itself is no good: a revoked, expired, or already-used token or code.
      const dead = response.status === 401 || code === "invalid_grant" || code === "login_required";
      throw new TeslaError(
        dead
          ? "Tesla no longer accepts this login; authorize again"
          : `Tesla token request failed: ${code}`,
        dead,
      );
    }
    const tokens = tokenResponse.parse(body);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? fallbackRefresh ?? "",
      expiresAt: this.now() + tokens.expires_in * 1000,
    };
  }

  /** Returns the `response` field, or undefined for a status listed in `empty`. */
  private async call(
    method: string,
    path: string,
    accessToken: string,
    body?: unknown,
    empty: number[] = [],
  ): Promise<unknown> {
    const response = await this.send(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (empty.includes(response.status)) return undefined;
    const payload = z
      .looseObject({ response: z.unknown().optional(), error: z.string().nullish() })
      .safeParse(await response.json().catch(() => undefined));
    if (!response.ok) {
      const detail = payload.success && payload.data.error ? `: ${payload.data.error}` : "";
      if (response.status === 401) throw new TeslaError("Tesla rejected the access token", true);
      if (response.status === 412) {
        throw new TeslaError(
          "This Tesla app is not registered in this region; run the register_partner action",
        );
      }
      if (response.status === 429) throw new TeslaError("Tesla is rate limiting requests");
      throw new TeslaError(`Tesla answered ${response.status}${detail}`);
    }
    return payload.success ? payload.data.response : undefined;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new TeslaError(
        `Cannot reach Tesla: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
