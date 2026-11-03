import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import type { Fetch } from "../src/api.ts";
import { createLaMarzoccoIntegration } from "../src/index.ts";
import { FakeLaMarzocco, NOW } from "./fake-cloud.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(
  config: Record<string, unknown> = {},
  prepare: (cloud: FakeLaMarzocco) => void = () => {},
  wrap: (fetch: Fetch) => Fetch = (fetch) => fetch,
) {
  const cloud = await FakeLaMarzocco.create();
  prepare(cloud);
  const integration = createLaMarzoccoIntegration({
    fetch: wrap(cloud.fetch),
    openSocket: cloud.openSocket,
    now: () => NOW,
    settleMs: 5,
    reconnectMs: 10,
    reconnectMaxMs: 40,
  });
  const t = createTestContext(
    integration.configSchema.parse({
      username: "ry@example.com",
      password: "good-password",
      pollSeconds: 15,
      timeZone: "America/Los_Angeles",
      ...config,
    }),
  );
  cleanups.push(() => t.abort());
  await integration.setup(t.ctx);
  return { cloud, t, integration };
}

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}
const on = (t: TestContext<unknown>, uniqueId: string) =>
  (t.state(uniqueId)?.state as { on?: boolean } | undefined)?.on;
const value = (t: TestContext<unknown>, uniqueId: string) =>
  (t.state(uniqueId)?.state as { value?: unknown } | undefined)?.value;
const live = (cloud: FakeLaMarzocco) => () => cloud.socket?.subscribed !== undefined;

test("registers an installation once, then signs in with it", async () => {
  const { cloud, t } = await setup();
  expect(cloud.calls("/auth/")).toEqual(["POST /auth/init", "POST /auth/signin"]);
  expect(t.storage.get("installation")).toMatchObject({ registered: true });

  // A restart reuses the stored key: no second registration.
  const integration = createLaMarzoccoIntegration({
    fetch: cloud.fetch,
    openSocket: cloud.openSocket,
  });
  const t2 = createTestContext(t.ctx.config);
  cleanups.push(() => t2.abort());
  for (const [k, v] of t.storage) t2.storage.set(k, v);
  await integration.setup(t2.ctx);
  expect(cloud.calls("/auth/init")).toHaveLength(1);
});

test("discovers the coffee machine, not the grinder, with friendly names", async () => {
  const { t } = await setup();
  expect([...t.devices.values()]).toMatchObject([
    {
      uniqueId: "MR012345",
      name: "Linea Mini R",
      manufacturer: "La Marzocco",
      model: "Linea Mini R",
    },
  ]);
  expect<string[][]>([...t.entities.values()].map((e) => [e.id, e.uniqueId])).toEqual([
    ["switch.linea_mini_r_power", "MR012345-power"],
    ["binary_sensor.linea_mini_r_ready", "MR012345-ready"],
    ["sensor.linea_mini_r_ready_at", "MR012345-ready-at"],
    ["switch.linea_mini_r_steam", "MR012345-steam"],
    ["binary_sensor.linea_mini_r_steam_ready", "MR012345-steam-ready"],
  ]);
});

test("a machine named after its serial number takes the model's name", async () => {
  const { t } = await setup({}, (cloud) => {
    for (const thing of cloud.things) thing.name = thing.serialNumber;
  });
  expect([...t.devices.values()][0]?.name).toBe("Linea Mini R");
});

test("reports a machine in standby: off, not ready, no ready time", async () => {
  const { t } = await setup();
  expect(on(t, "MR012345-power")).toBe(false);
  expect(on(t, "MR012345-ready")).toBe(false);
  expect(value(t, "MR012345-ready-at")).toBeNull();
  expect(on(t, "MR012345-steam")).toBe(true);
  expect(t.state("MR012345-power")?.attributes).toMatchObject({
    status: "StandBy",
    mode: "StandBy",
    targetTemperature: 94,
  });
});

test("turning it on sends brewing mode; the socket reports it heating, then ready", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  await t.command("MR012345-power", { domain: "switch", action: "turn_on" });
  expect(cloud.requests.at(-1)).toEqual({
    call: "POST /things/MR012345/command/CoffeeMachineChangeMode",
    body: { mode: "BrewingMode" },
  });
  await until(() => on(t, "MR012345-power") === true, "power on");
  expect(on(t, "MR012345-ready")).toBe(false);
  // 20 minutes after 12:26:40 UTC on 2025-11-01, in Los Angeles.
  expect(value(t, "MR012345-ready-at")).toBe("5:46 am");
  expect(t.state("MR012345-ready-at")?.attributes).toEqual({
    at: NOW + 20 * 60_000,
    boiler: "HeatingUp",
  });

  cloud.heated();
  expect(on(t, "MR012345-ready")).toBe(true);
  expect(value(t, "MR012345-ready-at")).toBeNull();
});

test("turning it off sends standby", async () => {
  const { t, cloud } = await setup();
  await t.command("MR012345-power", { domain: "switch", action: "turn_off" });
  expect(cloud.requests.find((r) => r.call.endsWith("/CoffeeMachineChangeMode"))?.body).toEqual({
    mode: "StandBy",
  });
});

test("the steam switch turns the steam boiler on and off", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  await t.command("MR012345-steam", { domain: "switch", action: "turn_off" });
  expect(cloud.requests.at(-1)).toEqual({
    call: "POST /things/MR012345/command/CoffeeMachineSettingSteamBoilerEnabled",
    body: { boilerIndex: 1, enabled: false },
  });
  await until(() => on(t, "MR012345-steam") === false, "steam off");
});

test("subscribes to the machine's dashboard with a signed, authorized socket", async () => {
  const { cloud } = await setup();
  await until(live(cloud), "the socket");
  expect(cloud.socket?.url).toBe("wss://lion.lamarzocco.io/ws/connect");
  expect(cloud.socket?.subscribed).toBe("/ws/sn/MR012345/dashboard");
  expect(cloud.signed(cloud.socket?.headers ?? {})).toBe(true);
});

test("without the socket, a command's effect is read back from the dashboard", async () => {
  const { t, cloud } = await setup({}, (cloud) => {
    cloud.socketsRefused = true;
    cloud.pushOnCommand = false;
  });
  await t.command("MR012345-power", { domain: "switch", action: "turn_on" });
  await until(() => on(t, "MR012345-power") === true, "power on from a re-read");
  expect(cloud.calls("/dashboard").length).toBeGreaterThanOrEqual(2);
});

test("a machine that is offline with the cloud is unavailable", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  cloud.dashboard.connected = false;
  cloud.publish();
  expect(t.state("MR012345-power")?.available).toBe(false);
  expect(t.state("MR012345-ready")?.available).toBe(false);

  cloud.dashboard.connected = true;
  cloud.publish();
  expect(t.state("MR012345-power")?.available).toBe(true);
});

test("after the socket drops it reconnects, reading the dashboard again", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  const reads = cloud.calls("/dashboard").length;
  cloud.socket?.drop();
  await until(() => cloud.sockets.length === 2 && live(cloud)(), "a second socket");
  await until(() => cloud.calls("/dashboard").length > reads, "a re-read");
  expect(t.logs.some((l) => l.msg.includes("socket closed"))).toBe(true);
});

test("marks entities unavailable after repeated failed reads while the socket is down", async () => {
  const { t, cloud, integration } = await setup({}, (cloud) => {
    cloud.socketsRefused = true;
  });
  cloud.down = true;
  for (let i = 0; i < 3; i++) await t.runAction("refresh", {});
  expect(t.state("MR012345-power")?.available).toBe(false);
  expect(integration.id).toBe("lamarzocco");
});

test("a wrong password rejects setup", async () => {
  await expect(setup({ password: "nope" })).rejects.toThrow(/refused the username or password/);
});

test("a serial number not on the account rejects setup, naming the ones that are", async () => {
  await expect(setup({ serial: "XX999" })).rejects.toThrow(/No coffee machine XX999.*MR012345/);
});

test("a failed command outcome is logged", async () => {
  const { t, cloud } = await setup({}, (cloud) => {
    cloud.commandStatus = "Failed";
  });
  await until(live(cloud), "the socket");
  await t.command("MR012345-power", { domain: "switch", action: "turn_on" });
  await until(() => t.logs.some((l) => l.msg.includes("did not carry out")), "the warning");
});

test("aborting closes the socket and stops polling", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  t.abort();
  expect(cloud.socket?.closed).toBe(true);
  const reads = cloud.calls().length;
  await Bun.sleep(40);
  expect(cloud.calls().length).toBe(reads);
  expect(cloud.sockets).toHaveLength(1);
});

test("a socket message with only command outcomes leaves the machine's state alone", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  await t.command("MR012345-power", { domain: "switch", action: "turn_on" });
  await until(() => on(t, "MR012345-power") === true, "power on");
  cloud.socket?.push({ connected: true, widgets: [], commands: [{ id: "c", status: "Pending" }] });
  expect(on(t, "MR012345-power")).toBe(true);
  expect(t.state("MR012345-power")?.attributes).toMatchObject({ status: "PoweredOn" });
});

test("a subscription the cloud refuses backs off instead of retrying at the shortest wait", async () => {
  const { cloud } = await setup({}, (cloud) => {
    cloud.refuseSubscription = true;
  });
  // Waits of 10, 20, 40, 40… ms: about five attempts in 150 ms, against fifteen without backoff.
  await Bun.sleep(150);
  expect(cloud.sockets.length).toBeGreaterThanOrEqual(2);
  expect(cloud.sockets.length).toBeLessThanOrEqual(7);
});

test("a token the socket rejects is dropped, and the next attempt signs in again", async () => {
  const { cloud } = await setup();
  await until(live(cloud), "the socket");
  const signIns = cloud.calls("/auth/signin").length;
  cloud.accessToken = "rotated-by-the-cloud";
  cloud.socket?.drop();
  await until(
    () => cloud.calls("/auth/signin").length > signIns && live(cloud)(),
    "a fresh sign-in and a live socket",
  );
});

test("aborting while the socket is still connecting closes it", async () => {
  const { t, cloud } = await setup({}, (cloud) => {
    cloud.holdConnect = true;
  });
  await until(() => cloud.sockets.length === 1, "a socket");
  t.abort();
  expect(cloud.socket?.closed).toBe(true);
  await Bun.sleep(20);
  expect(t.logs.some((l) => l.msg.includes("cannot open"))).toBe(false);
});

test("a command the machine did not carry out is read back from the dashboard", async () => {
  const { t, cloud } = await setup({}, (cloud) => {
    cloud.commandStatus = "Failed";
  });
  await until(live(cloud), "the socket");
  const reads = cloud.calls("/dashboard").length;
  await t.command("MR012345-power", { domain: "switch", action: "turn_on" });
  await until(() => cloud.calls("/dashboard").length > reads, "a re-read");
});

test("a machine offline from the start has a state, marked unavailable", async () => {
  const { t } = await setup({}, (cloud) => {
    cloud.dashboard.connected = false;
  });
  expect(t.state("MR012345-power")).toMatchObject({ available: false });
  expect(t.state("MR012345-ready")).toMatchObject({ available: false });
});

test("failed reads do not mark entities unavailable while the socket is delivering", async () => {
  const { t, cloud } = await setup();
  await until(live(cloud), "the socket");
  cloud.down = true;
  for (let i = 0; i < 3; i++) await t.runAction("refresh", {});
  expect(t.state("MR012345-power")?.available).toBe(true);
});

test("a key the cloud has forgotten is registered again, once", async () => {
  const { t, cloud } = await setup();
  t.abort();
  cloud.forget();
  const integration = createLaMarzoccoIntegration({
    fetch: cloud.fetch,
    openSocket: cloud.openSocket,
  });
  const t2 = createTestContext(t.ctx.config);
  cleanups.push(() => t2.abort());
  for (const [k, v] of t.storage) t2.storage.set(k, v);
  await integration.setup(t2.ctx);
  expect(cloud.calls("/auth/init")).toHaveLength(2);
  expect(t2.storage.get("installation")).not.toEqual(t.storage.get("installation"));
});

test("a wrong password is not mistaken for a forgotten key more than once", async () => {
  await expect(setup({ password: "nope" })).rejects.toThrow(/username or password/);
});
