import { describe, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { isUnavailable, type StateRecord, UNAVAILABLE, type Value } from "@casita/core/casa";
import { type Action, EMPTY, type House, reduce, type Store } from "../store.ts";
import { browserHost, CasaStore, DEFAULT_BREAKPOINTS, overridden, screenFor } from "./host.ts";

// ───────── a house ─────────

const entity = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  domain: id.split(".")[0],
  name,
  integrationId: "test.main",
  capabilities: {},
  level: "control",
  controllable: true,
  ...extra,
});

const record = (id: string, state: Row, extra: Row = {}): Row => ({
  entityId: id,
  state,
  available: true,
  changedAt: 1000,
  updatedAt: 2000,
  ...extra,
});

const LOADED = {
  me: { username: "ry", role: "admin" },
  entities: [
    entity("light.hall", "Hall light", { areaId: "hall", capabilities: { brightness: true } }),
    entity("sensor.hall_temp", "Hall temperature", { areaId: "hall", controllable: false }),
    entity("switch.porch", "Porch", { deviceId: "dev_porch" }),
  ],
  devices: [{ id: "dev_porch", name: "Porch switch", areaId: "hall" }],
  areas: [{ id: "hall", name: "Hall" }],
  cards: [],
  states: [
    record("light.hall", { domain: "light", on: true, brightness: 0.5 }),
    record("sensor.hall_temp", { domain: "sensor", value: 21.5, unit: "°C" }),
    record("switch.porch", { domain: "switch", on: false }),
  ],
  integrations: [],
};

const loadedHouse = (): House => reduce(EMPTY, { type: "loaded", data: LOADED as never });

/** Just enough of a Store for CasaStore: the house, and listeners a dispatch calls. */
function stubStore() {
  let house = loadedHouse();
  const listeners = new Set<() => void>();
  const dispatch = (action: Action) => {
    house = reduce(house, action);
    for (const listener of listeners) listener();
  };
  const store = {
    getState: () => house,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as Store;
  return { store, dispatch, listeners };
}

const stateChanged = (id: string, state: Row): Action => ({
  type: "event",
  event: {
    type: "state_changed",
    entityId: id,
    new: record(id, state, { updatedAt: 3000 }),
  } as never,
});

const casaStore = (width = 1200) => {
  const stub = stubStore();
  const casa = new CasaStore(stub.store, { width: () => width, tick: false, timezone: "UTC" });
  return { ...stub, casa };
};

// ───────── screenFor ─────────

describe("screenFor", () => {
  const bp = { tablet: 600, desktop: 1000 };

  test("at or past the desktop breakpoint is Desktop", () => {
    expect(screenFor(1000, bp)).toBe("Desktop");
    expect(screenFor(5000, bp)).toBe("Desktop");
  });

  test("at or past the tablet breakpoint and under desktop is Tablet", () => {
    expect(screenFor(600, bp)).toBe("Tablet");
    expect(screenFor(999, bp)).toBe("Tablet");
  });

  test("under the tablet breakpoint is Phone", () => {
    expect(screenFor(599, bp)).toBe("Phone");
    expect(screenFor(0, bp)).toBe("Phone");
  });

  test("the default breakpoints", () => {
    expect(screenFor(DEFAULT_BREAKPOINTS.desktop, DEFAULT_BREAKPOINTS)).toBe("Desktop");
    expect(screenFor(DEFAULT_BREAKPOINTS.tablet, DEFAULT_BREAKPOINTS)).toBe("Tablet");
    expect(screenFor(DEFAULT_BREAKPOINTS.tablet - 1, DEFAULT_BREAKPOINTS)).toBe("Phone");
  });
});

// ───────── overridden ─────────

const rec = (id: string, state: Row, extra: Row = {}) =>
  record(id, state, extra) as unknown as StateRecord;

describe("overridden", () => {
  test("a light keeps its brightness and takes on/off from the value", () => {
    const base = rec("light.hall", { domain: "light", on: false, brightness: 0.4 });
    expect(overridden(base, "light.hall", "On").state).toEqual({
      domain: "light",
      on: true,
      brightness: 0.4,
    });
    expect(overridden(base, "light.hall", "Off").state).toEqual({
      domain: "light",
      on: false,
      brightness: 0.4,
    });
  });

  test("a switch and a binary sensor are on only for On", () => {
    expect(
      overridden(rec("switch.a", { domain: "switch", on: false }), "switch.a", "On").state,
    ).toEqual({
      domain: "switch",
      on: true,
    });
    expect(
      overridden(
        rec("binary_sensor.door", { domain: "binary_sensor", on: true }),
        "binary_sensor.door",
        "Off",
      ).state,
    ).toEqual({ domain: "binary_sensor", on: false });
  });

  test("a sensor takes the value and keeps its unit", () => {
    const base = rec("sensor.t", { domain: "sensor", value: 21.5, unit: "°C" });
    expect(overridden(base, "sensor.t", 30).state).toEqual({
      domain: "sensor",
      value: 30,
      unit: "°C",
    });
    expect(overridden(base, "sensor.t", "dry").state).toMatchObject({ value: "dry" });
  });

  test("a climate takes the mode, lowercased, and keeps the rest", () => {
    const base = rec("climate.lounge", { domain: "climate", mode: "off", target: 20 });
    expect(overridden(base, "climate.lounge", "Heat").state as unknown).toEqual({
      domain: "climate",
      mode: "heat",
      target: 20,
    });
  });

  test("a cover: Closed is shut and still, Opening and Closing are in motion", () => {
    const base = rec("cover.blind", { domain: "cover", position: 0.5, motion: "stopped" });
    expect(overridden(base, "cover.blind", "Closed").state).toEqual({
      domain: "cover",
      position: 0,
      motion: "stopped",
    });
    expect(overridden(base, "cover.blind", "Open").state).toEqual({
      domain: "cover",
      position: 1,
      motion: "stopped",
    });
    expect(overridden(base, "cover.blind", "Opening").state).toMatchObject({ motion: "opening" });
    expect(overridden(base, "cover.blind", "Closing").state).toMatchObject({ motion: "closing" });
  });

  test("a lock is locked only for Locked", () => {
    const base = rec("lock.front", { domain: "lock", locked: false });
    expect(overridden(base, "lock.front", "Locked").state).toEqual({
      domain: "lock",
      locked: true,
    });
    expect(overridden(base, "lock.front", "Unlocked").state).toEqual({
      domain: "lock",
      locked: false,
    });
  });

  test("an override makes an unavailable entity available", () => {
    const base = rec("switch.a", { domain: "switch", on: false }, { available: false });
    expect(overridden(base, "switch.a", "On").available).toBe(true);
  });

  test("UNAVAILABLE marks it unavailable and leaves the state as it was", () => {
    const base = rec("light.hall", { domain: "light", on: true, brightness: 0.5 });
    const out = overridden(base, "light.hall", UNAVAILABLE);
    expect(out.available).toBe(false);
    expect(out.state).toEqual(base.state);
    expect(out.changedAt).toBe(base.changedAt);
  });

  test("weather: the member is the condition, its other fields kept", () => {
    const base = rec("weather.home", { domain: "weather", condition: "clear", temperature: 9 });
    expect(overridden(base, "weather.home", "PartlyCloudyNight").state).toEqual({
      domain: "weather",
      condition: "partly-cloudy-night",
      temperature: 9,
    });
  });

  test("a domain it does not know returns the record as reported", () => {
    const base = rec("button.bell", { domain: "button" } as never);
    expect(overridden(base, "button.bell", 5)).toBe(base);
  });

  test("the reported times and id are kept", () => {
    const base = rec("switch.a", { domain: "switch", on: false });
    expect(overridden(base, "switch.a", "On")).toMatchObject({
      entityId: "switch.a",
      changedAt: 1000,
      updatedAt: 2000,
    });
  });

  test("with no record, one is made: available, in the id's domain", () => {
    const out = overridden(undefined, "switch.new", "On");
    expect(out.entityId).toBe("switch.new" as never);
    expect(out.available).toBe(true);
    expect(out.state).toEqual({ domain: "switch", on: true });
    expect(typeof out.changedAt).toBe("number");

    const unknown = overridden(undefined, "weather.home", "Rain");
    expect(unknown).toMatchObject({ available: true, state: { domain: "weather" } });
  });
});

// ───────── browserHost ─────────

describe("browserHost", () => {
  const host = (
    overrides: ReadonlyMap<string, Value> = new Map(),
    onRead?: (key: string) => void,
  ) =>
    browserHost({
      house: loadedHouse(),
      screen: "Tablet",
      now: 10_000,
      timezone: "UTC",
      overrides,
      onRead,
    });

  test("state reads the house as reported without an override", () => {
    expect(host().state("light.hall")?.state).toEqual({
      domain: "light",
      on: true,
      brightness: 0.5,
    });
    expect(host().state("light.missing")).toBeUndefined();
  });

  test("state reads the override when there is one", () => {
    const h = host(
      new Map<string, Value>([
        ["light.hall", "Off"],
        ["switch.ghost", "On"],
      ]),
    );
    expect(h.state("light.hall")?.state).toEqual({ domain: "light", on: false, brightness: 0.5 });
    expect(h.state("switch.ghost")?.state).toEqual({ domain: "switch", on: true });
    expect(h.state("sensor.hall_temp")?.state).toMatchObject({ value: 21.5 });
  });

  test("an UNAVAILABLE override reads as unavailable", () => {
    const h = host(new Map([["light.hall", UNAVAILABLE]]));
    expect(h.state("light.hall")?.available).toBe(false);
    expect(isUnavailable(UNAVAILABLE)).toBe(true);
  });

  test("the registry, the screen, the clock and the timezone", () => {
    const h = host();
    expect(h.entities().map((e) => String(e.id))).toEqual([
      "light.hall",
      "sensor.hall_temp",
      "switch.porch",
    ]);
    expect(h.entity("switch.porch")?.name).toBe("Porch");
    expect(h.entity("switch.nope")).toBeUndefined();
    expect(h.devices().map((d) => String(d.id))).toEqual(["dev_porch"]);
    expect(h.areas().map((a) => String(a.id))).toEqual(["hall"]);
    expect(h.screen()).toBe("Tablet");
    expect(h.now()).toBe(10_000);
    expect(h.timezone).toBe("UTC");
  });

  test("unit is the sensor's unit in the metric default; anything else has none", () => {
    const h = host();
    const temp = h.entity("sensor.hall_temp");
    const light = h.entity("light.hall");
    expect(temp && h.unit(temp, h.state("sensor.hall_temp"))).toBe("°C");
    expect(light && h.unit(light, h.state("light.hall"))).toBeNull();
    expect(temp && h.unit(temp, undefined)).toBeNull();
  });

  test("a sensor with a text value or no unit has no unit", () => {
    const h = host(new Map([["sensor.hall_temp", "dry"]]));
    const temp = h.entity("sensor.hall_temp");
    expect(temp && h.unit(temp, h.state("sensor.hall_temp"))).toBeNull();
    const bare = rec("sensor.x", { domain: "sensor", value: 3 });
    expect(temp && h.unit(temp, bare)).toBeNull();
  });

  test("present reads the record the way the rest of the app does", () => {
    const h = host();
    const light = h.entity("light.hall");
    expect(light && h.present(light, h.state("light.hall"))).toBe("On · 50%");
    const off = host(new Map([["light.hall", "Off"]]));
    expect(light && off.present(light, off.state("light.hall"))).toBe("Off");
    expect(light && h.present(light, undefined)).toBe("No state yet");
  });

  test("format rounds to the places asked for", () => {
    const h = host();
    expect(h.format(21.456, 1)).toBe("21.5");
    expect(h.format(21.4, 2)).toBe("21.40");
    expect(h.format(1234, 0)).toBe("1,234");
  });

  test("onRead is passed through", () => {
    const reads: string[] = [];
    const onRead = (key: string) => reads.push(key);
    expect(host(new Map(), onRead).onRead).toBe(onRead);
    expect(host().onRead).toBeUndefined();
  });
});

// ───────── CasaStore ─────────

describe("CasaStore", () => {
  test("starts from the store's house and the measured width", () => {
    const { casa, store } = casaStore(1200);
    expect(casa.currentHouse).toBe(store.getState());
    expect(casa.currentScreen).toBe("Desktop");
    expect(casaStore(400).casa.currentScreen).toBe("Phone");
    expect(casa.timezone).toBe("UTC");
    casa.stop();
  });

  test("a state change bumps the version and that entity's key only", () => {
    const { casa, dispatch } = casaStore();
    const heard: number[] = [];
    casa.subscribe(() => heard.push(casa.version));
    const before = casa.version;
    dispatch(stateChanged("light.hall", { domain: "light", on: false }));
    expect(casa.version).toBeGreaterThan(before);
    expect(heard).toEqual([casa.version]);
    expect(casa.changedSince(["state:light.hall"], before)).toBe(true);
    expect(casa.changedSince(["state:switch.porch", "screen", "now"], before)).toBe(false);
    expect(casa.changedSince(["state:light.hall"], casa.version)).toBe(false);
    expect(casa.currentHouse.states.get("light.hall")?.state).toEqual({
      domain: "light",
      on: false,
    });
    casa.stop();
  });

  test("the host is remade after a change, and reads the new state", () => {
    const { casa, dispatch } = casaStore();
    const first = casa.host();
    expect(casa.host()).toBe(first);
    dispatch(stateChanged("switch.porch", { domain: "switch", on: true }));
    expect(casa.host()).not.toBe(first);
    expect(casa.host().state("switch.porch")?.state).toEqual({ domain: "switch", on: true });
    casa.stop();
  });

  test("setOverrides bumps the keys it sets and the keys it clears", () => {
    const { casa } = casaStore();
    const v0 = casa.version;
    casa.setOverrides(new Map([["light.hall", "Off"]]));
    expect(casa.changedSince(["state:light.hall"], v0)).toBe(true);
    expect(casa.changedSince(["state:switch.porch"], v0)).toBe(false);
    expect(casa.host().state("light.hall")?.state).toMatchObject({ on: false });

    const v1 = casa.version;
    casa.setOverrides(new Map([["switch.porch", "On"]]));
    // Both the one dropped and the one added changed.
    expect(casa.changedSince(["state:light.hall"], v1)).toBe(true);
    expect(casa.changedSince(["state:switch.porch"], v1)).toBe(true);
    expect(casa.host().state("light.hall")?.state).toMatchObject({ on: true });
    expect(casa.host().state("switch.porch")?.state).toMatchObject({ on: true });

    const v2 = casa.version;
    casa.setOverrides(new Map());
    expect(casa.changedSince(["state:switch.porch"], v2)).toBe(true);
    expect(casa.host().state("switch.porch")?.state).toMatchObject({ on: false });
    casa.stop();
  });

  test("clearing overrides that were already empty changes nothing", () => {
    const { casa } = casaStore();
    let heard = 0;
    casa.subscribe(() => heard++);
    const v0 = casa.version;
    casa.setOverrides(new Map());
    expect(casa.version).toBe(v0);
    expect(heard).toBe(0);
    casa.stop();
  });

  test("setWidth bumps screen only when the size class changes", () => {
    const { casa } = casaStore(1200);
    const v0 = casa.version;
    casa.setWidth(1150);
    expect(casa.version).toBe(v0);
    expect(casa.currentScreen).toBe("Desktop");

    casa.setWidth(900);
    expect(casa.currentScreen).toBe("Tablet");
    expect(casa.changedSince(["screen"], v0)).toBe(true);
    expect(casa.host().screen()).toBe("Tablet");

    const v1 = casa.version;
    casa.setWidth(320);
    expect(casa.currentScreen).toBe("Phone");
    expect(casa.changedSince(["screen"], v1)).toBe(true);
    casa.stop();
  });

  test("setBreakpoints re-reads the screen at the width it has", () => {
    const { casa } = casaStore(900);
    expect(casa.currentScreen).toBe("Tablet");
    const v0 = casa.version;
    casa.setBreakpoints({ tablet: 500, desktop: 800 });
    expect(casa.currentScreen).toBe("Desktop");
    expect(casa.changedSince(["screen"], v0)).toBe(true);

    // Forced: the same class still bumps, since the breakpoints themselves changed.
    const v1 = casa.version;
    casa.setBreakpoints({ tablet: 500, desktop: 850 });
    expect(casa.currentScreen).toBe("Desktop");
    expect(casa.version).toBeGreaterThan(v1);
    casa.stop();
  });

  test("tick moves the clock and bumps now", () => {
    const { casa } = casaStore();
    const v0 = casa.version;
    casa.tick(123_456);
    expect(casa.changedSince(["now"], v0)).toBe(true);
    expect(casa.changedSince(["screen"], v0)).toBe(false);
    expect(casa.host().now()).toBe(123_456);
    casa.stop();
  });

  test("a change of units bumps now, since every reading is shown anew", () => {
    const { casa, dispatch } = casaStore();
    const v0 = casa.version;
    dispatch({ type: "units", units: "imperial" });
    expect(casa.changedSince(["now"], v0)).toBe(true);
    casa.stop();
  });

  test("an unsubscribed listener is not called", () => {
    const { casa } = casaStore();
    let heard = 0;
    const off = casa.subscribe(() => heard++);
    off();
    casa.tick(1);
    expect(heard).toBe(0);
    casa.stop();
  });

  test("stop unsubscribes from the store", () => {
    const { casa, dispatch, listeners } = casaStore();
    expect(listeners.size).toBe(1);
    casa.stop();
    expect(listeners.size).toBe(0);
    const v0 = casa.version;
    dispatch(stateChanged("light.hall", { domain: "light", on: false }));
    expect(casa.version).toBe(v0);
  });
});

// ───────── pinWidth ─────────

describe("CasaStore.pinWidth", () => {
  // This file runs without a DOM, so the store only listens for `resize` when a window is put up
  // for it. A bare EventTarget is all it reads; the width comes from the measure passed in.
  const scope = globalThis as unknown as Record<string, unknown>;
  const withWindow = (run: (resize: (width: number) => void, casa: CasaStore) => void) => {
    const saved = Object.getOwnPropertyDescriptor(scope, "window");
    const window = new EventTarget();
    Object.defineProperty(scope, "window", { value: window, configurable: true, writable: true });
    let measured = 1200;
    const casa = new CasaStore(stubStore().store, {
      width: () => measured,
      tick: false,
      timezone: "UTC",
    });
    try {
      run((width) => {
        measured = width;
        window.dispatchEvent(new Event("resize"));
      }, casa);
    } finally {
      casa.stop();
      if (saved) Object.defineProperty(scope, "window", saved);
      else delete scope.window;
    }
  };

  test("unpinned, a resize of the window changes the screen", () => {
    withWindow((resize, casa) => {
      expect(casa.currentScreen).toBe("Desktop");
      resize(400);
      expect(casa.currentScreen).toBe("Phone");
    });
  });

  test("pinning sets the screen from the pinned width", () => {
    withWindow((_resize, casa) => {
      const v0 = casa.version;
      casa.pinWidth(400);
      expect(casa.currentScreen).toBe("Phone");
      expect(casa.changedSince(["screen"], v0)).toBe(true);
    });
  });

  test("while pinned, a resize of the window leaves the screen alone", () => {
    withWindow((resize, casa) => {
      casa.pinWidth(900);
      expect(casa.currentScreen).toBe("Tablet");
      const v0 = casa.version;
      resize(400);
      expect(casa.currentScreen).toBe("Tablet");
      resize(2000);
      expect(casa.currentScreen).toBe("Tablet");
      expect(casa.changedSince(["screen"], v0)).toBe(false);
    });
  });

  test("letting go goes back to the window's width, and resizes count again", () => {
    withWindow((resize, casa) => {
      casa.pinWidth(400);
      resize(900);
      expect(casa.currentScreen).toBe("Phone");
      // Released at the window's width as measured now, not as it was when pinned.
      casa.pinWidth(undefined);
      expect(casa.currentScreen).toBe("Tablet");
      resize(1500);
      expect(casa.currentScreen).toBe("Desktop");
    });
  });

  test("a pin can be moved while held", () => {
    withWindow((resize, casa) => {
      casa.pinWidth(400);
      casa.pinWidth(1500);
      expect(casa.currentScreen).toBe("Desktop");
      resize(400);
      expect(casa.currentScreen).toBe("Desktop");
    });
  });
});
