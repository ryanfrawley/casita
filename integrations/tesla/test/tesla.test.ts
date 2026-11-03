import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import type { Fetch } from "../src/api.ts";
import { createTeslaIntegration } from "../src/index.ts";
import { FakeTesla } from "./fake-cloud.ts";

const VIN = "5YJ3E1EA7JF000001";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(
  config: Record<string, unknown> = { refreshToken: "refresh-1" },
  prepare: (cloud: FakeTesla, t: TestContext<unknown>) => void = () => {},
  /** Wraps the fake's fetch, to alter chosen requests. */
  wrap: (fetch: Fetch) => Fetch = (fetch) => fetch,
) {
  const cloud = await FakeTesla.create();
  const clock = { now: 1_000_000_000 };
  const integration = createTeslaIntegration({ fetch: wrap(cloud.fetch), now: () => clock.now });
  const t = createTestContext(
    integration.configSchema.parse({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://casita.example/tesla/callback",
      pollMinutes: 1,
      ...config,
    }),
  );
  prepare(cloud, t);
  cleanups.push(() => t.abort());
  await integration.setup(t.ctx);
  return { cloud, t, clock };
}

const value = (t: TestContext<unknown>, key: string) => t.state(`${VIN}-${key}`)?.state;
const warnings = (t: TestContext<unknown>) =>
  t.logs
    .filter((l) => l.level === "warn")
    .map((l) => (l.data as { error?: string } | undefined)?.error ?? l.msg);

test("discovers the vehicle and reports what it says", async () => {
  const { t, cloud } = await setup();
  expect([...t.devices.values()]).toMatchObject([
    {
      uniqueId: VIN,
      name: "Nightshade",
      manufacturer: "Tesla",
      model: "model3",
      firmware: "2026.32.4",
    },
  ]);
  expect<string[]>([...t.entities.values()].map((e) => e.id)).toEqual([
    "binary_sensor.nightshade_awake",
    "sensor.nightshade_battery",
    "sensor.nightshade_range",
    "sensor.nightshade_charge_limit",
    "sensor.nightshade_charger_power",
    "sensor.nightshade_time_to_full_charge",
    "sensor.nightshade_inside_temperature",
    "sensor.nightshade_outside_temperature",
    "sensor.nightshade_odometer",
    "binary_sensor.nightshade_charging",
    "binary_sensor.nightshade_plugged_in",
    "lock.nightshade_doors",
  ]);
  expect(value(t, "awake")).toEqual({ domain: "binary_sensor", on: true });
  expect(value(t, "battery")).toEqual({
    domain: "sensor",
    value: 72,
    unit: "%",
    deviceClass: "battery",
  });
  expect(value(t, "range")).toEqual({
    domain: "sensor",
    value: 218.4,
    unit: "mi",
    deviceClass: undefined,
  });
  expect(value(t, "charger-power")).toMatchObject({ value: 11, unit: "kW", deviceClass: "power" });
  expect(value(t, "inside-temp")).toMatchObject({
    value: 21.5,
    unit: "°C",
    deviceClass: "temperature",
  });
  expect(value(t, "odometer")).toMatchObject({ value: 30212 });
  expect(value(t, "charging")).toEqual({ domain: "binary_sensor", on: true });
  expect(value(t, "plugged-in")).toEqual({ domain: "binary_sensor", on: true });
  expect(value(t, "locked")).toEqual({ domain: "lock", locked: true });
  expect(cloud.calls("vehicle_data")).toHaveLength(1);
});

test("everything is read-only", async () => {
  const { t } = await setup();
  await expect(t.command(`${VIN}-locked`, { domain: "lock", action: "unlock" })).rejects.toThrow(
    "read-only",
  );
});

test("a sleeping car is not woken: no data request, last values kept", async () => {
  const { t, cloud } = await setup();
  cloud.state = "asleep";
  await t.runAction("refresh", {});
  expect(cloud.calls("vehicle_data")).toHaveLength(1); // only the one from setup
  expect(cloud.calls("wake_up")).toEqual([]);
  expect(value(t, "awake")).toEqual({ domain: "binary_sensor", on: false });
  expect(t.state(`${VIN}-battery`)).toMatchObject({ available: true, state: { value: 72 } });

  // It dozes off between the list and the data call: same outcome, no error.
  cloud.state = "online";
  await t.runAction("refresh", {});
  expect(value(t, "awake")).toMatchObject({ on: true });
});

test("a car that is asleep at startup still gets its entities, with no values yet", async () => {
  const { t } = await setup(undefined, (cloud) => {
    cloud.state = "asleep";
  });
  expect(t.entities.size).toBe(12);
  expect(value(t, "awake")).toEqual({ domain: "binary_sensor", on: false });
  expect(value(t, "battery")).toBeUndefined();
});

test("the rotated refresh token is persisted and the access token reused until it nears expiry", async () => {
  const { t, cloud, clock } = await setup();
  expect(t.storage.get("tokens")).toMatchObject({
    accessToken: "access-1",
    refreshToken: "refresh-2",
    seed: "refresh-1",
  });
  await t.runAction("refresh", {});
  expect(cloud.tokenRequests).toHaveLength(1);

  clock.now += 28_800_000 - 30_000; // inside the margin before expiry
  await t.runAction("refresh", {});
  expect(cloud.tokenRequests.map((r) => r.refresh_token)).toEqual(["refresh-1", "refresh-2"]);
  expect(t.storage.get("tokens")).toMatchObject({
    accessToken: "access-2",
    refreshToken: "refresh-3",
  });
});

test("after a restart the stored token is used, not the stale one in config", async () => {
  const stored = {
    accessToken: "",
    refreshToken: "refresh-1",
    expiresAt: 0,
    seed: "old-config-token",
  };
  const { cloud } = await setup({ refreshToken: "old-config-token" }, (_cloud, t) => {
    t.storage.set("tokens", stored);
  });
  expect(cloud.tokenRequests.map((r) => r.refresh_token)).toEqual(["refresh-1"]);

  // A different token in config means the owner logged in again: it takes over.
  const replaced = await setup({ refreshToken: "refresh-1" }, (_cloud, t) => {
    t.storage.set("tokens", { ...stored, refreshToken: "revoked" });
  });
  expect(replaced.cloud.tokenRequests.map((r) => r.refresh_token)).toEqual(["refresh-1"]);
});

test("authorizing from scratch: url, code exchange, then vehicles appear", async () => {
  const { t, cloud } = await setup({});
  expect(t.entities.size).toBe(0);
  expect(warnings(t)).toEqual(["not authorized with Tesla yet; run the authorize_url action"]);
  expect(await t.runAction("status", {})).toEqual({
    authorized: false,
    vehicles: 0,
    lastPoll: null,
    lastError: null,
  });

  const { url } = (await t.runAction("authorize_url", {})) as { url: string };
  const query = new URL(url).searchParams;
  expect(url).toStartWith("https://auth.tesla.com/oauth2/v3/authorize?");
  expect(Object.fromEntries(query)).toMatchObject({
    response_type: "code",
    client_id: "client",
    redirect_uri: "https://casita.example/tesla/callback",
    scope: "openid offline_access vehicle_device_data",
  });

  await expect(
    t.runAction("complete_authorization", { code: "auth-code", state: "forged" }),
  ).rejects.toThrow("does not match");
  await expect(t.runAction("complete_authorization", { code: "wrong" })).rejects.toThrow(
    "authorize again",
  );
  expect(
    await t.runAction("complete_authorization", { code: "auth-code", state: query.get("state") }),
  ).toEqual({ vehicles: 1 });
  expect(cloud.tokenRequests.at(-1)).toMatchObject({
    grant_type: "authorization_code",
    audience: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    redirect_uri: "https://casita.example/tesla/callback",
  });
  expect(value(t, "battery")).toMatchObject({ value: 72 });
  expect(await t.runAction("status", {})).toMatchObject({
    authorized: true,
    vehicles: 1,
    lastError: null,
  });
});

test("a login Tesla no longer accepts marks everything unavailable and says what to do", async () => {
  const { t, cloud, clock } = await setup();
  cloud.refreshToken = "revoked-elsewhere";
  clock.now += 28_800_000;
  await expect(t.runAction("refresh", {})).rejects.toThrow(
    "Tesla no longer accepts this login; authorize again",
  );
  expect([...t.states.values()].every((s) => !s.available)).toBe(true);
});

test("a network failure is reported but changes nothing; it does not fail setup either", async () => {
  const { t, cloud } = await setup();
  cloud.down = true;
  await expect(t.runAction("refresh", {})).rejects.toThrow("Cannot reach Tesla");
  expect([...t.states.values()].every((s) => s.available)).toBe(true);

  const offline = await setup(undefined, (c) => {
    c.down = true;
  });
  expect(warnings(offline.t)[0]).toContain("Cannot reach Tesla");
  expect(await offline.t.runAction("status", {})).toMatchObject({ authorized: true, vehicles: 0 });
});

test("an unregistered app is told to register; register_partner does it", async () => {
  const { t, cloud } = await setup(undefined, (c) => {
    c.registered = false;
  });
  expect(warnings(t)[0]).toBe(
    "This Tesla app is not registered in this region; run the register_partner action",
  );
  expect(await t.runAction("register_partner", { domain: "casita.example" })).toEqual({
    registered: { domain: "casita.example" },
  });
  expect(cloud.tokenRequests.at(-1)).toMatchObject({ grant_type: "client_credentials" });
  expect(await t.runAction("refresh", {})).toEqual({ vehicles: 1 });
});

test("the region selects the API host", async () => {
  const { cloud } = await setup({ refreshToken: "refresh-1", region: "eu" });
  expect(cloud.calls("/api/1/vehicles")[0]).toBe(
    "GET fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles",
  );
});

test("cleans up on abort: polling stops", async () => {
  const { t, cloud } = await setup({ refreshToken: "refresh-1", pollMinutes: 1 });
  t.abort();
  const before = cloud.requests.length;
  await Bun.sleep(20);
  expect(cloud.requests.length).toBe(before);
});

// ───────── token refresh races, charging states, more vehicles, recovery ─────────

type Row = Record<string, unknown>;
const EIGHT_HOURS = 28_800_000;
const available = (t: TestContext<unknown>) => [...t.states.values()].map((s) => s.available);

test("two refreshes at once with an expired access token use the single-use refresh token once", async () => {
  const { t, cloud, clock } = await setup();
  clock.now += EIGHT_HOURS;
  expect(await Promise.all([t.runAction("refresh", {}), t.runAction("refresh", {})])).toEqual([
    { vehicles: 1 },
    { vehicles: 1 },
  ]);
  expect(cloud.tokenRequests.map((r) => r.refresh_token)).toEqual(["refresh-1", "refresh-2"]);
  expect(t.storage.get("tokens")).toMatchObject({
    accessToken: "access-2",
    refreshToken: "refresh-3",
  });
  expect(available(t).every(Boolean)).toBe(true);
});

test("charging and plugged-in follow charging_state", async () => {
  const { t, cloud } = await setup();
  const cases: [string, boolean, boolean][] = [
    ["Stopped", false, true],
    ["Complete", false, true],
    ["Disconnected", false, false],
    ["Charging", true, true],
  ];
  for (const [chargingState, charging, pluggedIn] of cases) {
    (cloud.data.charge_state as Row).charging_state = chargingState;
    await t.runAction("refresh", {});
    expect([chargingState, value(t, "charging"), value(t, "plugged-in")]).toEqual([
      chargingState,
      { domain: "binary_sensor", on: charging },
      { domain: "binary_sensor", on: pluggedIn },
    ]);
  }
});

test("a vehicle with no display name is named from the end of its VIN", async () => {
  for (const displayName of [null, ""]) {
    const { t } = await setup(undefined, (cloud) => {
      cloud.data.display_name = displayName;
    });
    expect([...t.devices.values()].map((d) => d.name)).toEqual(["Tesla 000001"]);
    expect(t.entity(`${VIN}-battery`).id as string).toBe("sensor.tesla_000001_battery");
    expect(t.entity(`${VIN}-locked`).name).toBe("Tesla 000001 doors");
  }
});

/** Adds vehicles to the account's list, each with its own vehicle_data when online. */
function moreVehicles(extra: Row[]) {
  return (fetch: Fetch): Fetch =>
    async (url, init) => {
      const path = new URL(url).pathname;
      const response = await fetch(url, init);
      if (path === "/api/1/vehicles" && response.ok) {
        const body = (await response.json()) as { response: Row[] };
        return Response.json({ response: [...body.response, ...extra] });
      }
      for (const car of extra) {
        if (path === `/api/1/vehicles/${String(car.vin)}/vehicle_data`)
          return car.state === "online"
            ? Response.json({ response: car })
            : Response.json({ response: null, error: "vehicle unavailable" }, { status: 408 });
      }
      return response;
    };
}

test("a second vehicle added to the account later gets its own device and entities", async () => {
  const extra: Row[] = [];
  const { t, cloud } = await setup(undefined, () => {}, moreVehicles(extra));
  expect(t.entities.size).toBe(12);

  const VIN2 = "7SAYGDEE0PF000002";
  extra.push({
    vin: VIN2,
    display_name: "Bluebird",
    state: "online",
    charge_state: { battery_level: 40, charging_state: "Disconnected" },
    vehicle_config: { car_type: "modely" },
  });
  expect(await t.runAction("refresh", {})).toEqual({ vehicles: 2 });
  expect([...t.devices.values()].map((d) => [d.uniqueId, d.name, d.model])).toEqual([
    [VIN, "Nightshade", "model3"],
    [VIN2, "Bluebird", "modely"],
  ]);
  expect(t.entities.size).toBe(24);
  expect(t.state(`${VIN2}-battery`)?.state).toMatchObject({ value: 40 });
  expect(t.state(`${VIN2}-plugged-in`)?.state).toEqual({ domain: "binary_sensor", on: false });
  expect(t.state(`${VIN2}-inside-temp`)).toBeUndefined(); // it sent no climate data
  // The first car is read as before; the token is shared.
  expect(value(t, "battery")).toMatchObject({ value: 72 });
  expect(cloud.tokenRequests).toHaveLength(1);
  expect(await t.runAction("status", {})).toMatchObject({ vehicles: 2, lastError: null });
});

test("vehicle data missing a whole section leaves those readings without a value", async () => {
  const { t } = await setup(undefined, (cloud) => {
    delete cloud.data.climate_state;
    delete cloud.data.vehicle_config;
  });
  expect(t.entities.size).toBe(12);
  expect(t.state(`${VIN}-inside-temp`)).toBeUndefined();
  expect(t.state(`${VIN}-outside-temp`)).toBeUndefined();
  expect(value(t, "battery")).toMatchObject({ value: 72 });
  expect([...t.devices.values()][0]?.model).toBeUndefined();
  expect(await t.runAction("status", {})).toMatchObject({ lastError: null });
});

test("authorizing again after a dead login brings every entity back", async () => {
  const { t, cloud, clock } = await setup();
  cloud.refreshToken = "revoked-elsewhere";
  clock.now += EIGHT_HOURS;
  await expect(t.runAction("refresh", {})).rejects.toThrow("authorize again");
  expect(available(t).every((a) => !a)).toBe(true);

  const { url } = (await t.runAction("authorize_url", {})) as { url: string };
  const state = new URL(url).searchParams.get("state");
  expect(await t.runAction("complete_authorization", { code: "auth-code", state })).toEqual({
    vehicles: 1,
  });
  expect(available(t)).toHaveLength(12);
  expect(available(t).every(Boolean)).toBe(true);
  expect(await t.runAction("status", {})).toMatchObject({ authorized: true, lastError: null });
  // The new login keeps working on the next poll.
  expect(await t.runAction("refresh", {})).toEqual({ vehicles: 1 });
});

test("authorizing again while the car sleeps still brings its entities back", async () => {
  const { t, cloud, clock } = await setup();
  cloud.refreshToken = "revoked-elsewhere";
  clock.now += EIGHT_HOURS;
  await t.runAction("refresh", {}).catch(() => {});
  cloud.state = "asleep";
  await t.runAction("complete_authorization", { code: "auth-code" });
  expect(available(t).every(Boolean)).toBe(true);
  expect(value(t, "battery")).toMatchObject({ value: 72 }); // the last value, kept
});

test("a car falling asleep keeps the model and firmware it reported while awake", async () => {
  const { t, cloud } = await setup();
  cloud.state = "asleep";
  await t.runAction("refresh", {});
  expect([...t.devices.values()][0]).toMatchObject({ model: "model3", firmware: "2026.32.4" });
});

test("a vehicle removed from the account no longer shows as available", async () => {
  const hidden = { vin: true };
  const wrap =
    (fetch: Fetch): Fetch =>
    async (url, init) => {
      const response = await fetch(url, init);
      if (!hidden.vin || new URL(url).pathname !== "/api/1/vehicles") return response;
      return Response.json({ response: [] });
    };
  hidden.vin = false;
  const { t } = await setup(undefined, () => {}, wrap);
  hidden.vin = true;
  expect(await t.runAction("refresh", {})).toEqual({ vehicles: 0 });
  expect(available(t).every((a) => !a)).toBe(true);
});
