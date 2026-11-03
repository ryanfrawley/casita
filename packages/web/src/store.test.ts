import { describe, expect, test } from "bun:test";
import { type CasitaClient, CasitaError } from "@casita/client";
import { type Action, createStore, EMPTY, type House, reduce, type StoreOptions } from "./store.ts";

const loaded: Action = {
  type: "loaded",
  data: {
    me: { username: "ada" },
    entities: [{ id: "light.desk" }, { id: "lock.front_door" }],
    devices: [{ id: "dev_1" }],
    areas: [{ id: "office" }],
    integrations: [{ integrationId: "fixture.main", status: "running" }],
    states: [
      { entityId: "light.desk", state: { domain: "light", on: false }, available: true },
      { entityId: "lock.front_door", state: { domain: "lock", locked: true }, available: true },
    ],
  },
};
const ready = reduce(EMPTY, loaded);
const event = (payload: object): Action => ({ type: "event", event: payload as never });

test("loading fills the house and makes it ready; states are keyed by entity", () => {
  expect(ready.phase).toBe("ready");
  expect(ready.entities).toHaveLength(2);
  expect(ready.states.get("light.desk")).toMatchObject({ state: { on: false } });
  expect(ready.me).toEqual({ username: "ada" });
});

test("a state change replaces that entity's record and no other", () => {
  const next = reduce(
    ready,
    event({
      type: "state_changed",
      entityId: "light.desk",
      new: { entityId: "light.desk", state: { domain: "light", on: true }, available: true },
    }),
  );
  expect(next.states.get("light.desk")).toMatchObject({ state: { on: true } });
  expect(next.states.get("lock.front_door")).toBe(ready.states.get("lock.front_door"));
  // The old house is untouched: React compares by identity.
  expect(ready.states.get("light.desk")).toMatchObject({ state: { on: false } });
  expect(next.states).not.toBe(ready.states);
});

test("sending a command marks the entity pending and changes nothing else", () => {
  const sent = reduce(ready, {
    type: "command_sent",
    entityId: "light.desk",
    waiting: "Turning on…",
  });
  expect(sent.pending.get("light.desk")).toBe("Turning on…");
  // Not optimistic: the light is still off until the device says otherwise.
  expect(sent.states).toBe(ready.states);
  const done = reduce(sent, { type: "command_done", entityId: "light.desk" });
  expect(done.pending.size).toBe(0);
  expect(done.states).toBe(ready.states);
});

test("an integration's status is updated in place, or added if it is new", () => {
  const failed = reduce(
    ready,
    event({
      type: "integration_status",
      integrationId: "fixture.main",
      status: "error",
      error: "Can't reach the broker",
    }),
  );
  expect(failed.integrations).toEqual([
    { integrationId: "fixture.main", status: "error", error: "Can't reach the broker" },
  ]);
  const added = reduce(
    ready,
    event({ type: "integration_status", integrationId: "mqtt.main", status: "starting" }),
  );
  expect(added.integrations.map((i) => i.integrationId)).toEqual(["fixture.main", "mqtt.main"]);
});

test("events the reducer has no use for leave the house as it was, by identity", () => {
  for (const type of ["command_issued", "entity_updated", "area_removed", "config_changed"]) {
    expect(reduce(ready, event({ type, entityId: "light.desk" }))).toBe(ready);
  }
});

test("reconnecting keeps what was last known; signing out forgets it", () => {
  const pending = reduce(ready, { type: "command_sent", entityId: "light.desk", waiting: "…" });
  const dropped = reduce(pending, { type: "phase", phase: "reconnecting" });
  expect(dropped.entities).toBe(ready.entities);
  expect(dropped.states).toBe(ready.states);

  const out = reduce({ ...pending, units: "imperial" }, { type: "phase", phase: "signed-out" });
  expect(out).toEqual({ ...EMPTY, phase: "signed-out", units: "imperial" } satisfies House);
  expect(out.me).toBeUndefined();
});

test("a refreshed me replaces only who is signed in", () => {
  const renamed = reduce(ready, { type: "me", me: { ...ready.me, displayName: "Ry" } });
  expect(renamed.me).toEqual({ ...ready.me, displayName: "Ry" });
  expect(renamed.entities).toBe(ready.entities);
  expect(renamed.states).toBe(ready.states);
});

test("a later load replaces the lists whole", () => {
  const again = reduce(ready, {
    type: "loaded",
    data: { ...loaded.data, entities: [{ id: "light.office" }], states: [] },
  });
  expect(again.entities).toEqual([{ id: "light.office" }]);
  expect(again.states.size).toBe(0);
});

describe("recent", () => {
  const T0 = 1_700_000_000_000;
  const entities = [
    { id: "light.desk", name: "Desk lamp", domain: "light" },
    { id: "lock.front_door", name: "Front door", domain: "lock" },
    { id: "light.closet", name: "Closet", domain: "light", hidden: true },
    { id: "sensor.power", name: "Power", domain: "sensor" },
    { id: "binary_sensor.hall", name: "Hall", domain: "binary_sensor" },
  ];
  const record = (entityId: string, state: object, updatedAt = T0, extra: object = {}) => ({
    entityId,
    state: { domain: entityId.split(".")[0], ...state },
    available: true,
    changedAt: updatedAt,
    updatedAt,
    ...extra,
  });
  const house = reduce(EMPTY, {
    type: "loaded",
    data: {
      ...loaded.data,
      entities,
      states: [
        record("light.desk", { on: false }),
        record("lock.front_door", { locked: true }),
        record("light.closet", { on: false }),
        record("sensor.power", { value: 10, unit: "W" }),
      ],
    },
  });
  const changed = (from: House, after: ReturnType<typeof record>) =>
    reduce(from, event({ type: "state_changed", entityId: after.entityId, new: after }));

  test("starts empty", () => {
    expect(house.recent).toEqual([]);
  });

  test("a state change adds what it now reads as, with the entity's name and time", () => {
    const next = changed(house, record("light.desk", { on: true, brightness: 0.4 }, T0 + 1000));
    expect(next.recent).toEqual([
      { entityId: "light.desk", name: "Desk lamp", text: "On · 40%", at: T0 + 1000 },
    ]);
  });

  test("newest first", () => {
    const one = changed(house, record("light.desk", { on: true }, T0 + 1000));
    const two = changed(one, record("lock.front_door", { locked: false }, T0 + 2000));
    expect(two.recent.map((h) => [h.entityId, h.text])).toEqual([
      ["lock.front_door", "Unlocked"],
      ["light.desk", "On"],
    ]);
  });

  test("an entity's first state is news", () => {
    const fresh = reduce(house, {
      type: "loaded",
      data: { ...loaded.data, entities, states: [] },
    });
    const next = changed(fresh, record("lock.front_door", { locked: true }, T0 + 1000));
    expect(next.recent.map((h) => h.text)).toEqual(["Locked"]);
  });

  test("going unavailable is news", () => {
    const next = changed(
      house,
      record("light.desk", { on: false }, T0 + 1000, { available: false }),
    );
    expect(next.recent.map((h) => h.text)).toEqual(["Unavailable"]);
  });

  test("nothing is added when the wording did not change, e.g. only updatedAt moved", () => {
    const next = changed(house, record("light.desk", { on: false }, T0 + 60_000));
    expect(next.recent).toBe(house.recent);
    // The record itself is still replaced.
    expect(next.states.get("light.desk")).toMatchObject({ updatedAt: T0 + 60_000 });
  });

  test("nothing is added for a hidden entity", () => {
    const next = changed(house, record("light.closet", { on: true }, T0 + 1000));
    expect(next.recent).toEqual([]);
    expect(next.states.get("light.closet")).toMatchObject({ state: { on: true } });
  });

  test("nothing is added for an entity not in the entity list", () => {
    const next = changed(house, record("switch.unknown", { on: true }, T0 + 1000));
    expect(next.recent).toEqual([]);
    expect(next.states.has("switch.unknown")).toBe(true);
  });

  test("nothing is added for a sensor reading", () => {
    const next = changed(house, record("sensor.power", { value: 250, unit: "W" }, T0 + 1000));
    expect(next.recent).toEqual([]);
  });

  test("nothing is added when the weather changes, its condition or its temperature", () => {
    const withWeather = reduce(house, {
      type: "loaded",
      data: {
        ...loaded.data,
        entities: [...entities, { id: "weather.home", name: "Home", domain: "weather" }],
        states: [record("weather.home", { condition: "clear", temperature: 12 })],
      },
    });
    const rain = changed(
      withWeather,
      record("weather.home", { condition: "rain", temperature: 9 }, T0 + 1000),
    );
    expect(rain.recent).toEqual([]);
    expect(rain.states.get("weather.home")).toMatchObject({ state: { condition: "rain" } });
    const gone = changed(
      rain,
      record("weather.home", { condition: "rain" }, T0 + 2000, { available: false }),
    );
    expect(gone.recent).toEqual([]);
    // Other entities are still noted alongside it.
    expect(changed(gone, record("light.desk", { on: true }, T0 + 3000)).recent).toHaveLength(1);
  });

  test("at most 20 are kept, dropping the oldest", () => {
    let next = house;
    for (let i = 1; i <= 25; i++) {
      next = changed(next, record("light.desk", { on: i % 2 === 1 }, T0 + i * 1000));
    }
    expect(next.recent).toHaveLength(20);
    expect(next.recent[0]?.at).toBe(T0 + 25_000);
    expect(next.recent.at(-1)?.at).toBe(T0 + 6000);
  });

  // Suspected bug: the old text is worded with now = 0 and the new with now = updatedAt, so a
  // binary_sensor whose `changedAt` is fixed and only `updatedAt` moves (still "Motion") is
  // noted as "Motion · 5 min": the elapsed-time suffix differs, not the state.
  test("a binary_sensor whose state did not change adds nothing when updatedAt moves", () => {
    const motion = (updatedAt: number) => ({
      ...record("binary_sensor.hall", { on: true, deviceClass: "motion" }, updatedAt),
      changedAt: T0,
    });
    const before = changed(house, motion(T0));
    const after = changed(before, motion(T0 + 5 * 60_000));
    expect(after.recent).toBe(before.recent);
  });
});

describe("createStore request, while the socket is on its way", () => {
  const LOAD = new Set([
    "get_entities",
    "get_devices",
    "get_areas",
    "get_states",
    "get_integrations",
  ]);
  /** A stand-in socket: answers the load, records what else is asked, closes on demand. */
  const fakeClient = (name: string) => {
    const asked: string[] = [];
    let onClose: ((code: number) => void) | undefined;
    const client = {
      units: "metric" as const,
      asked,
      request: (type: string) => {
        if (type === "get_me") return Promise.resolve({ user: { username: "ada" } });
        if (LOAD.has(type)) return Promise.resolve([]);
        if (type === "subscribe") return Promise.resolve({});
        asked.push(type);
        return Promise.resolve({ from: name, type });
      },
      onEvent: () => {},
      onClose: (listener: (code: number) => void) => {
        onClose = listener;
      },
      close: () => {},
      /** The server ends the socket with this code. */
      drop: (code = 1006) => onClose?.(code),
    };
    return client;
  };
  type Fake = ReturnType<typeof fakeClient>;

  /** connect() calls, each settled by the test: `sockets[n].resolve(...)` or `.reject(...)`. */
  const harness = (options: Partial<StoreOptions> = {}) => {
    const sockets: { resolve(c: Fake): void; reject(e: unknown): void }[] = [];
    const store = createStore({
      connect: () =>
        new Promise<CasitaClient>((resolve, reject) => {
          sockets.push({ resolve: (c) => resolve(c as unknown as CasitaClient), reject });
        }),
      keepaliveMs: 0,
      graceMs: 5,
      backoff: () => 1,
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      ...options,
    });
    return { store, sockets };
  };
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  /** Settles a promise into what it came to, for asserting it has (or has not) settled. */
  const watch = <T>(p: Promise<T>) => {
    const seen: { value?: T; error?: unknown; done: boolean } = { done: false };
    p.then(
      (value) => Object.assign(seen, { value, done: true }),
      (error) => Object.assign(seen, { error, done: true }),
    );
    return seen;
  };
  const until = async (check: () => boolean, ms = 500) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await tick(1);
    }
  };

  test("a request made before the first socket opens is answered by that socket", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const answer = watch(store.request("get_status", {}));
    await tick(5);
    expect(answer.done).toBe(false);

    const socket = fakeClient("first");
    sockets[0]?.resolve(socket);
    await started;
    await until(() => answer.done);
    expect(answer.value).toEqual({ from: "first", type: "get_status" });
    expect(socket.asked).toEqual(["get_status"]);
    store.stop();
  });

  test("every request waiting is answered once the socket opens", async () => {
    const { store, sockets } = harness();
    void store.start();
    const all = Promise.all([
      store.request("get_status", {}),
      store.request("get_automations", {}),
      store.request("list_users", {}),
    ]);
    const socket = fakeClient("first");
    sockets[0]?.resolve(socket);
    expect(await all).toHaveLength(3);
    expect(socket.asked.sort()).toEqual(["get_automations", "get_status", "list_users"]);
    store.stop();
  });

  test("a request with a socket already open goes to it without waiting", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const socket = fakeClient("first");
    sockets[0]?.resolve(socket);
    await started;
    expect(await store.request("get_status", {})).toEqual({ from: "first", type: "get_status" });
  });

  test("a socket that does not come in connectWaitMs fails the request as not connected", async () => {
    const { store } = harness({ connectWaitMs: 20 });
    void store.start();
    const answer = watch(store.request("get_status", {}));
    await tick(5);
    expect(answer.done).toBe(false);
    await until(() => answer.done);
    expect(answer.error).toBeInstanceOf(CasitaError);
    expect(answer.error).toMatchObject({
      code: "connection",
      message: "Not connected to the house right now",
    });
    store.stop();
  });

  test("a socket that comes after the wait does not answer a request that timed out", async () => {
    const { store, sockets } = harness({ connectWaitMs: 10 });
    void store.start();
    const answer = watch(store.request("get_status", {}));
    await until(() => answer.done);
    const socket = fakeClient("late");
    sockets[0]?.resolve(socket);
    await tick(5);
    expect(socket.asked).toEqual([]);
    expect(answer.error).toMatchObject({ code: "connection" });
    store.stop();
  });

  test("a request in the gap after a drop is answered by the socket that replaces it", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const first = fakeClient("first");
    sockets[0]?.resolve(first);
    await started;

    first.drop();
    const answer = watch(store.request("get_status", {}));
    await until(() => sockets.length === 2);
    expect(answer.done).toBe(false);

    const second = fakeClient("second");
    sockets[1]?.resolve(second);
    await until(() => answer.done);
    expect(answer.value).toEqual({ from: "second", type: "get_status" });
    expect(first.asked).toEqual([]);
    expect(second.asked).toEqual(["get_status"]);
    store.stop();
  });

  test("a failed attempt keeps the request waiting for the retry", async () => {
    const { store, sockets } = harness();
    void store.start();
    const answer = watch(store.request("get_status", {}));
    sockets[0]?.reject(new CasitaError("connection", "Cannot connect"));
    await until(() => sockets.length === 2);
    expect(answer.done).toBe(false);
    sockets[1]?.resolve(fakeClient("retry"));
    await until(() => answer.done);
    expect(answer.value).toEqual({ from: "retry", type: "get_status" });
    store.stop();
  });

  test("stop() fails every request waiting, at once", async () => {
    const { store } = harness();
    void store.start();
    const a = watch(store.request("get_status", {}));
    const b = watch(store.request("get_status", {}));
    store.stop();
    await tick();
    expect(a.error).toMatchObject({ code: "connection" });
    expect(b.error).toMatchObject({ code: "connection" });
  });

  test("being refused at connect (signed out) fails what waits with an auth error", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const answer = watch(store.request("get_status", {}));
    sockets[0]?.reject(new CasitaError("auth", "Not signed in"));
    await started;
    await tick();
    expect(store.getState().phase).toBe("signed-out");
    expect(answer.error).toBeInstanceOf(CasitaError);
    expect(answer.error).toMatchObject({ code: "auth" });
    store.stop();
  });

  test("a socket closed for an ended session (4401) fails a request made after it", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const first = fakeClient("first");
    sockets[0]?.resolve(first);
    await started;
    first.drop(4401);
    expect(store.getState().phase).toBe("signed-out");
    // Signed out, nothing is coming: no waiting.
    const answer = watch(store.request("get_status", {}));
    await tick();
    expect(answer.error).toMatchObject({ code: "auth" });
  });

  test("going signed-out while a request waits fails it promptly with an auth error", async () => {
    const { store, sockets } = harness();
    const started = store.start();
    const first = fakeClient("first");
    sockets[0]?.resolve(first);
    await started;
    first.drop();
    const answer = watch(store.request("get_status", {}));
    // The retry is refused: the session has ended.
    await until(() => sockets.length === 2);
    sockets[1]?.reject(new CasitaError("auth", "Not signed in"));
    await until(() => answer.done, 50);
    expect(answer.error).toMatchObject({ code: "auth" });
    store.stop();
  });

  test("a store not started does not wait: the request fails at once", async () => {
    const { store, sockets } = harness({ connectWaitMs: 10_000 });
    const answer = watch(store.request("get_status", {}));
    await tick();
    expect(answer.error).toMatchObject({
      code: "connection",
      message: "Not connected to the house right now",
    });
    expect(sockets).toHaveLength(0);
  });

  test("a stopped store does not wait either", async () => {
    const { store, sockets } = harness({ connectWaitMs: 10_000 });
    const started = store.start();
    sockets[0]?.resolve(fakeClient("first"));
    await started;
    store.stop();
    const answer = watch(store.request("get_status", {}));
    await tick();
    expect(answer.error).toMatchObject({ code: "connection" });
  });

  test("a command does not wait for the socket: it fails at once and is never sent late", async () => {
    const { store, sockets } = harness();
    void store.start();
    const outcome = await store.command("light.desk", { type: "turn_on" } as never, "Turning on…");
    expect(outcome).toEqual({
      ok: false,
      code: "connection",
      message: "Not connected to the house right now",
    });
    const socket = fakeClient("first");
    sockets[0]?.resolve(socket);
    await tick(5);
    expect(socket.asked).toEqual([]);
    expect(store.getState().pending.size).toBe(0);
    store.stop();
  });

  test("refreshMe does not wait for the socket either", async () => {
    const { store } = harness();
    void store.start();
    await expect(store.refreshMe()).rejects.toMatchObject({ code: "connection" });
    store.stop();
  });

  test("an answered waiter leaves no timer behind", async () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    const waits = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = realSet(() => {
        live.delete(id);
        fn();
      }, ms);
      if (ms === 60_000) waits.add(id);
      live.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      live.delete(id);
      realClear(id as never);
    }) as typeof clearTimeout;
    try {
      const { store, sockets } = harness({ connectWaitMs: 60_000 });
      const started = store.start();
      const answers = [store.request("get_status", {}), store.request("get_status", {})];
      expect(waits.size).toBe(2);
      sockets[0]?.resolve(fakeClient("first"));
      await started;
      await Promise.all(answers);
      for (const id of waits) expect(live.has(id)).toBe(false);
      // A later stop() finds nothing waiting to fail.
      store.stop();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });
});
