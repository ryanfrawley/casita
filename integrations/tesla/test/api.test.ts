import { expect, test } from "bun:test";
import { REGIONS, type Region, TeslaApi, TeslaError } from "../src/api.ts";

const NOW = 1_700_000_000_000;
const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
const VIN = "5YJ3E1EA7JF000001";

interface Reply {
  status?: number;
  /** JSON-encoded unless a string; null for no body. */
  body?: unknown;
}

/** A fetch that answers each request with the next reply (the last one repeats) and records it. */
function cloud(replies: (Reply | Error)[], region: Region = "na") {
  const sent: { method: string; url: string; headers: Headers; body: string }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : "",
    });
    const reply = replies[Math.min(sent.length, replies.length) - 1] ?? {};
    if (reply instanceof Error) throw reply;
    const { status = 200, body = {} } = reply;
    const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  const api = new TeslaApi({
    clientId: "client-id",
    clientSecret: "s3cret",
    region,
    redirectUri: "https://casita.example/tesla/callback?x=1",
    fetch,
    now: () => NOW,
  });
  const form = (i = 0) => Object.fromEntries(new URLSearchParams(sent[i]?.body ?? ""));
  return { api, sent, form };
}

async function rejection(promise: Promise<unknown>): Promise<TeslaError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TeslaError) return err;
    throw err;
  }
  throw new Error("expected a TeslaError");
}

// ───────── authorize URL ─────────

test("authorizeUrl carries the client, redirect, scopes and state, properly encoded", () => {
  const { api, sent } = cloud([]);
  const url = new URL(api.authorizeUrl("st&te=1 two"));
  expect(`${url.origin}${url.pathname}`).toBe("https://auth.tesla.com/oauth2/v3/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: "code",
    client_id: "client-id",
    redirect_uri: "https://casita.example/tesla/callback?x=1",
    scope: "openid offline_access vehicle_device_data",
    state: "st&te=1 two",
  });
  expect(sent).toHaveLength(0); // building the URL makes no request
});

// ───────── tokens ─────────

test("exchangeCode posts a form with the code, audience and redirect, and returns the tokens", async () => {
  const { api, sent, form } = cloud([
    { body: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } },
  ]);
  expect(await api.exchangeCode("the-code")).toEqual({
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: NOW + 3_600_000,
  });
  expect(sent[0]?.url).toBe(TOKEN_URL);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  expect(form()).toEqual({
    client_id: "client-id",
    client_secret: "s3cret",
    grant_type: "authorization_code",
    code: "the-code",
    audience: REGIONS.na,
    redirect_uri: "https://casita.example/tesla/callback?x=1",
  });
});

test("the audience follows the region", async () => {
  const { api, form } = cloud([{ body: { access_token: "a", refresh_token: "r" } }], "eu");
  await api.exchangeCode("c");
  expect(form().audience).toBe("https://fleet-api.prd.eu.vn.cloud.tesla.com");
});

test("refresh sends the refresh token and returns the rotated one", async () => {
  const { api, form } = cloud([{ body: { access_token: "a2", refresh_token: "r2" } }]);
  expect(await api.refresh("r1")).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
  expect(form()).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
});

test("a refresh answer without a refresh token keeps the one that was used", async () => {
  const { api } = cloud([{ body: { access_token: "a2", expires_in: 60 } }]);
  expect(await api.refresh("r1")).toEqual({
    accessToken: "a2",
    refreshToken: "r1",
    expiresAt: NOW + 60_000,
  });
});

test("a token answer without expires_in is taken to last eight hours", async () => {
  const { api } = cloud([{ body: { access_token: "a", refresh_token: "r" } }]);
  expect((await api.refresh("r0")).expiresAt).toBe(NOW + 28_800_000);
});

test("a dead grant means the user must authorize again", async () => {
  for (const reply of [
    { status: 400, body: { error: "invalid_grant" } },
    { status: 400, body: { error: "login_required" } },
    { status: 401, body: { error: "invalid_client" } },
    { status: 401, body: "Unauthorized" },
  ]) {
    const { api } = cloud([reply]);
    const err = await rejection(api.refresh("r1"));
    expect(err.reauthorize).toBe(true);
    expect(err.message).toBe("Tesla no longer accepts this login; authorize again");
  }
});

test("other token failures can be retried and name the error", async () => {
  const cases: [Reply, string][] = [
    [{ status: 400, body: { error: "invalid_request" } }, "invalid_request"],
    [{ status: 500, body: "<html>oops</html>" }, "500"],
    [{ status: 503, body: { message: "no error field" } }, "503"],
    [{ status: 429, body: null }, "429"],
  ];
  for (const [reply, code] of cases) {
    const { api } = cloud([reply]);
    const err = await rejection(api.refresh("r1"));
    expect(err.reauthorize).toBe(false);
    expect(err.message).toBe(`Tesla token request failed: ${code}`);
  }
});

test("a token request that cannot reach Tesla can be retried", async () => {
  const { api } = cloud([new Error("ECONNRESET")]);
  const err = await rejection(api.refresh("r1"));
  expect(err.message).toBe("Cannot reach Tesla: ECONNRESET");
  expect(err.reauthorize).toBe(false);
});

test("a successful token answer without an access token is rejected", async () => {
  const { api } = cloud([{ body: { refresh_token: "r2" } }]);
  await expect(api.refresh("r1")).rejects.toThrow();
});

test("registerPartner gets a client-credentials token and posts the domain with it", async () => {
  const { api, sent, form } = cloud([
    { body: { access_token: "partner", expires_in: 100 } },
    { body: { response: { domain: "casita.example" } } },
  ]);
  expect(await api.registerPartner("casita.example")).toEqual({ domain: "casita.example" });
  expect(form(0)).toMatchObject({
    grant_type: "client_credentials",
    scope: "openid offline_access vehicle_device_data",
    audience: REGIONS.na,
  });
  expect(sent[1]?.url).toBe(`${REGIONS.na}/api/1/partner_accounts`);
  expect(sent[1]?.method).toBe("POST");
  expect(sent[1]?.headers.get("authorization")).toBe("Bearer partner");
  expect(JSON.parse(sent[1]?.body ?? "")).toEqual({ domain: "casita.example" });
});

// ───────── vehicles ─────────

test("vehicles lists the account's cars, with a null name allowed and state defaulted", async () => {
  const { api, sent } = cloud([
    {
      body: {
        response: [
          { vin: "A", display_name: null, state: "asleep" },
          { vin: "B" },
          { vin: "C", display_name: "Car", state: "online", extra: 1 },
        ],
        count: 3,
      },
    },
  ]);
  expect(await api.vehicles("tok")).toEqual([
    { vin: "A", display_name: null, state: "asleep" },
    { vin: "B", state: "offline" },
    { vin: "C", display_name: "Car", state: "online", extra: 1 },
  ]);
  expect(sent[0]?.url).toBe(`${REGIONS.na}/api/1/vehicles`);
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer tok");
});

test("a vehicles answer without a response field is rejected", async () => {
  const { api } = cloud([{ body: { count: 0 } }]);
  await expect(api.vehicles("tok")).rejects.toThrow();
});

test("vehicleData asks for the four sections, with the separator encoded", async () => {
  const { api, sent } = cloud([{ body: { response: { vin: VIN } } }]);
  await api.vehicleData("tok", VIN);
  const url = new URL(sent[0]?.url ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(`${REGIONS.na}/api/1/vehicles/${VIN}/vehicle_data`);
  expect(url.search).toBe(
    "?endpoints=charge_state%3Bclimate_state%3Bvehicle_state%3Bvehicle_config",
  );
  expect(url.searchParams.get("endpoints")).toBe(
    "charge_state;climate_state;vehicle_state;vehicle_config",
  );
});

test("vehicleData is undefined when the car is asleep (408)", async () => {
  const { api } = cloud([{ status: 408, body: { response: null, error: "vehicle unavailable" } }]);
  expect(await api.vehicleData("tok", VIN)).toBeUndefined();
});

test("vehicleData accepts null numbers and missing sections", async () => {
  const data = {
    vin: VIN,
    display_name: null,
    state: "online",
    charge_state: {
      battery_level: null,
      battery_range: null,
      charge_limit_soc: 80,
      charging_state: null,
      charger_power: null,
      minutes_to_full_charge: null,
    },
    vehicle_state: { locked: null, odometer: null, car_version: null },
  };
  const { api } = cloud([{ body: { response: data } }]);
  const parsed = await api.vehicleData("tok", VIN);
  expect(parsed).toEqual(data);
  expect(parsed?.climate_state).toBeUndefined();
  expect(parsed?.vehicle_config).toBeUndefined();
});

test("vehicleData rejects a section with values of the wrong type", async () => {
  const { api } = cloud([
    { body: { response: { vin: VIN, charge_state: { battery_level: "72" } } } },
  ]);
  await expect(api.vehicleData("tok", VIN)).rejects.toThrow();
});

// ───────── API errors ─────────

test("a rejected access token means authorizing again", async () => {
  const { api } = cloud([{ status: 401, body: { error: "invalid bearer token" } }]);
  const err = await rejection(api.vehicles("tok"));
  expect(err.message).toBe("Tesla rejected the access token");
  expect(err.reauthorize).toBe(true);
});

test("412, 429 and other statuses map to retryable errors with readable messages", async () => {
  const cases: [Reply, string][] = [
    [
      { status: 412, body: { error: "must be registered" } },
      "This Tesla app is not registered in this region; run the register_partner action",
    ],
    [{ status: 429, body: "Too Many Requests" }, "Tesla is rate limiting requests"],
    [
      { status: 500, body: { response: null, error: "internal error" } },
      "Tesla answered 500: internal error",
    ],
    [{ status: 503, body: "<html>Service Unavailable</html>" }, "Tesla answered 503"],
    [{ status: 502, body: { response: null, error: null } }, "Tesla answered 502"],
    [
      { status: 408, body: { error: "vehicle unavailable" } },
      "Tesla answered 408: vehicle unavailable",
    ],
  ];
  for (const [reply, message] of cases) {
    const { api } = cloud([reply]);
    // 408 is only expected from vehicle_data; elsewhere it is an error like any other.
    const err = await rejection(api.vehicles("tok"));
    expect(err.message).toBe(message);
    expect(err.reauthorize).toBe(false);
  }
});

test("an API call that cannot reach Tesla says so", async () => {
  const { api } = cloud([new Error("getaddrinfo ENOTFOUND")]);
  const err = await rejection(api.vehicleData("tok", VIN));
  expect(err.message).toBe("Cannot reach Tesla: getaddrinfo ENOTFOUND");
  expect(err.reauthorize).toBe(false);
});
