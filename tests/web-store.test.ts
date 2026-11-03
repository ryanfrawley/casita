// The web app's store against the real server: what a browser tab would hold.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { CasitaClient } from "../packages/client/src/client.ts";
import { createStore, type House, type Store } from "../packages/web/src/store.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, type Harness } from "./harness.ts";

let h: Harness;
let store: Store;
/** What the "browser" authenticates with; a real one would use its cookie. */
let token: string | undefined;
beforeEach(async () => {
  h = await boot();
  token = BOOTSTRAP_TOKEN;
  store = createStore({
    connect: () => CasitaClient.connect(h.url, token),
    http: h.url,
    backoff: () => 20,
  });
});
afterEach(async () => {
  store.stop();
  await h.stop();
});

/** Resolves when the store's state satisfies `check`. */
function until(check: (house: House) => boolean, ms = 3000): Promise<House> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out in phase ${store.getState().phase}`));
    }, ms);
    const look = () => {
      if (!check(store.getState())) return;
      clearTimeout(timer);
      off();
      resolve(store.getState());
    };
    const off = store.subscribe(look);
    look();
  });
}

const light = (house: House) => house.states.get("light.desk")?.state as { on: boolean };
const lock = (house: House) =>
  house.states.get("lock.front_door")?.state as { locked: boolean } | undefined;

test("starting loads the house: who I am, entities, devices, states, integrations", async () => {
  expect(store.getState().phase).toBe("connecting");
  await store.start();
  const house = store.getState();
  expect(house.phase).toBe("ready");
  expect(house.entities.map((e) => e.id)).toContain("light.desk");
  expect(house.devices).toHaveLength(1);
  expect(light(house)).toMatchObject({ on: false });
  expect(house.integrations).toMatchObject([{ integrationId: "fixture.main" }]);
  expect(house.me).toBeDefined();
  expect(house.units).toBe("metric");
});

test("a command shows pending, then the state the device confirmed", async () => {
  await store.start();
  const seen: { pending: string | undefined; on: boolean }[] = [];
  store.subscribe(() => {
    const house = store.getState();
    seen.push({ pending: house.pending.get("light.desk"), on: light(house).on });
  });

  const outcome = await store.command(
    "light.desk",
    { domain: "light", action: "turn_on", brightness: 0.4 },
    "Turning on…",
  );
  expect(outcome).toEqual({ ok: true, confirmed: true });
  // First it was pending and still off; it turned on only when the device said so.
  expect(seen[0]).toEqual({ pending: "Turning on…", on: false });
  expect(seen.some((s) => s.pending === "Turning on…" && s.on)).toBe(true);
  expect(seen.at(-1)).toEqual({ pending: undefined, on: true });
});

test("a device that never answers leaves the state alone and says so", async () => {
  await h.stop();
  h = await boot(undefined, undefined, { confirmTimeoutMs: 50 });
  await store.start();
  const outcome = await store.command(
    "switch.mute",
    { domain: "switch", action: "turn_on" },
    "Turning on…",
  );
  expect(outcome).toEqual({ ok: true, confirmed: false });
  const house = store.getState();
  expect(house.pending.size).toBe(0);
  expect(house.states.get("switch.mute")?.state).toMatchObject({ on: false });
});

test("a command the server refuses comes back with its message", async () => {
  await store.start();
  const outcome = await store.command(
    "light.nope",
    { domain: "light", action: "turn_on" },
    "Turning on…",
  );
  expect(outcome).toMatchObject({ ok: false, code: "not_found" });
  if (!outcome.ok) expect(outcome.message).toContain("light.nope");
  expect(store.getState().pending.size).toBe(0);
});

test("a change made elsewhere arrives without asking", async () => {
  await store.start();
  const other = await h.connect();
  await other.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "unlock" },
  });
  const house = await until((now) => lock(now)?.locked === false);
  expect(house.pending.size).toBe(0);
});

test("a rename elsewhere reloads the lists", async () => {
  await store.start();
  const other = await h.connect();
  await other.request("update_entity", { entityId: "light.desk", newId: "light.office" });
  const house = await until((now) => now.entities.some((e) => e.id === "light.office"));
  expect(house.entities.some((e) => e.id === "light.desk")).toBe(false);
  expect(house.states.has("light.office")).toBe(true);
});

test("onRenamed hears an entity's and a device's new id, and says which it was", async () => {
  await store.start();
  const heard: [string, string, string][] = [];
  const off = store.onRenamed((oldId, newId, kind) => heard.push([oldId, newId, kind]));
  const other = await h.connect();
  await other.request("update_entity", { entityId: "light.desk", newId: "light.office" });
  await other.request("update_device", { deviceId: "fixture_hub", newId: "hub" });
  await until((now) => now.devices.some((d) => d.id === "hub"));
  await until(() => heard.length === 2);
  expect(heard).toEqual([
    ["light.desk", "light.office", "entity"],
    ["fixture_hub", "hub", "device"],
  ]);

  // Once off, a later rename is not heard.
  off();
  await other.request("update_device", { deviceId: "hub", newId: "bridge" });
  await until((now) => now.devices.some((d) => d.id === "bridge"));
  expect(heard).toHaveLength(2);
});

test("a change of unit system is followed live", async () => {
  await store.start();
  const other = await h.connect();
  await other.request("set_config", { path: "server.units", value: "imperial" });
  expect((await until((now) => now.units === "imperial")).units).toBe("imperial");
});

test("when the server goes away the house is kept and the store reconnects", async () => {
  // No grace, so the reconnecting phase is seen even though the harness is back at once.
  store.stop();
  store = createStore({
    connect: () => CasitaClient.connect(h.url, token),
    http: h.url,
    backoff: () => 20,
    graceMs: 0,
  });
  await store.start();
  const port = new URL(h.url).port;
  const dropped = until((now) => now.phase === "reconnecting");
  await h.restart();
  const house = await dropped;
  // What is shown meanwhile is the last the server said, not an empty house.
  expect(house.entities.length).toBeGreaterThan(0);
  // The harness picks a new port on restart; a browser's server would keep its own.
  if (new URL(h.url).port === port) await until((now) => now.phase === "ready");
  expect(await store.request("ping", {}).catch((err: Error) => err.message)).toBeDefined();
});

test("a socket that is cut and back within the grace shows no reconnecting; the store pings a quiet one", async () => {
  store.stop();
  const clients: CasitaClient[] = [];
  let pings = 0;
  store = createStore({
    connect: async () => {
      const client = await CasitaClient.connect(h.url, token);
      const request = client.request.bind(client);
      client.request = ((type: "ping", params: never) => {
        if (type === "ping") pings++;
        return request(type, params);
      }) as typeof client.request;
      clients.push(client);
      return client;
    },
    http: h.url,
    backoff: () => 20,
    keepaliveMs: 30,
  });
  const phases: string[] = [];
  store.subscribe(() => phases.push(store.getState().phase));
  await store.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(pings).toBeGreaterThanOrEqual(2);

  // The proxy, say, cuts the socket while the house is fine.
  clients[0]?.close();
  await until(() => clients.length === 2 && !clients[1]?.closed);
  await until((now) => now.phase === "ready");
  expect(phases).not.toContain("reconnecting");
  expect(await store.request("ping", {})).toMatchObject({ time: expect.any(Number) });
});

test("commands while disconnected fail plainly and leave nothing pending", async () => {
  const outcome = await store.command("light.desk", { domain: "light", action: "turn_on" }, "…");
  expect(outcome).toEqual({
    ok: false,
    code: "connection",
    message: "Not connected to the house right now",
  });
  expect(store.getState().pending.size).toBe(0);
});

test("with no session the store asks for a login; signing in loads the house", async () => {
  const admin = await addUser(h, await h.connect(), "ada", "admin");
  token = undefined;
  await store.start();
  expect(store.getState().phase).toBe("signed-out");

  await expect(store.login("ada", "wrong")).rejects.toThrow("Invalid username or password");
  expect(store.getState().phase).toBe("signed-out");

  // The cookie a browser would now hold; here the token stands in for it.
  token = admin.token;
  await store.login("ada", admin.password);
  expect(store.getState().phase).toBe("ready");
  expect(store.getState().me).toMatchObject({ username: "ada", role: "admin" });
});

test("a session ended elsewhere signs the store out and forgets the house", async () => {
  const admin = await addUser(h, await h.connect(), "ada", "admin");
  token = admin.token;
  await store.start();
  expect(store.getState().phase).toBe("ready");

  // Revoked from a second session, as an admin would from another device.
  const second = (await (await h.login("ada", admin.password)).json()) as { token: string };
  const other = await h.connect(second.token);
  const { sessionId } = (await store.request("get_me", {})) as { sessionId: string };
  await other.request("revoke_session", { sessionId });
  const house = await until((now) => now.phase === "signed-out");
  expect(house.entities).toEqual([]);
  expect(house.me).toBeUndefined();
});

test("logging out ends the session and forgets the house", async () => {
  await store.start();
  await store.logout();
  expect(store.getState()).toMatchObject({ phase: "signed-out", entities: [] });
});
