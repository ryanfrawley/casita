import { afterEach, describe, expect, test } from "bun:test";
import { type Row, setUnits } from "@casita/client";
import {
  areaList,
  classOptions,
  controllable,
  DOMAIN_LABEL,
  deviceDraft,
  deviceDraftErrors,
  deviceEntities,
  deviceList,
  devicePatch,
  domainCounts,
  entityDraft,
  entityDraftErrors,
  entityList,
  entityPatch,
  entityView,
  forecastView,
  greeting,
  HISTORY_RANGES,
  type HistoryRange,
  hasDeviceSettings,
  historyCsvUrl,
  historyKind,
  historyRangeOf,
  historyResolution,
  historySearch,
  historySelection,
  historyView,
  type Intent,
  intents,
  midnightIn,
  rainNote,
  rawRecords,
  segmentOf,
  sunPathView,
} from "./model.ts";
import { EMPTY, type House } from "./store.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

afterEach(() => setUnits("metric"));

// ───────── fixtures ─────────

const domainOf = (id: string) => id.split(".")[0] ?? "";

/** An entity row as the server returns it: controllable at control level unless told otherwise. */
const entity = (id: string, extra: Row = {}): Row => ({
  id,
  name: id.split(".")[1] ?? id,
  domain: domainOf(id),
  integrationId: "zigbee2mqtt.main",
  uniqueId: `u-${id}`,
  capabilities: {},
  controllable: true,
  level: "control",
  ...extra,
});

/** A state record; `state` gets the entity's domain filled in. */
const record = (id: string, state: Row, extra: Row = {}): Row => ({
  entityId: id,
  state: { domain: domainOf(id), ...state },
  available: true,
  changedAt: T0,
  updatedAt: T0,
  ...extra,
});

const houseOf = (parts: {
  entities?: Row[];
  records?: Row[];
  devices?: Row[];
  areas?: Row[];
  pending?: Record<string, string>;
}): House => ({
  ...EMPTY,
  entities: parts.entities ?? [],
  devices: parts.devices ?? [],
  areas: parts.areas ?? [],
  states: new Map((parts.records ?? []).map((r) => [String(r.entityId), r])),
  pending: new Map(Object.entries(parts.pending ?? {})),
});

/** The view of a single entity in a house holding only it (and its record, if given). */
const viewOf = (row: Row, state?: Row, extra: Row = {}, pending?: Record<string, string>) => {
  const id = String(row.id);
  const records = state ? [record(id, state, extra)] : [];
  return entityView(houseOf({ entities: [row], records, pending }), row, T0);
};

// ───────── entityView ─────────

describe("entityView", () => {
  test("a light that is on reads its level and is state on", () => {
    const view = viewOf(entity("light.kitchen", { name: "Ceiling" }), {
      on: true,
      brightness: 0.4,
    });
    expect(view).toMatchObject({
      id: "light.kitchen",
      name: "Ceiling",
      domain: "light",
      state: "on",
      summary: "On · 40%",
      level: "control",
      available: true,
      brightness: 0.4,
    });
  });

  test("a light that is off is state off with no brightness", () => {
    const view = viewOf(entity("light.kitchen"), { on: false });
    expect(view.state).toBe("off");
    expect(view.summary).toBe("Off");
    expect(view.brightness).toBeUndefined();
  });

  describe("pending", () => {
    test("wins over the confirmed state and reads the waiting text", () => {
      const view = viewOf(
        entity("light.kitchen"),
        { on: false },
        {},
        {
          "light.kitchen": "Turning on…",
        },
      );
      expect(view.state).toBe("pending");
      expect(view.summary).toBe("Turning on…");
    });

    test("wins over unavailable too", () => {
      const view = viewOf(
        entity("switch.fan"),
        { on: true },
        { available: false },
        { "switch.fan": "Turning off…" },
      );
      expect(view.state).toBe("pending");
      expect(view.summary).toBe("Turning off…");
    });

    test("for another entity has no effect", () => {
      const view = viewOf(entity("switch.fan"), { on: true }, {}, { "switch.other": "…" });
      expect(view.state).toBe("on");
      expect(view.summary).toBe("On");
    });
  });

  describe("unavailable", () => {
    test("reads 'Unavailable · was' its last state", () => {
      const view = viewOf(
        entity("light.kitchen"),
        { on: true, brightness: 0.4 },
        {
          available: false,
        },
      );
      expect(view.state).toBe("unavailable");
      expect(view.available).toBe(false);
      expect(view.summary).toBe("Unavailable · was On · 40%");
    });

    test("an entity with no state record at all is unavailable", () => {
      const view = viewOf(entity("light.kitchen"));
      expect(view.state).toBe("unavailable");
      expect(view.available).toBe(false);
      expect(view.record).toBeUndefined();
    });
  });

  describe("state on is only for light, switch and cover", () => {
    test("a switch that is on is on", () => {
      expect(viewOf(entity("switch.fan"), { on: true }).state).toBe("on");
    });

    test("an open cover is on, a closed one off", () => {
      expect(viewOf(entity("cover.garage"), { position: 1, motion: "stopped" }).state).toBe("on");
      expect(viewOf(entity("cover.garage"), { position: 0, motion: "stopped" }).state).toBe("off");
    });

    test("a binary_sensor that is on stays off-styled", () => {
      const view = viewOf(entity("binary_sensor.hall"), { on: true, deviceClass: "motion" });
      expect(view.summary.startsWith("Motion")).toBe(true);
      expect(view.state).toBe("off");
    });

    test("a sensor stays off-styled", () => {
      expect(viewOf(entity("sensor.temp"), { value: 21, unit: "°C" }).state).toBe("off");
    });

    test("a heating thermostat is not on", () => {
      expect(viewOf(entity("climate.hall"), { mode: "heat", currentTemp: 20 }).state).toBe("off");
    });
  });

  describe("level", () => {
    test("is read when the user's level is read", () => {
      const view = viewOf(entity("light.kitchen", { level: "read" }), { on: true });
      expect(view.level).toBe("read");
    });

    test("is read when the entity is not controllable", () => {
      const view = viewOf(entity("lock.front", { controllable: false }), { locked: true });
      expect(view.level).toBe("read");
    });

    test("is control when the user may and the entity can", () => {
      expect(viewOf(entity("lock.front"), { locked: true }).level).toBe("control");
    });

    test("a sensor or binary_sensor is never marked read", () => {
      const sensor = entity("sensor.temp", { level: "read", controllable: false });
      const binary = entity("binary_sensor.door", { level: "read", controllable: false });
      expect(viewOf(sensor, { value: 21 }).level).toBe("control");
      expect(viewOf(binary, { on: false }).level).toBe("control");
    });
  });

  describe("icon", () => {
    test("a rachio switch is a valve", () => {
      const zone = entity("switch.zone_1", { integrationId: "rachio.main" });
      expect(viewOf(zone, { on: false }).icon).toBe("valve");
    });

    test("a rachio sensor, and any other switch, keep their domain's icon", () => {
      const sensor = entity("sensor.rain", { integrationId: "rachio.main" });
      expect(viewOf(sensor, { value: 1 }).icon).toBeUndefined();
      expect(viewOf(entity("switch.fan"), { on: false }).icon).toBeUndefined();
    });

    test("a chosen icon wins over the domain's, a kind's, and the weather's", () => {
      expect(viewOf(entity("switch.fan", { icon: "fan" }), { on: false }).icon).toBe("fan");
      const zone = entity("switch.zone_1", { integrationId: "rachio.main", icon: "sprout" });
      expect(viewOf(zone, { on: false }).icon).toBe("sprout");
      const sky = entity("weather.home", { icon: "house" });
      expect(viewOf(sky, { condition: "rain" }).icon).toBe("house");
    });

    test.each([
      ["clear", "sun"],
      ["clear-night", "moon"],
      ["partly-cloudy", "cloud-sun"],
      ["partly-cloudy-night", "cloud-moon"],
      ["overcast", "cloud"],
      ["rain", "cloud-rain"],
      ["pouring", "cloud-rain-wind"],
      ["snow", "cloud-snow"],
      ["thunderstorm", "cloud-lightning"],
      // Not conditions: a plain cloud.
      ["sleet", "cloud"],
      ["toString", "cloud"],
    ])("the weather in condition %s is pictured as %s", (condition, icon) => {
      const weather = entity("weather.home", { integrationId: "open-meteo.main" });
      expect(viewOf(weather, { condition }).icon).toBe(icon);
    });

    test("the weather with no state yet is a plain cloud", () => {
      expect(viewOf(entity("weather.home")).icon).toBe("cloud");
    });
  });

  describe("weather", () => {
    test("reads its condition and temperature, takes no control, and is never marked read", () => {
      const weather = entity("weather.home", { level: "read", controllable: false });
      const view = viewOf(weather, { condition: "overcast", temperature: 11.8 });
      expect(view).toMatchObject({
        domain: "weather",
        state: "off",
        summary: "Overcast · 11.8°C",
        level: "control",
        available: true,
      });
      expect(controllable(view)).toBe(false);
    });

    test("unavailable says what it was", () => {
      const view = viewOf(entity("weather.home"), { condition: "rain" }, { available: false });
      expect(view.state).toBe("unavailable");
      expect(view.summary).toBe("Unavailable · was Rain");
    });
  });

  describe("dims", () => {
    test("comes from the brightness capability", () => {
      const dimmable = entity("light.a", { capabilities: { brightness: true } });
      expect(viewOf(dimmable, { on: true }).dims).toBe(true);
      expect(viewOf(entity("light.b"), { on: true }).dims).toBe(false);
    });

    test("is false when there are no capabilities at all", () => {
      const bare = entity("light.c", { capabilities: undefined });
      expect(viewOf(bare, { on: true }).dims).toBe(false);
    });
  });

  test("carries the entity row and the record", () => {
    const row = entity("switch.fan");
    const house = houseOf({ entities: [row], records: [record("switch.fan", { on: true })] });
    const view = entityView(house, row, T0);
    expect(view.entity).toBe(row);
    expect(view.record).toBe(house.states.get("switch.fan"));
  });
});

// ───────── controllable ─────────

describe("controllable", () => {
  test("a controllable, available light gets a control", () => {
    expect(controllable(viewOf(entity("light.kitchen"), { on: true }))).toBe(true);
  });

  test("not when read-only", () => {
    const view = viewOf(entity("light.kitchen", { level: "read" }), { on: true });
    expect(controllable(view)).toBe(false);
  });

  test("not when the domain takes no commands", () => {
    expect(controllable(viewOf(entity("sensor.temp"), { value: 21 }))).toBe(false);
    expect(controllable(viewOf(entity("binary_sensor.door"), { on: true }))).toBe(false);
  });

  test("not when unavailable", () => {
    const view = viewOf(entity("light.kitchen"), { on: true }, { available: false });
    expect(controllable(view)).toBe(false);
    expect(controllable(viewOf(entity("light.kitchen")))).toBe(false);
  });

  test("every commanded domain can be controlled", () => {
    const states: Record<string, Row> = {
      light: { on: true },
      switch: { on: true },
      cover: { position: 1, motion: "stopped" },
      lock: { locked: true },
      climate: { mode: "heat" },
      button: {},
    };
    for (const [domain, state] of Object.entries(states)) {
      expect(controllable(viewOf(entity(`${domain}.x`), state))).toBe(true);
    }
  });
});

// ───────── segmentOf ─────────

describe("segmentOf", () => {
  const door = (state: Row, extra: Row = {}, pending?: Record<string, string>) =>
    segmentOf(viewOf(entity("cover.garage_left"), state, extra, pending));

  test("a closed door is dark, and opens once confirmed", () => {
    expect(door({ position: 0, motion: "stopped" })).toEqual({
      active: false,
      pending: false,
      disabled: false,
      intent: intents.cover("open"),
      confirm: "Open?",
    });
  });

  test("an open door, or one part open, is lit and closes once confirmed", () => {
    expect(door({ position: 1, motion: "stopped" })).toMatchObject({
      active: true,
      intent: intents.cover("close"),
      confirm: "Close?",
    });
    expect(door({ position: 0.3, motion: "stopped" }).active).toBe(true);
  });

  test("a door whose position is unknown is dark and closes, as its row's button does", () => {
    expect(door({ motion: "stopped" })).toMatchObject({
      active: false,
      intent: intents.cover("close"),
      confirm: "Close?",
    });
  });

  test("a moving door is pending and stops at once, with no confirmation", () => {
    const closing = door({ position: 1, motion: "closing" });
    expect(closing).toEqual({
      active: true,
      pending: true,
      disabled: false,
      intent: intents.cover("stop"),
    });
    expect(door({ position: 0, motion: "opening" })).toMatchObject({
      active: false,
      pending: true,
      intent: intents.cover("stop"),
    });
  });

  test("a command in flight is pending and disabled, and stays lit by the device's word", () => {
    expect(
      door({ position: 1, motion: "stopped" }, {}, { "cover.garage_left": "Closing…" }),
    ).toMatchObject({ active: true, pending: true, disabled: true });
  });

  test("an unreachable or view-only door is disabled", () => {
    expect(door({ position: 0 }, { available: false }).disabled).toBe(true);
    const viewOnly = viewOf(entity("cover.garage_left", { level: "read" }), { position: 0 });
    expect(segmentOf(viewOnly).disabled).toBe(true);
  });

  test("a light or switch toggles at once, lit while on", () => {
    expect(segmentOf(viewOf(entity("light.porch"), { on: true }))).toEqual({
      active: true,
      pending: false,
      disabled: false,
      intent: intents.power(viewOf(entity("light.porch"), { on: true }), false),
    });
    expect(segmentOf(viewOf(entity("switch.fan"), { on: false })).intent?.command).toEqual({
      domain: "switch",
      action: "turn_on",
    });
  });

  test("a button presses and is never lit", () => {
    expect(segmentOf(viewOf(entity("button.chime"), {}))).toEqual({
      active: false,
      pending: false,
      disabled: false,
      intent: intents.press(),
    });
  });

  test("anything else is drawn disabled, with nothing to send", () => {
    expect(segmentOf(viewOf(entity("sensor.temp"), { value: 20 }))).toEqual({
      active: false,
      pending: false,
      disabled: true,
    });
  });
});

// ───────── intents ─────────

describe("intents", () => {
  const sw = viewOf(entity("switch.fan"), { on: false });
  const light = viewOf(entity("light.kitchen"), { on: false });

  test("power turns on and off in the view's own domain", () => {
    expect(intents.power(sw, true)).toEqual({
      command: { domain: "switch", action: "turn_on" },
      waiting: "Turning on…",
    });
    expect(intents.power(light, false)).toEqual({
      command: { domain: "light", action: "turn_off" },
      waiting: "Turning off…",
    });
  });

  test("brightness sets a fraction and says the percent", () => {
    expect(intents.brightness(40)).toEqual({
      command: { domain: "light", action: "turn_on", brightness: 0.4 },
      waiting: "Setting 40%…",
    });
    expect(intents.brightness(100).command).toEqual({
      domain: "light",
      action: "turn_on",
      brightness: 1,
    });
  });

  test("brightness 0 turns the light off rather than setting 0%", () => {
    const off: Intent = {
      command: { domain: "light", action: "turn_off" },
      waiting: "Turning off…",
    };
    expect(intents.brightness(0)).toEqual(off);
    expect(intents.brightness(-5)).toEqual(off);
  });

  test("lock(true) locks and lock(false) unlocks", () => {
    expect(intents.lock(true)).toEqual({
      command: { domain: "lock", action: "lock" },
      waiting: "Locking…",
    });
    expect(intents.lock(false)).toEqual({
      command: { domain: "lock", action: "unlock" },
      waiting: "Unlocking…",
    });
  });

  test("cover opens, closes and stops", () => {
    expect(intents.cover("open")).toEqual({
      command: { domain: "cover", action: "open" },
      waiting: "Opening…",
    });
    expect(intents.cover("close").waiting).toBe("Closing…");
    expect(intents.cover("close").command).toEqual({ domain: "cover", action: "close" });
    expect(intents.cover("stop").waiting).toBe("Stopping…");
    expect(intents.cover("stop").command).toEqual({ domain: "cover", action: "stop" });
  });

  test("press presses a button", () => {
    expect(intents.press()).toEqual({
      command: { domain: "button", action: "press" },
      waiting: "Pressing…",
    });
  });

  test("target carries Celsius and says the temperature as shown", () => {
    expect(intents.target(21.5, "71°")).toEqual({
      command: { domain: "climate", action: "set_target", temp: 21.5 },
      waiting: "Setting 71°…",
    });
  });

  test("mode switches the thermostat's mode", () => {
    expect(intents.mode("cool")).toEqual({
      command: { domain: "climate", action: "set_mode", mode: "cool" },
      waiting: "Switching to cool…",
    });
  });
});

// ───────── areaViews ─────────

describe("greeting", () => {
  // Local-time components, so the boundaries hold in any time zone.
  const at = (hour: number, minute = 0) => new Date(2026, 9, 4, hour, minute).getTime();

  test("night until 5", () => {
    expect(greeting(at(0))).toBe("Good night");
    expect(greeting(at(4, 59))).toBe("Good night");
  });

  test("morning from 5 until 12", () => {
    expect(greeting(at(5))).toBe("Good morning");
    expect(greeting(at(11, 59))).toBe("Good morning");
  });

  test("afternoon from 12 until 18", () => {
    expect(greeting(at(12))).toBe("Good afternoon");
    expect(greeting(at(17, 59))).toBe("Good afternoon");
  });

  test("evening from 18", () => {
    expect(greeting(at(18))).toBe("Good evening");
    expect(greeting(at(23, 59))).toBe("Good evening");
  });
});

// ───────── rainNote ─────────

describe("rainNote", () => {
  // Local-time components, so the clock times read the same in any time zone.
  const NOW = new Date(2026, 9, 5, 20, 30).getTime();
  const HOUR = 3_600_000;
  /** Hours ending 9 pm, 10 pm, … with the precipitation given for each. */
  const hours = (fell: (number | undefined)[], condition = "rain"): Row[] =>
    fell.map((precipitation, i) => ({
      at: new Date(2026, 9, 5, 21 + i).getTime(),
      precipitation,
      condition,
    }));

  test.each<[string, Row[], string | undefined]>([
    ["falling now, dry from 11 pm", hours([0.4, 0.2, 1, 0, 0]), "Rain until 11 pm"],
    ["falling for as long as is known", hours([0.4, 0.2, 1]), "Rain all day"],
    ["dry now, wet in the hour from 10 pm", hours([0, 0, 0.6, 0]), "Rain from 10 pm"],
    ["a trace is not rain", hours([0.05, 0, 0]), undefined],
    ["dry", hours([0, 0, 0]), undefined],
    ["no reading is not rain", hours([undefined, undefined]), undefined],
    ["snow says so", hours([0.5, 0], "snow"), "Snow until 9 pm"],
    ["snow on its way", hours([0, 0.5], "snow"), "Snow from 9 pm"],
    [
      "rain more than twelve hours off is not news yet",
      hours([...Array(12).fill(0), 2]),
      undefined,
    ],
    ["rain in the twelfth hour is", hours([...Array(11).fill(0), 2]), "Rain from 7 am"],
  ])("%s", (_, hourly, expected) => {
    expect(rainNote(hourly, NOW)).toBe(expected);
  });

  test("hours that have ended are not looked at", () => {
    const past = [{ at: NOW - HOUR, precipitation: 3, condition: "rain" }];
    expect(rainNote([...past, ...hours([0, 0])], NOW)).toBeUndefined();
    expect(rainNote(past, NOW)).toBeUndefined();
  });

  test("anything but a list of hours gives nothing", () => {
    expect(rainNote(undefined, NOW)).toBeUndefined();
    expect(rainNote("rain", NOW)).toBeUndefined();
    expect(rainNote([{ precipitation: 3 }], NOW)).toBeUndefined();
  });
});

// ───────── forecastView ─────────

describe("forecastView", () => {
  // 08:30 on Monday 5 October 2026 in Seattle.
  const NOW = Date.UTC(2026, 9, 5, 15, 30);
  const ZONE = "America/Los_Angeles";
  const day = (date: string, extra: Row = {}): Row => ({
    date,
    condition: "partly-cloudy",
    low: 10.4,
    high: 17.6,
    precipitationProbability: 20,
    ...extra,
  });
  const DAILY = [
    day("2026-10-04", { condition: "rain" }), // yesterday: dropped
    day("2026-10-05", { condition: "fog", low: 10.3, high: 17.3, precipitationProbability: 1 }),
    day("2026-10-06", { condition: "clear", precipitationProbability: 28.6 }),
    day("2026-10-07", { condition: "drizzle", precipitationProbability: undefined }),
  ];
  const weather = (
    state: Row = { condition: "overcast", temperature: 11.8 },
    attributes: Row = {
      timeZone: ZONE,
      daily: DAILY,
      attribution: "Weather data by Open-Meteo.com",
    },
    extra: Row = {},
    row: Row = {},
  ) =>
    houseOf({
      entities: [entity("weather.home", { name: "Home", ...row })],
      records: [record("weather.home", state, { attributes, ...extra })],
    });

  test("leads with the conditions now and the days from today, in Celsius", () => {
    expect(forecastView(weather(), NOW)).toEqual({
      entityId: "weather.home",
      title: "Home",
      unit: "°C",
      current: { temperature: 11.8, condition: "overcast", high: 17, low: 10 },
      days: [
        { label: "Today", condition: "fog", low: 10, high: 17, precip: 1 },
        { label: "Tue", condition: "clear", low: 10, high: 18, precip: 29 },
        { label: "Wed", condition: "drizzle", low: 10, high: 18, precip: undefined },
      ],
      attribution: "Weather data by Open-Meteo.com",
      outside: {
        temperature: "12",
        unit: "°C outside",
        icon: "cloud",
        line: "Overcast · H 17° L 10°",
      },
    });
  });

  test("beside the greeting: the house's units, and no high and low without a today", () => {
    setUnits("imperial");
    expect(forecastView(weather(), NOW)?.outside).toEqual({
      temperature: "53",
      unit: "°F outside",
      icon: "cloud",
      line: "Overcast · H 63° L 51°",
    });
    const bare = weather({ condition: "clear-night", temperature: 11.8 }, { timeZone: ZONE });
    expect(forecastView(bare, NOW)?.outside).toMatchObject({ icon: "moon", line: "Clear" });
    expect(forecastView(weather({ condition: "rain" }), NOW)?.outside).toBeUndefined();
  });

  describe("what it feels like", () => {
    const line = (state: Row) => forecastView(weather(state), NOW)?.outside?.line;

    test("is shown between the condition and the high and low when it is 2° off or more", () => {
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: 8.6 })).toBe(
        "Overcast · Feels 9° · H 17° L 10°",
      );
      // Warmer than the reading counts as much as colder.
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: 14.1 })).toBe(
        "Overcast · Feels 14° · H 17° L 10°",
      );
    });

    test("is shown at exactly 2° off", () => {
      expect(line({ condition: "overcast", temperature: 12, apparentTemperature: 10 })).toBe(
        "Overcast · Feels 10° · H 17° L 10°",
      );
    });

    test("is left out within 2°, where it only repeats the reading", () => {
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: 10.6 })).toBe(
        "Overcast · H 17° L 10°",
      );
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: 11.8 })).toBe(
        "Overcast · H 17° L 10°",
      );
    });

    test("is measured between the numbers shown, not the raw ones", () => {
      // 11.5 shows as 12 and 9.6 as 10: 2° apart as read, though 1.9 apart raw.
      expect(line({ condition: "overcast", temperature: 11.5, apparentTemperature: 9.6 })).toBe(
        "Overcast · Feels 10° · H 17° L 10°",
      );
    });

    test("is left out when there is no apparent temperature, or it is not a number", () => {
      expect(line({ condition: "overcast", temperature: 11.8 })).toBe("Overcast · H 17° L 10°");
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: "cold" })).toBe(
        "Overcast · H 17° L 10°",
      );
    });

    test("is measured and given in the house's units", () => {
      setUnits("imperial");
      // 1.5 °C apart is under 2 °C but 2.7 °F, so in Fahrenheit it is news: 10.3 °C is 50.54 °F.
      expect(line({ condition: "overcast", temperature: 11.8, apparentTemperature: 10.3 })).toBe(
        "Overcast · Feels 51° · H 63° L 51°",
      );
    });

    test("comes straight after the condition when there is no today for a high and low", () => {
      const bare = weather(
        { condition: "clear-night", temperature: 11.8, apparentTemperature: 7 },
        { timeZone: ZONE },
      );
      expect(forecastView(bare, NOW)?.outside?.line).toBe("Clear · Feels 7°");
    });
  });

  test("the hourly forecast becomes the rain badge", () => {
    const hourly = [{ at: NOW + 30 * 60_000, precipitation: 0.4, condition: "rain" }];
    const view = forecastView(weather(undefined, { timeZone: ZONE, daily: DAILY, hourly }), NOW);
    expect(view?.rain).toBe("Rain all day");
    expect(forecastView(weather(), NOW)?.rain).toBeUndefined();
  });

  test("in imperial, temperatures are in Fahrenheit and the days' are rounded", () => {
    setUnits("imperial");
    const view = forecastView(weather(), NOW);
    expect(view?.unit).toBe("°F");
    expect(view?.current?.temperature).toBeCloseTo(53.24);
    // 10.3 °C is 50.54 °F, 17.3 °C is 63.14 °F.
    expect(view?.days[0]).toMatchObject({ label: "Today", low: 51, high: 63 });
    expect(view?.current).toMatchObject({ low: 51, high: 63 });
  });

  test("today is the place's date, not UTC's", () => {
    // 8 pm in Seattle on the 5th is already the 6th in UTC.
    const evening = Date.UTC(2026, 9, 6, 3);
    expect(forecastView(weather(), evening)?.days[0]?.label).toBe("Today");
    expect(forecastView(weather(), evening)?.days[0]?.condition).toBe("fog");
    // The next morning, the 5th has passed and the 6th is today.
    const tomorrow = Date.UTC(2026, 9, 6, 15);
    expect(forecastView(weather(), tomorrow)?.days.map((d) => d.label)).toEqual(["Today", "Wed"]);
  });

  test("an unknown time zone falls back to the browser's instead of throwing", () => {
    const house = weather(undefined, { timeZone: "Mars/Olympus_Mons", daily: DAILY });
    expect(() => forecastView(house, NOW)).not.toThrow();
    expect(forecastView(house, NOW)?.current?.temperature).toBe(11.8);
  });

  test("when today is not in the forecast, the days are weekdays and now has no high or low", () => {
    const house = weather(undefined, { timeZone: ZONE, daily: DAILY.slice(2) });
    const view = forecastView(house, NOW);
    expect(view?.days.map((d) => d.label)).toEqual(["Tue", "Wed"]);
    expect(view?.current).toEqual({ temperature: 11.8, condition: "overcast" });
  });

  test("a day with no low or high is left out", () => {
    const house = weather(undefined, {
      timeZone: ZONE,
      daily: [
        day("2026-10-05", { low: null }),
        day("2026-10-06", { high: undefined }),
        day("2026-10-07"),
      ],
    });
    expect(forecastView(house, NOW)?.days.map((d) => d.label)).toEqual(["Wed"]);
  });

  test("with no temperature now, there is no current block but the days still show", () => {
    const view = forecastView(weather({ condition: "overcast" }), NOW);
    expect(view?.current).toBeUndefined();
    expect(view?.days).toHaveLength(3);
  });

  test("no attributes at all, or a daily that is not a list, means no days", () => {
    const bare = forecastView(weather(undefined, {}), NOW);
    expect(bare?.days).toEqual([]);
    expect(bare?.attribution).toBeUndefined();
    expect(forecastView(weather(undefined, { daily: "soon" }), NOW)?.days).toEqual([]);
  });

  test("an attribution that is not text is not shown", () => {
    expect(
      forecastView(weather(undefined, { daily: DAILY, attribution: 42 }), NOW)?.attribution,
    ).toBeUndefined();
  });

  describe("none", () => {
    test("when there is no weather entity", () => {
      const house = houseOf({
        entities: [entity("sensor.temp")],
        records: [record("sensor.temp", { value: 21 })],
      });
      expect(forecastView(house, NOW)).toBeUndefined();
    });

    test("when it is hidden or disabled", () => {
      expect(
        forecastView(weather(undefined, undefined, {}, { hidden: true }), NOW),
      ).toBeUndefined();
      expect(
        forecastView(weather(undefined, undefined, {}, { disabled: true }), NOW),
      ).toBeUndefined();
    });

    test("when it is unavailable, since an old forecast is not one", () => {
      expect(
        forecastView(weather(undefined, undefined, { available: false }), NOW),
      ).toBeUndefined();
    });

    test("when it has no state yet", () => {
      const house = houseOf({ entities: [entity("weather.home")] });
      expect(forecastView(house, NOW)).toBeUndefined();
    });

    test("when there is neither a temperature now nor a day to show", () => {
      const house = weather({ condition: "clear" }, { daily: [day("2026-10-01")] });
      expect(forecastView(house, NOW)).toBeUndefined();
    });
  });

  test("of several, the first by id that is shown", () => {
    const house = houseOf({
      entities: [
        entity("weather.zcabin", { name: "Cabin" }),
        entity("weather.home", { name: "Home", hidden: true }),
        entity("weather.beach", { name: "Beach" }),
      ],
      records: [
        record("weather.zcabin", { condition: "snow", temperature: -2 }),
        record("weather.home", { condition: "clear", temperature: 20 }),
        record("weather.beach", { condition: "clear", temperature: 25 }),
      ],
    });
    expect(forecastView(house, NOW)).toMatchObject({ entityId: "weather.beach", title: "Beach" });
  });
});

// ───────── sunPathView ─────────

describe("sunPathView", () => {
  const ZONE = "America/Los_Angeles";
  const HOUR = 60 * MIN;
  // Monday 5 October 2026 in Seattle (UTC-7): sunrise 7:12 am, sunset 6:42 pm.
  const RISE = Date.UTC(2026, 9, 5, 14, 12);
  const SET = Date.UTC(2026, 9, 6, 1, 42);
  // Tuesday: sunrise 7:13 am, sunset 6:40 pm.
  const RISE2 = Date.UTC(2026, 9, 6, 14, 13);
  const SET2 = Date.UTC(2026, 9, 7, 1, 40);
  const DAILY = [
    { date: "2026-10-04", sunrise: RISE - 24 * HOUR + MIN, sunset: SET - 24 * HOUR + 2 * MIN },
    { date: "2026-10-05", sunrise: RISE, sunset: SET },
    { date: "2026-10-06", sunrise: RISE2, sunset: SET2 },
  ];
  const weather = (attributes: Row = { timeZone: ZONE, daily: DAILY }, extra: Row = {}): Row => ({
    state: { domain: "weather", condition: "clear" },
    available: true,
    attributes,
    ...extra,
  });

  // Monday's and Tuesday's midnights in Seattle: 7 am UTC, in summer time.
  const MONDAY = Date.UTC(2026, 9, 5, 7);
  const TUESDAY = Date.UTC(2026, 9, 6, 7);
  const WEDNESDAY = Date.UTC(2026, 9, 7, 7);

  test("before sunrise: today's times and day, and how long until it rises", () => {
    expect(sunPathView(weather(), RISE - 90 * MIN)).toEqual({
      rise: "7:12 am",
      set: "6:42 pm",
      dayStart: MONDAY,
      dayEnd: TUESDAY,
      riseAt: RISE,
      setAt: SET,
      now: RISE - 90 * MIN,
      timeZone: ZONE,
      headline: "Sunrise in 1h 30m",
      detail: "11h 30m of daylight",
    });
  });

  test("by day: how long until it sets", () => {
    const view = sunPathView(weather(), (RISE + SET) / 2);
    expect(view).toMatchObject({
      rise: "7:12 am",
      set: "6:42 pm",
      headline: "Sunset in 5h 45m",
      detail: "11h 30m of daylight",
    });
    expect(view?.now).toBe((RISE + SET) / 2);
  });

  test("at sunrise itself the sun is up, and it counts down to sunset", () => {
    const view = sunPathView(weather(), RISE);
    expect(view?.headline).toBe("Sunset in 11h 30m");
    expect(view?.now).toBe(view?.riseAt as number);
  });

  test("after sunset: still today's times, counting down to tomorrow's sunrise", () => {
    expect(sunPathView(weather(), SET + 2 * HOUR)).toEqual({
      rise: "7:12 am",
      set: "6:42 pm",
      dayStart: MONDAY,
      dayEnd: TUESDAY,
      riseAt: RISE,
      setAt: SET,
      now: SET + 2 * HOUR,
      timeZone: ZONE,
      headline: "Sunrise in 10h 31m",
      detail: "11h 30m of daylight",
    });
  });

  test("at sunset itself the sun has set", () => {
    const view = sunPathView(weather(), SET);
    expect(view?.headline).toBe("Sunrise in 12h 31m");
    expect(view?.now).toBe(view?.setAt as number);
  });

  test("after sunset on the last listed day, the sun has set, with nothing to count down to", () => {
    expect(sunPathView(weather(), SET2 + MIN)).toEqual({
      rise: "7:13 am",
      set: "6:40 pm",
      dayStart: TUESDAY,
      dayEnd: WEDNESDAY,
      riseAt: RISE2,
      setAt: SET2,
      now: SET2 + MIN,
      timeZone: ZONE,
      headline: "The sun has set",
      detail: "11h 27m of daylight",
    });
  });

  test("after sunset, a gap in the forecast is not tomorrow: the next listed day is not counted down to", () => {
    // Monday, then Wednesday: Tuesday is missing.
    const daily = [
      { date: "2026-10-05", sunrise: RISE, sunset: SET },
      { date: "2026-10-07", sunrise: RISE2 + 24 * HOUR, sunset: SET2 + 24 * HOUR },
    ];
    expect(sunPathView(weather({ timeZone: ZONE, daily }), SET + HOUR)?.headline).toBe(
      "The sun has set",
    );
  });

  test("today is the house's date: after its midnight it is tomorrow's sun", () => {
    // 12:30 am on Tuesday in Seattle is 7:30 am UTC.
    const view = sunPathView(weather(), Date.UTC(2026, 9, 6, 7, 30));
    expect(view).toMatchObject({
      rise: "7:13 am",
      set: "6:40 pm",
      headline: "Sunrise in 6h 43m",
    });
    // Just past midnight is the start of Tuesday, not 24 hours into Monday.
    expect(view).toMatchObject({ dayStart: TUESDAY, dayEnd: WEDNESDAY });
    expect((view?.now ?? 0) - (view?.dayStart ?? 0)).toBe(30 * MIN);
  });

  test("before midnight in Seattle it is still Monday, though UTC has moved on", () => {
    // 11:59 pm on Monday in Seattle is 6:59 am on Tuesday in UTC.
    const view = sunPathView(weather(), Date.UTC(2026, 9, 6, 6, 59));
    expect(view).toMatchObject({ rise: "7:12 am", headline: "Sunrise in 7h 14m" });
    expect(view).toMatchObject({ dayStart: MONDAY, dayEnd: TUESDAY });
    expect((view?.dayEnd ?? 0) - (view?.now ?? 0)).toBe(MIN);
  });

  test("now, sunrise and sunset are the moments themselves, to the millisecond", () => {
    const view = sunPathView(weather(), RISE + 30_123);
    expect(view).toMatchObject({ riseAt: RISE, setAt: SET, now: RISE + 30_123 });
  });

  test("yesterday is passed over even when it is listed first", () => {
    expect(sunPathView(weather(), RISE - HOUR)?.rise).toBe("7:12 am");
  });

  test("the clock reads in the given zone, with lowercase am and pm", () => {
    const view = sunPathView(weather({ timeZone: "Europe/London", daily: DAILY }), RISE - HOUR);
    // 14:12 and 01:42 UTC are 3:12 pm and 2:42 am in London's summer time.
    expect(view).toMatchObject({ rise: "3:12 pm", set: "2:42 am" });
    expect(view?.rise).not.toMatch(/[AP]M/);
    // The space before am or pm is a plain one, whatever Intl puts there.
    expect(view?.rise).toContain(" ");
    expect(view?.rise).not.toMatch(/[\u00a0\u202f]/);
  });

  test("an unknown or missing time zone falls back to the browser's instead of throwing", () => {
    for (const timeZone of ["Mars/Olympus_Mons", undefined, 42]) {
      const view = sunPathView(weather({ timeZone, daily: DAILY }), RISE - HOUR);
      expect(view?.rise).toMatch(/^\d{1,2}:\d\d [ap]m$/);
      expect(Number.isFinite(view?.dayStart)).toBe(true);
    }
  });

  test("the zone is passed on when it is a name, and left out otherwise", () => {
    expect(sunPathView(weather(), RISE)?.timeZone).toBe(ZONE);
    for (const timeZone of [undefined, 42]) {
      const view = sunPathView(weather({ timeZone, daily: DAILY }), RISE);
      expect(view).toBeDefined();
      expect(view).not.toHaveProperty("timeZone");
    }
  });

  test("the day is the house's, midnight to midnight, in its zone", () => {
    // London's Monday runs from 11 pm UTC on Sunday, in summer time.
    const daily = [{ date: "2026-10-05", sunrise: RISE - 8 * HOUR, sunset: SET - 8 * HOUR }];
    const view = sunPathView(weather({ timeZone: "Europe/London", daily }), RISE - 8 * HOUR);
    expect(view).toMatchObject({
      dayStart: Date.UTC(2026, 9, 4, 23),
      dayEnd: Date.UTC(2026, 9, 5, 23),
    });
  });

  describe("on the days the clocks change", () => {
    // Sunday 1 November 2026, when Seattle's clocks go back at 2 am, and the Monday after.
    const NOV1 = {
      date: "2026-11-01",
      sunrise: Date.UTC(2026, 10, 1, 14, 59),
      sunset: Date.UTC(2026, 10, 2, 0, 50),
    };
    const NOV2 = {
      date: "2026-11-02",
      sunrise: Date.UTC(2026, 10, 2, 15, 1),
      sunset: Date.UTC(2026, 10, 3, 0, 49),
    };

    test("the day the clocks go back is 25 hours long", () => {
      const view = sunPathView(weather({ timeZone: ZONE, daily: [NOV1, NOV2] }), NOV1.sunrise);
      expect(view?.dayStart).toBe(Date.UTC(2026, 10, 1, 7));
      expect(view?.dayEnd).toBe(Date.UTC(2026, 10, 2, 8));
    });

    test("the day they go forward is 23 hours long", () => {
      const daily = [
        {
          date: "2026-03-08",
          sunrise: Date.UTC(2026, 2, 8, 14, 30),
          sunset: Date.UTC(2026, 2, 9, 2, 10),
        },
      ];
      const view = sunPathView(weather({ timeZone: ZONE, daily }), Date.UTC(2026, 2, 8, 20));
      expect((view?.dayEnd ?? 0) - (view?.dayStart ?? 0)).toBe(23 * HOUR);
    });

    test("after sunset on a 25-hour day, tomorrow is the next date", () => {
      // 11:30 pm on Sunday is 7:30 am UTC on Monday, the extra hour in.
      const now = Date.UTC(2026, 10, 2, 7, 30);
      const view = sunPathView(weather({ timeZone: ZONE, daily: [NOV1, NOV2] }), now);
      expect(view?.rise).toBe("6:59 am");
      expect(view?.headline).toBe("Sunrise in 7h 31m");
    });
  });

  test("tomorrow runs on across the end of a month and a year", () => {
    const daily = [
      {
        date: "2026-12-31",
        sunrise: Date.UTC(2026, 11, 31, 15, 58),
        sunset: Date.UTC(2027, 0, 1, 0, 30),
      },
      {
        date: "2027-01-01",
        sunrise: Date.UTC(2027, 0, 1, 15, 58),
        sunset: Date.UTC(2027, 0, 2, 0, 31),
      },
    ];
    const now = Date.UTC(2027, 0, 1, 2);
    const view = sunPathView(weather({ timeZone: ZONE, daily }), now);
    expect(view?.headline).toBe("Sunrise in 13h 58m");
    expect(view?.dayEnd).toBe(Date.UTC(2027, 0, 1, 8));
  });

  describe("where the house is", () => {
    const at = (latitude: unknown, longitude: unknown) =>
      sunPathView(weather({ timeZone: ZONE, daily: DAILY, latitude, longitude }), RISE);

    test("the weather's latitude and longitude are passed on", () => {
      expect(at(47.6, -122.32)).toMatchObject({ latitude: 47.6, longitude: -122.32 });
    });

    test("the poles and the date line are in range", () => {
      expect(at(90, 180)).toMatchObject({ latitude: 90, longitude: 180 });
      expect(at(-90, -180)).toMatchObject({ latitude: -90, longitude: -180 });
      expect(at(0, 0)).toMatchObject({ latitude: 0, longitude: 0 });
    });

    test.each([
      ["a latitude past a pole", 90.01, 0],
      ["a latitude past the other", -91, 0],
      ["a longitude past the date line", 0, 180.5],
      ["a longitude past it the other way", 0, -181],
      ["a latitude that is a string", "47.6", -122.32],
      ["a longitude that is not a number", 47.6, NaN],
      ["an infinite latitude", Number.POSITIVE_INFINITY, 0],
      ["no latitude", undefined, -122.32],
      ["no longitude", 47.6, undefined],
    ])("%s drops both, since one alone places nothing", (_, latitude, longitude) => {
      const view = at(latitude, longitude);
      expect(view?.rise).toBe("7:12 am");
      expect(view).not.toHaveProperty("latitude");
      expect(view).not.toHaveProperty("longitude");
    });
  });

  test("a day with no sun times, or with them the wrong way round, is skipped", () => {
    const daily = [
      { date: "2026-10-05" },
      { date: "2026-10-05", sunrise: RISE },
      { date: "2026-10-05", sunrise: String(RISE), sunset: String(SET) },
      { date: "2026-10-05", sunrise: SET, sunset: RISE },
      { date: "2026-10-05", sunrise: RISE, sunset: RISE },
      { date: "2026-10-05", sunrise: RISE, sunset: SET },
      { date: "2026-10-06", sunrise: RISE2, sunset: SET2 },
    ];
    expect(sunPathView(weather({ timeZone: ZONE, daily }), RISE + HOUR)).toMatchObject({
      rise: "7:12 am",
      set: "6:42 pm",
      headline: "Sunset in 10h 30m",
    });
    // With only the broken ones, today has no sun.
    const broken = daily.slice(0, 5);
    expect(sunPathView(weather({ timeZone: ZONE, daily: broken }), RISE + HOUR)).toBeUndefined();
  });

  describe("none", () => {
    test("when there is no record", () => {
      expect(sunPathView(undefined, RISE)).toBeUndefined();
    });

    test("when the weather is unavailable", () => {
      expect(sunPathView(weather(undefined, { available: false }), RISE)).toBeUndefined();
    });

    test("when there are no attributes, or the daily is not a list", () => {
      expect(sunPathView(weather(undefined, { attributes: undefined }), RISE)).toBeUndefined();
      expect(sunPathView(weather({ daily: "soon" }), RISE)).toBeUndefined();
      expect(sunPathView(weather({ daily: [] }), RISE)).toBeUndefined();
    });

    test("when today is not in the forecast", () => {
      // Wednesday, after the last listed day.
      expect(sunPathView(weather(), SET2 + 6 * HOUR)).toBeUndefined();
      // Saturday the 3rd, before the first.
      expect(sunPathView(weather(), RISE - 48 * HOUR)).toBeUndefined();
    });
  });

  test("a record with no availability flag counts as available", () => {
    const { available: _, ...bare } = weather();
    expect(sunPathView(bare, RISE)?.rise).toBe("7:12 am");
  });
});

// ───────── midnightIn ─────────

describe("midnightIn", () => {
  const HOUR = 60 * MIN;
  const LA = "America/Los_Angeles";

  test.each([
    // Where the clocks spring forward at midnight, it never comes: the date begins at 1:00.
    ["2026-09-06", "America/Santiago", Date.UTC(2026, 8, 6, 4)],
    ["2026-03-29", "Atlantic/Azores", Date.UTC(2026, 2, 29, 1)],
    ["2026-03-08", "America/Havana", Date.UTC(2026, 2, 8, 5)],
  ])("on %s in %s, a skipped midnight is the date's first moment", (date, zone, first) => {
    expect(midnightIn(date, zone)).toBe(first);
    // A second before is still the eve.
    expect(new Date(first - 1000).toLocaleDateString("en-CA", { timeZone: zone })).not.toBe(date);
  });

  test("a date's midnight in a zone behind UTC is later in UTC", () => {
    // Seattle is on summer time, 7 hours behind, in October.
    expect(midnightIn("2026-10-05", LA)).toBe(Date.UTC(2026, 9, 5, 7));
    // And on standard time, 8 behind, in January.
    expect(midnightIn("2026-01-15", LA)).toBe(Date.UTC(2026, 0, 15, 8));
  });

  test("in UTC it is the date itself", () => {
    expect(midnightIn("2026-10-05", "UTC")).toBe(Date.UTC(2026, 9, 5));
  });

  test("ahead of UTC it is on the date before, by the zone's offset to the minute", () => {
    expect(midnightIn("2026-10-05", "Asia/Kolkata")).toBe(Date.UTC(2026, 9, 4, 18, 30));
    // The Chatham Islands are 13h 45m ahead in their summer.
    expect(midnightIn("2026-10-05", "Pacific/Chatham")).toBe(Date.UTC(2026, 9, 4, 10, 15));
  });

  test("the day the clocks go back is 25 hours long", () => {
    // Sunday 1 November 2026: midnight is still on summer time, the next on standard time.
    const start = midnightIn("2026-11-01", LA);
    const end = midnightIn("2026-11-02", LA);
    expect(start).toBe(Date.UTC(2026, 10, 1, 7));
    expect(end).toBe(Date.UTC(2026, 10, 2, 8));
    expect(end - start).toBe(25 * HOUR);
  });

  test("the day the clocks go forward is 23 hours long", () => {
    // Sunday 8 March 2026: midnight is on standard time, the next on summer time.
    const start = midnightIn("2026-03-08", LA);
    const end = midnightIn("2026-03-09", LA);
    expect(start).toBe(Date.UTC(2026, 2, 8, 8));
    expect(end).toBe(Date.UTC(2026, 2, 9, 7));
    expect(end - start).toBe(23 * HOUR);
  });

  test("the days either side of a change are 24 hours long", () => {
    for (const [from, to] of [
      ["2026-10-31", "2026-11-01"],
      ["2026-11-02", "2026-11-03"],
      ["2026-03-07", "2026-03-08"],
      ["2026-03-09", "2026-03-10"],
    ]) {
      expect(midnightIn(to as string, LA) - midnightIn(from as string, LA)).toBe(24 * HOUR);
    }
  });

  test("it is the date's first moment there: a second before is the date before", () => {
    const date = (ms: number, timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone }).format(ms);
    for (const timeZone of [LA, "Europe/London", "Asia/Kolkata", "Australia/Sydney"]) {
      const midnight = midnightIn("2026-11-01", timeZone);
      expect(date(midnight, timeZone)).toBe("2026-11-01");
      expect(date(midnight - 1000, timeZone)).toBe("2026-10-31");
    }
  });

  test("across a month and a year", () => {
    expect(midnightIn("2027-01-01", LA)).toBe(Date.UTC(2027, 0, 1, 8));
    expect(midnightIn("2026-03-01", "UTC") - midnightIn("2026-02-28", "UTC")).toBe(24 * HOUR);
  });

  test("an unknown or missing zone falls back to the runtime's", () => {
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = midnightIn("2026-10-05", runtime);
    for (const zone of ["Mars/Olympus_Mons", undefined, 42]) {
      expect(midnightIn("2026-10-05", zone)).toBe(expected);
    }
  });
});

// ───────── historyView ─────────

describe("historyView", () => {
  const FROM = T0;
  const at = (minutes: number) => FROM + minutes * MIN;
  const rec = (domain: string, minutes: number, state: Row, available = true): Row => ({
    entityId: `${domain}.x`,
    state: { domain, ...state },
    available,
    updatedAt: at(minutes),
  });

  describe("on/off domains", () => {
    test("consecutive equal states merge; each closes at the next change; the last is open", () => {
      const view = historyView(
        "light",
        [
          rec("light", 0, { on: true }),
          rec("light", 5, { on: true, brightness: 0.5 }),
          rec("light", 10, { on: false }),
          rec("light", 20, { on: true }),
        ],
        FROM,
      );
      expect(view.segments).toEqual([
        { from: at(0), to: at(10), state: "on" },
        { from: at(10), to: at(20), state: "off" },
        { from: at(20), state: "on" },
      ]);
      expect(view.series).toBeUndefined();
    });

    test("a record from before the range is clamped to its start", () => {
      const view = historyView(
        "switch",
        [rec("switch", -30, { on: false }), rec("switch", 15, { on: true })],
        FROM,
      );
      expect(view.segments).toEqual([
        { from: FROM, to: at(15), state: "off" },
        { from: at(15), state: "on" },
      ]);
    });

    test("available: false becomes an unavailable segment", () => {
      const view = historyView(
        "binary_sensor",
        [
          rec("binary_sensor", 0, { on: true }),
          rec("binary_sensor", 5, { on: true }, false),
          rec("binary_sensor", 8, { on: true }, false),
          rec("binary_sensor", 12, { on: false }),
        ],
        FROM,
      );
      expect(view.segments).toEqual([
        { from: at(0), to: at(5), state: "on" },
        { from: at(5), to: at(12), state: "unavailable" },
        { from: at(12), state: "off" },
      ]);
    });

    test("a binary sensor's states read by its class, as its row does", () => {
      const door = historyView(
        "binary_sensor",
        [rec("binary_sensor", 0, { on: true, deviceClass: "door" })],
        FROM,
      );
      expect(door.states).toEqual({
        on: { label: "Open", tone: "on" },
        off: { label: "Closed", tone: "off" },
      });
      const leak = historyView(
        "binary_sensor",
        [rec("binary_sensor", 0, { on: false, deviceClass: "leak" })],
        FROM,
      );
      expect(leak.states).toEqual({
        on: { label: "Wet", tone: "alert" },
        off: { label: "Dry", tone: "off" },
      });
    });

    test("a class the integration added partway through the range names the whole bar", () => {
      const view = historyView(
        "binary_sensor",
        [
          rec("binary_sensor", 0, { on: true }),
          rec("binary_sensor", 5, { on: false, deviceClass: "window" }),
          rec("binary_sensor", 8, { on: true }, false),
        ],
        FROM,
      );
      expect(view.states?.on?.label).toBe("Open");
      expect(view.states?.off?.label).toBe("Closed");
    });

    test("an unclassified binary sensor is on or off; a light has no custom words", () => {
      const view = historyView("binary_sensor", [rec("binary_sensor", 0, { on: true })], FROM);
      expect(view.states).toEqual({
        on: { label: "On", tone: "on" },
        off: { label: "Off", tone: "off" },
      });
      expect(historyView("light", [rec("light", 0, { on: true })], FROM).states).toBeUndefined();
    });

    test("no records give no segments", () => {
      expect(historyView("light", [], FROM).segments).toEqual([]);
    });
  });

  describe("weather", () => {
    const records = [
      rec("weather", -10, { condition: "clear", temperature: 20 }),
      rec("weather", 5, { condition: "rain" }),
      rec("weather", 10, { condition: "rain", temperature: 15 }, false),
      rec("weather", 15, { condition: "rain", temperature: -40 }),
    ];

    test("an Outside series of the temperature, in Celsius under metric, gaps where unknown", () => {
      expect(historyView("weather", records, FROM)).toEqual({
        unit: "°",
        series: [
          {
            label: "Outside",
            points: [
              [FROM, 20],
              [at(5), null],
              [at(10), null],
              [at(15), -40],
            ],
          },
        ],
      });
    });

    test("in Fahrenheit under imperial", () => {
      setUnits("imperial");
      const view = historyView("weather", records, FROM);
      expect(view.series?.[0]?.points.map(([, v]) => v)).toEqual([68, null, null, -40]);
      expect(view.segments).toBeUndefined();
    });
  });

  test("lock: locked, unlocked and jammed, with their state definitions", () => {
    const view = historyView(
      "lock",
      [
        rec("lock", 0, { locked: true }),
        rec("lock", 5, { locked: false }),
        rec("lock", 10, { locked: true, jammed: true }),
      ],
      FROM,
    );
    expect(view.segments?.map((s) => s.state)).toEqual(["locked", "unlocked", "jammed"]);
    expect(view.states).toEqual({
      locked: { label: "Locked", tone: "ok" },
      unlocked: { label: "Unlocked", tone: "on" },
      jammed: { label: "Jammed", tone: "alert" },
    });
  });

  test("cover: closed at position 0 or below, open otherwise, with their state definitions", () => {
    const view = historyView(
      "cover",
      [
        rec("cover", 0, { position: 0, motion: "stopped" }),
        rec("cover", 2, { position: 0.3, motion: "stopped" }),
        rec("cover", 4, { position: 1, motion: "stopped" }),
        rec("cover", 6, { position: -0.1, motion: "stopped" }),
      ],
      FROM,
    );
    expect(view.segments).toEqual([
      { from: at(0), to: at(2), state: "closed" },
      { from: at(2), to: at(6), state: "open" },
      { from: at(6), state: "closed" },
    ]);
    expect(view.states).toEqual({
      open: { label: "Open", tone: "on" },
      closed: { label: "Closed", tone: "off" },
    });
  });

  describe("climate", () => {
    const records = [
      rec("climate", -10, { mode: "heat", currentTemp: 19, targetTemp: 21 }),
      rec("climate", 5, { mode: "heat", currentTemp: 20, targetTemp: 21 }),
      rec("climate", 10, { mode: "heat", currentTemp: 20, targetTemp: 22 }, false),
    ];

    test("gives an Inside series and a stepped Target series in Celsius under metric", () => {
      const view = historyView("climate", records, FROM);
      expect(view.unit).toBe("°");
      expect(view.segments).toBeUndefined();
      expect(view.series).toEqual([
        {
          label: "Inside",
          points: [
            [FROM, 19],
            [at(5), 20],
            [at(10), null],
          ],
        },
        {
          label: "Target",
          points: [
            [FROM, 21],
            [at(5), 21],
            [at(10), null],
          ],
          step: true,
        },
      ]);
    });

    test("converts to Fahrenheit under imperial", () => {
      setUnits("imperial");
      const view = historyView("climate", records, FROM);
      expect(view.unit).toBe("°");
      const [inside, target] = view.series ?? [];
      expect(inside?.points.map(([, v]) => v)).toEqual([66.2, 68, null]);
      expect(target?.points[0]?.[1]).toBeCloseTo(69.8);
      expect(target?.step).toBe(true);
    });

    test("a missing temperature is a gap", () => {
      const view = historyView("climate", [rec("climate", 0, { mode: "off" })], FROM);
      expect(view.series?.map((s) => s.points)).toEqual([[[FROM, null]], [[FROM, null]]]);
    });
  });

  describe("sensor", () => {
    test("a numeric sensor gives one series in its own unit, with gaps where unavailable", () => {
      const view = historyView(
        "sensor",
        [
          rec("sensor", -5, { value: 120, unit: "W" }),
          rec("sensor", 5, { value: 80, unit: "W" }, false),
          rec("sensor", 10, { value: 95, unit: "W" }),
        ],
        FROM,
      );
      expect(view).toEqual({
        unit: "W",
        series: [
          {
            label: "Reading",
            points: [
              [FROM, 120],
              [at(5), null],
              [at(10), 95],
            ],
          },
        ],
      });
    });

    test("a temperature in °C is converted to °F under imperial", () => {
      setUnits("imperial");
      const view = historyView(
        "sensor",
        [rec("sensor", 0, { value: 20, unit: "°C" }), rec("sensor", 5, { value: 25, unit: "°C" })],
        FROM,
      );
      expect(view.unit).toBe("°F");
      expect(view.series?.[0]?.points).toEqual([
        [at(0), 68],
        [at(5), 77],
      ]);
    });

    test("the unit comes from the first record that has one", () => {
      const view = historyView(
        "sensor",
        [rec("sensor", 0, { value: null }), rec("sensor", 5, { value: 40, unit: "%" })],
        FROM,
      );
      expect(view.unit).toBe("%");
      expect(view.series?.[0]?.points).toEqual([
        [at(0), null],
        [at(5), 40],
      ]);
    });

    test("a text value among numbers is a gap", () => {
      const view = historyView(
        "sensor",
        [rec("sensor", 0, { value: 1 }), rec("sensor", 5, { value: "error" })],
        FROM,
      );
      expect(view.series?.[0]?.points).toEqual([
        [at(0), 1],
        [at(5), null],
      ]);
    });

    test("a sensor with text values is a timeline, each word a state in the order it first appears", () => {
      const view = historyView(
        "sensor",
        [
          rec("sensor", -3, { value: "asleep" }),
          rec("sensor", 0, { value: "online" }),
          rec("sensor", 5, { value: "online" }),
          rec("sensor", 10, { value: "driving" }),
          rec("sensor", 15, { value: null }, false),
          rec("sensor", 20, { value: "asleep" }),
        ],
        FROM,
      );
      expect(view.series).toBeUndefined();
      expect(view.segments).toEqual([
        { from: at(0), to: at(0), state: "asleep" },
        { from: at(0), to: at(10), state: "online" },
        { from: at(10), to: at(15), state: "driving" },
        { from: at(15), to: at(20), state: "unavailable" },
        { from: at(20), state: "asleep" },
      ]);
      expect(view.states).toEqual({
        asleep: { label: "Asleep", tone: "off" },
        online: { label: "Online", tone: "on" },
        driving: { label: "Driving", tone: "ok" },
      });
    });

    test("a text sensor whose value is missing in a record is unavailable there", () => {
      const view = historyView(
        "sensor",
        [rec("sensor", 0, { value: "idle" }), rec("sensor", 5, { value: "" })],
        FROM,
      );
      expect(view.segments?.map((s) => s.state)).toEqual(["idle", "unavailable"]);
    });

    test("a sensor with no records gives nothing to chart", () => {
      expect(historyView("sensor", [], FROM)).toEqual({});
    });
  });

  test("an unknown domain gives {}", () => {
    expect(historyView("button", [rec("button", 0, { pressedAt: at(0) })], FROM)).toEqual({});
    expect(historyView("vacuum", [rec("vacuum", 0, { on: true })], FROM)).toEqual({});
  });
});

// ───────── lists ─────────

describe("DOMAIN_LABEL", () => {
  test("names every domain a pill can filter by, in display order", () => {
    expect(Object.keys(DOMAIN_LABEL)).toEqual([
      "light",
      "switch",
      "cover",
      "lock",
      "climate",
      "sensor",
      "binary_sensor",
      "button",
      "weather",
    ]);
    expect(DOMAIN_LABEL.binary_sensor).toBe("Binary sensors");
  });
});

describe("entityList", () => {
  const kitchen = { id: "kitchen", name: "Cocina" };
  const plug = { id: "dev_1", name: "Smart plug", integrationId: "zigbee2mqtt.main" };
  const ids = (items: { id: string }[]) => items.map((item) => item.id);

  describe("what is listed", () => {
    test("hidden, disabled and orphaned entities are all included", () => {
      const house = houseOf({
        entities: [
          entity("light.a"),
          entity("light.b", { hidden: true }),
          entity("light.c", { disabled: true }),
          entity("light.d", { orphaned: true }),
        ],
      });
      expect(ids(entityList(house, {}, T0))).toEqual(["light.a", "light.b", "light.c", "light.d"]);
    });

    test("an empty house lists nothing", () => {
      expect(entityList(houseOf({}), {}, T0)).toEqual([]);
    });

    test("the filter defaults to everything", () => {
      const house = houseOf({ entities: [entity("light.a"), entity("sensor.b")] });
      expect(ids(entityList(house))).toEqual(["light.a", "sensor.b"]);
    });
  });

  describe("flags", () => {
    test("an ordinary entity has none", () => {
      const house = houseOf({ entities: [entity("light.a")] });
      expect(entityList(house, {}, T0)[0]?.flags).toEqual([]);
    });

    test("each of hidden, disabled and orphaned gets its own flag", () => {
      const house = houseOf({
        entities: [
          entity("light.b", { hidden: true }),
          entity("light.c", { disabled: true }),
          entity("light.d", { orphaned: true }),
        ],
      });
      expect(entityList(house, {}, T0).map((item) => item.flags)).toEqual([
        ["Hidden"],
        ["Disabled"],
        ["Orphaned"],
      ]);
    });

    test("all three together read in the order Hidden, Disabled, Orphaned", () => {
      const house = houseOf({
        entities: [entity("light.a", { orphaned: true, disabled: true, hidden: true })],
      });
      expect(entityList(house, {}, T0)[0]?.flags).toEqual(["Hidden", "Disabled", "Orphaned"]);
    });
  });

  describe("domains", () => {
    const house = houseOf({
      entities: [entity("light.a"), entity("switch.b"), entity("sensor.c"), entity("lock.d")],
    });

    test("keeps only the domains asked for", () => {
      expect(ids(entityList(house, { domains: ["light", "sensor"] }, T0))).toEqual([
        "light.a",
        "sensor.c",
      ]);
    });

    test("an empty list means every domain", () => {
      expect(entityList(house, { domains: [] }, T0)).toHaveLength(4);
    });

    test("a domain with no entities gives nothing", () => {
      expect(entityList(house, { domains: ["climate"] }, T0)).toEqual([]);
    });
  });

  describe("query", () => {
    const house = houseOf({
      areas: [kitchen],
      entities: [
        entity("light.ceiling", { name: "Ceiling Lamp", effectiveAreaId: "kitchen" }),
        entity("switch.fan", { name: "Fan" }),
        entity("sensor.temp", { name: "Temperature" }),
      ],
    });
    const found = (query: string) => ids(entityList(house, { query }, T0));

    test("matches the name, ignoring case", () => {
      expect(found("ceiling lamp")).toEqual(["light.ceiling"]);
      expect(found("FAN")).toEqual(["switch.fan"]);
    });

    test("matches the id", () => {
      expect(found("sensor.te")).toEqual(["sensor.temp"]);
    });

    test("matches the area's name", () => {
      expect(found("cocina")).toEqual(["light.ceiling"]);
    });

    test("does not match the area's id", () => {
      expect(found("kitchen")).toEqual([]);
    });

    test("ignores surrounding spaces", () => {
      expect(found("  fan  ")).toEqual(["switch.fan"]);
    });

    test("a blank query matches everything", () => {
      expect(found("   ")).toHaveLength(3);
    });

    test("combines with domains: both must match", () => {
      const items = entityList(house, { domains: ["switch"], query: "temp" }, T0);
      expect(items).toEqual([]);
    });
  });

  describe("area and device", () => {
    test("area is the name of the effective area, device the name of the device", () => {
      const house = houseOf({
        areas: [kitchen],
        devices: [plug],
        entities: [entity("switch.plug", { deviceId: "dev_1", effectiveAreaId: "kitchen" })],
      });
      const item = entityList(house, {}, T0)[0];
      expect(item?.area).toBe("Cocina");
      expect(item?.device).toBe("Smart plug");
    });

    test("the area follows effectiveAreaId, not areaId", () => {
      const bedroom = { id: "bedroom", name: "Bedroom" };
      const house = houseOf({
        areas: [kitchen, bedroom],
        entities: [entity("switch.plug", { areaId: "bedroom", effectiveAreaId: "kitchen" })],
      });
      expect(entityList(house, {}, T0)[0]?.area).toBe("Cocina");
    });

    test("both are undefined when the area or device is not known", () => {
      const house = houseOf({
        areas: [kitchen],
        devices: [plug],
        entities: [
          entity("switch.a", { deviceId: "dev_gone", effectiveAreaId: "attic" }),
          entity("switch.b"),
        ],
      });
      for (const item of entityList(house, {}, T0)) {
        expect(item.area).toBeUndefined();
        expect(item.device).toBeUndefined();
      }
    });
  });

  test("each item carries the entity's view", () => {
    const house = houseOf({
      entities: [entity("light.a", { name: "Lamp" })],
      records: [record("light.a", { on: true })],
    });
    const item = entityList(house, {}, T0)[0];
    expect(item?.view).toMatchObject({ id: "light.a", name: "Lamp", state: "on" });
  });

  test("sorts by name, then by id for equal names", () => {
    const house = houseOf({
      entities: [
        entity("switch.z", { name: "Bravo" }),
        entity("light.b", { name: "Alpha" }),
        entity("light.a", { name: "Bravo" }),
      ],
    });
    expect(ids(entityList(house, {}, T0))).toEqual(["light.b", "light.a", "switch.z"]);
  });
});

describe("domainCounts", () => {
  test("one entry per domain present, in DOMAIN_LABEL's order, with label and count", () => {
    const house = houseOf({
      entities: [
        entity("sensor.a"),
        entity("light.a"),
        entity("sensor.b"),
        entity("button.a"),
        entity("light.b"),
        entity("light.c"),
      ],
    });
    expect(domainCounts(house)).toEqual([
      { value: "light", label: "Lights", count: 3 },
      { value: "sensor", label: "Sensors", count: 2 },
      { value: "button", label: "Buttons", count: 1 },
    ]);
  });

  test("hidden and disabled entities are counted", () => {
    const house = houseOf({
      entities: [entity("lock.a", { hidden: true }), entity("lock.b", { disabled: true })],
    });
    expect(domainCounts(house)).toEqual([{ value: "lock", label: "Locks", count: 2 }]);
  });

  test("an empty house has no domains", () => {
    expect(domainCounts(houseOf({}))).toEqual([]);
  });
});

describe("deviceList", () => {
  const kitchen = { id: "kitchen", name: "Kitchen" };
  const device = (id: string, extra: Row = {}): Row => ({
    id,
    name: id,
    integrationId: "zigbee2mqtt.main",
    ...extra,
  });

  describe("maker", () => {
    const makerOf = (extra: Row) =>
      deviceList(houseOf({ devices: [device("d", extra)] }))[0]?.maker;

    test("joins manufacturer and model with ' · '", () => {
      expect(makerOf({ manufacturer: "IKEA", model: "TRADFRI bulb" })).toBe("IKEA · TRADFRI bulb");
    });

    test("is just the one that is known", () => {
      expect(makerOf({ manufacturer: "IKEA" })).toBe("IKEA");
      expect(makerOf({ model: "TRADFRI bulb" })).toBe("TRADFRI bulb");
    });

    test("is empty when neither is known", () => {
      expect(makerOf({})).toBe("");
    });
  });

  test("carries id, name, area name and integration id", () => {
    const house = houseOf({
      areas: [kitchen],
      devices: [device("dev_1", { name: "Plug", areaId: "kitchen", integrationId: "hue.main" })],
    });
    expect(deviceList(house)[0]).toMatchObject({
      id: "dev_1",
      name: "Plug",
      area: "Kitchen",
      integrationId: "hue.main",
    });
  });

  test("area is undefined for an unknown or missing area", () => {
    const house = houseOf({
      areas: [kitchen],
      devices: [device("a", { areaId: "attic" }), device("b")],
    });
    expect(deviceList(house).map((item) => item.area)).toEqual([undefined, undefined]);
  });

  test("entities counts the device's entities, hidden ones too", () => {
    const house = houseOf({
      devices: [device("a"), device("b")],
      entities: [
        entity("switch.a", { deviceId: "a" }),
        entity("sensor.a", { deviceId: "a", hidden: true }),
        entity("switch.loose"),
      ],
    });
    expect(deviceList(house).map((item) => item.entities)).toEqual([2, 0]);
  });

  describe("status", () => {
    const statusOf = (extra: Row, entities: Row[], records: Row[] = []) =>
      deviceList(houseOf({ devices: [device("d", extra)], entities, records }))[0]?.status;

    test("online when an entity has an available record", () => {
      const entities = [
        entity("switch.a", { deviceId: "d" }),
        entity("sensor.a", { deviceId: "d" }),
      ];
      const records = [
        record("switch.a", { on: true }, { available: false }),
        record("sensor.a", { value: 1 }),
      ];
      expect(statusOf({}, entities, records)).toBe("online");
    });

    test("unavailable when every record is unavailable", () => {
      const entities = [entity("switch.a", { deviceId: "d" })];
      const records = [record("switch.a", { on: true }, { available: false })];
      expect(statusOf({}, entities, records)).toBe("unavailable");
    });

    test("unavailable when its entities have no records at all", () => {
      expect(statusOf({}, [entity("switch.a", { deviceId: "d" })])).toBe("unavailable");
    });

    test("online when it has no entities", () => {
      expect(statusOf({}, [])).toBe("online");
    });

    test("disabled when orphaned, even if reachable", () => {
      const entities = [entity("switch.a", { deviceId: "d" })];
      const records = [record("switch.a", { on: true })];
      expect(statusOf({ orphaned: true }, entities, records)).toBe("disabled");
      expect(statusOf({ orphaned: true }, [])).toBe("disabled");
    });

    test("another device's records do not count", () => {
      const entities = [
        entity("switch.a", { deviceId: "d" }),
        entity("switch.b", { deviceId: "x" }),
      ];
      const records = [record("switch.b", { on: true })];
      expect(statusOf({}, entities, records)).toBe("unavailable");
    });
  });

  describe("query", () => {
    const house = houseOf({
      devices: [
        device("dev_plug", { name: "Smart Plug", manufacturer: "IKEA", model: "Tretakt" }),
        device("dev_valve", { name: "Sprinkler", integrationId: "rachio.main" }),
        device("dev_bulb", { name: "Bulb", manufacturer: "Signify", model: "Hue White" }),
      ],
    });
    const found = (query: string) => deviceList(house, query).map((item) => item.id);

    test("matches the name, ignoring case and surrounding spaces", () => {
      expect(found("  smart plug ")).toEqual(["dev_plug"]);
    });

    test("matches the id", () => {
      expect(found("DEV_VALVE")).toEqual(["dev_valve"]);
    });

    test("matches manufacturer and model", () => {
      expect(found("ikea")).toEqual(["dev_plug"]);
      expect(found("hue white")).toEqual(["dev_bulb"]);
    });

    test("matches the integration id", () => {
      expect(found("rachio")).toEqual(["dev_valve"]);
    });

    test("an empty query matches every device", () => {
      expect(found("")).toHaveLength(3);
    });

    test("a query that matches nothing gives nothing", () => {
      expect(found("toaster")).toEqual([]);
    });
  });

  test("sorts by name", () => {
    const house = houseOf({
      devices: [
        device("1", { name: "Charlie" }),
        device("2", { name: "alpha" }),
        device("3", { name: "Bravo" }),
      ],
    });
    expect(deviceList(house).map((item) => item.name)).toEqual(["alpha", "Bravo", "Charlie"]);
  });
});

describe("deviceEntities", () => {
  test("every entity of the device, hidden and disabled ones included, as views", () => {
    const house = houseOf({
      entities: [
        entity("switch.a", { deviceId: "d" }),
        entity("sensor.a", { deviceId: "d", hidden: true }),
        entity("sensor.b", { deviceId: "d", disabled: true }),
        entity("switch.other", { deviceId: "x" }),
        entity("switch.loose"),
      ],
      records: [record("switch.a", { on: true })],
    });
    const views = deviceEntities(house, "d", T0);
    expect(views.map((view) => view.id)).toEqual(["switch.a", "sensor.a", "sensor.b"]);
    expect(views[0]).toMatchObject({ domain: "switch", state: "on", available: true });
  });

  test("a device with no entities, or an unknown one, gives nothing", () => {
    const house = houseOf({ entities: [entity("switch.a", { deviceId: "d" })] });
    expect(deviceEntities(house, "nope", T0)).toEqual([]);
  });
});

describe("areaList", () => {
  test("counts devices by areaId and entities by effectiveAreaId", () => {
    const house = houseOf({
      areas: [
        { id: "kitchen", name: "Kitchen" },
        { id: "bedroom", name: "Bedroom" },
      ],
      devices: [
        { id: "d1", name: "Plug", areaId: "kitchen" },
        { id: "d2", name: "Bulb", areaId: "kitchen" },
        { id: "d3", name: "Lamp", areaId: "bedroom" },
        { id: "d4", name: "Loose" },
      ],
      entities: [
        // Its own area is the bedroom, but its effective one decides.
        entity("switch.a", { areaId: "bedroom", effectiveAreaId: "kitchen" }),
        entity("light.b", { effectiveAreaId: "kitchen", hidden: true }),
        entity("light.c"),
      ],
    });
    expect(areaList(house)).toEqual([
      { id: "bedroom", name: "Bedroom", icon: undefined, devices: 1, entities: 0 },
      { id: "kitchen", name: "Kitchen", icon: undefined, devices: 2, entities: 2 },
    ]);
  });

  test("carries a chosen icon", () => {
    const house = houseOf({ areas: [{ id: "garden", name: "Garden", icon: "sprout" }] });
    expect(areaList(house)[0]).toMatchObject({ id: "garden", icon: "sprout" });
  });

  test("an area with nothing in it is still listed, with zeros", () => {
    const house = houseOf({ areas: [{ id: "attic", name: "Attic" }] });
    expect(areaList(house)).toEqual([{ id: "attic", name: "Attic", devices: 0, entities: 0 }]);
  });

  test("sorts by name", () => {
    const house = houseOf({
      areas: [
        { id: "a", name: "Garage" },
        { id: "b", name: "attic" },
        { id: "c", name: "Bedroom" },
      ],
    });
    expect(areaList(house).map((area) => area.name)).toEqual(["attic", "Bedroom", "Garage"]);
  });

  test("no areas gives an empty list", () => {
    expect(areaList(houseOf({}))).toEqual([]);
  });
});

// ───────── edits ─────────

describe("classOptions", () => {
  test("a binary sensor's classes say the words they bring, after keeping the integration's", () => {
    const options = classOptions("binary_sensor");
    expect(options[0]).toEqual({ value: "", label: "As its integration says" });
    expect(options).toContainEqual({ value: "window", label: "Window · Open / Closed" });
    expect(options).toContainEqual({ value: "leak", label: "Leak · Wet / Dry" });
  });

  test("a sensor's classes are named", () => {
    expect(classOptions("sensor")).toContainEqual({ value: "temperature", label: "Temperature" });
  });

  test("anything else has none, so the form shows no field", () => {
    expect(classOptions("light")).toEqual([]);
    expect(classOptions("cover")).toEqual([]);
  });
});

describe("entityDraft", () => {
  test("copies name, id, area, flags and raw days", () => {
    const row = entity("light.kitchen", {
      name: "Ceiling",
      areaId: "kitchen",
      effectiveAreaId: "kitchen",
      hidden: true,
      disabled: true,
      retention: { raw: 30, hour: 365 },
    });
    expect(entityDraft(row)).toEqual({
      name: "Ceiling",
      id: "light.kitchen",
      areaId: "kitchen",
      hidden: true,
      disabled: true,
      rawDays: "30",
      icon: "",
      deviceClass: "",
    });
  });

  test("icon is the chosen one, or empty for the default", () => {
    expect(entityDraft(entity("light.kitchen", { icon: "fan" })).icon).toBe("fan");
    expect(entityDraft(entity("light.kitchen", { icon: null })).icon).toBe("");
  });

  test("deviceClass is the chosen one, or empty for the integration's", () => {
    const window = entity("binary_sensor.den", { deviceClass: "window" });
    expect(entityDraft(window).deviceClass).toBe("window");
    expect(entityDraft(entity("binary_sensor.den", { deviceClass: null })).deviceClass).toBe("");
  });

  test("areaId is empty when the entity has no area of its own, even if its device has one", () => {
    const row = entity("light.kitchen", { effectiveAreaId: "kitchen" });
    expect(entityDraft(row).areaId).toBe("");
  });

  test("areaId is empty for a null area", () => {
    expect(entityDraft(entity("light.kitchen", { areaId: null })).areaId).toBe("");
  });

  test("hidden and disabled are false unless exactly true", () => {
    const draft = entityDraft(entity("light.kitchen"));
    expect(draft.hidden).toBe(false);
    expect(draft.disabled).toBe(false);
  });

  test("rawDays is empty with no retention", () => {
    expect(entityDraft(entity("light.kitchen")).rawDays).toBe("");
    expect(entityDraft(entity("light.kitchen", { retention: null })).rawDays).toBe("");
  });
});

describe("entityDraftErrors", () => {
  const row = entity("light.kitchen", { name: "Ceiling" });
  const valid = entityDraft(row);
  const errorsOf = (change: Partial<typeof valid>) =>
    entityDraftErrors({ ...valid, ...change }, row);

  test("a valid draft has no errors", () => {
    expect(errorsOf({})).toEqual({});
    expect(errorsOf({ id: "light.a_1_b", rawDays: "7" })).toEqual({});
  });

  describe("name", () => {
    test("empty is an error", () => {
      expect(Object.keys(errorsOf({ name: "" }))).toEqual(["name"]);
    });

    test("only spaces is an error", () => {
      expect(errorsOf({ name: "   " }).name).toBeDefined();
    });
  });

  describe("id", () => {
    test.each([
      ["a different domain", "switch.kitchen"],
      ["uppercase", "light.Kitchen"],
      ["a space", "light.kitchen lamp"],
      ["a dash", "light.kitchen-lamp"],
      ["an empty suffix", "light."],
      ["no domain at all", "kitchen"],
      ["a second dot", "light.kitchen.lamp"],
      ["a leading space", " light.kitchen"],
      ["a trailing newline", "light.kitchen\n"],
    ])("%s is an error", (_, id) => {
      expect(Object.keys(errorsOf({ id }))).toEqual(["id"]);
    });

    test("the error names the entity's own domain", () => {
      expect(errorsOf({ id: "switch.kitchen" }).id).toContain("light.");
    });

    test("the domain comes from the entity, not the draft", () => {
      const sensor = entity("sensor.temp");
      expect(entityDraftErrors({ ...entityDraft(sensor), id: "sensor.temp_2" }, sensor)).toEqual(
        {},
      );
      expect(entityDraftErrors({ ...entityDraft(sensor), id: "light.temp" }, sensor).id).toBe(
        "An id is sensor. then lowercase letters, digits and underscores.",
      );
    });

    test("digits and underscores are fine", () => {
      expect(errorsOf({ id: "light.2nd_floor_1" })).toEqual({});
    });
  });

  describe("rawDays", () => {
    test.each(["", "1", "30", "365"])("%p is fine", (rawDays) => {
      expect(errorsOf({ rawDays })).toEqual({});
    });

    test.each(["0", "1.5", "-3", "abc", " 3", "3 days"])("%p is an error", (rawDays) => {
      expect(Object.keys(errorsOf({ rawDays }))).toEqual(["rawDays"]);
    });
  });

  test("reports every field that is wrong at once", () => {
    expect(Object.keys(errorsOf({ name: "", id: "Bad", rawDays: "0" })).sort()).toEqual([
      "id",
      "name",
      "rawDays",
    ]);
  });
});

describe("entityPatch", () => {
  const row = entity("light.kitchen", {
    name: "Ceiling",
    areaId: "kitchen",
    effectiveAreaId: "kitchen",
    retention: { raw: 30 },
  });
  const draft = entityDraft(row);
  const patchOf = (change: Partial<typeof draft>, from: Row = row) =>
    entityPatch({ ...entityDraft(from), ...change }, from);

  test("a class chosen is sent; going back to the integration's sends null", () => {
    const den = entity("binary_sensor.den");
    expect(patchOf({ deviceClass: "window" }, den)).toEqual({ deviceClass: "window" });
    const chosen = entity("binary_sensor.den", { deviceClass: "window" });
    expect(patchOf({ deviceClass: "" }, chosen)).toEqual({ deviceClass: null });
    expect(patchOf({}, chosen)).toBeUndefined();
  });

  describe("nothing changed", () => {
    test("an untouched draft gives undefined", () => {
      expect(entityPatch(draft, row)).toBeUndefined();
    });

    test("a name that trims to the old one is no change", () => {
      expect(patchOf({ name: "  Ceiling  " })).toBeUndefined();
    });

    test("an entity with no area of its own and no retention, untouched, gives undefined", () => {
      const bare = entity("light.hall", { effectiveAreaId: "hall" });
      expect(patchOf({}, bare)).toBeUndefined();
    });
  });

  test("includes only the fields that changed", () => {
    expect(patchOf({ hidden: true })).toEqual({ hidden: true });
    expect(patchOf({ disabled: true })).toEqual({ disabled: true });
  });

  test("a chosen icon is sent as is; choosing the default again sends null", () => {
    expect(patchOf({ icon: "fan" })).toEqual({ icon: "fan" });
    const iconed = entity("light.hall", { effectiveAreaId: "hall", icon: "fan" });
    expect(patchOf({ icon: "" }, iconed)).toEqual({ icon: null });
    expect(patchOf({ icon: "fan" }, iconed)).toBeUndefined();
  });

  test("a flag turned off is sent as false", () => {
    const flagged = entity("light.kitchen", { hidden: true, disabled: true });
    expect(patchOf({ hidden: false, disabled: false }, flagged)).toEqual({
      hidden: false,
      disabled: false,
    });
  });

  test("a new name is sent trimmed", () => {
    expect(patchOf({ name: "  Pendant " })).toEqual({ name: "Pendant" });
  });

  test("an id change is sent as newId", () => {
    expect(patchOf({ id: "light.pendant" })).toEqual({ newId: "light.pendant" });
  });

  describe("areaId", () => {
    test("is the area's id when set", () => {
      expect(patchOf({ areaId: "bedroom" })).toEqual({ areaId: "bedroom" });
    });

    test("is null when cleared", () => {
      expect(patchOf({ areaId: "" })).toEqual({ areaId: null });
    });

    test("is the id when set on an entity that only followed its device", () => {
      const follows = entity("light.hall", { effectiveAreaId: "hall" });
      expect(patchOf({ areaId: "hall" }, follows)).toEqual({ areaId: "hall" });
    });
  });

  describe("retention", () => {
    test("is { raw: n } when set on an entity with none", () => {
      const bare = entity("light.hall");
      expect(patchOf({ rawDays: "14" }, bare)).toEqual({ retention: { raw: 14 } });
    });

    test("is null when raw days are cleared", () => {
      expect(patchOf({ rawDays: "" })).toEqual({ retention: null });
    });

    test("keeps the rollup tiers when only raw changes", () => {
      const tiered = entity("light.hall", {
        retention: { raw: 30, minute: 7, hour: 90, day: 730 },
      });
      expect(patchOf({ rawDays: "60" }, tiered)).toEqual({
        retention: { raw: 60, minute: 7, hour: 90, day: 730 },
      });
    });

    test("an unchanged raw sends no retention, tiers or not", () => {
      const tiered = entity("light.hall", { retention: { raw: 30, hour: 90 } });
      expect(patchOf({ name: "Hall" }, tiered)).toEqual({ name: "Hall" });
    });
  });

  test("several changes go in one patch", () => {
    expect(
      patchOf({ name: "Pendant", id: "light.pendant", areaId: "", hidden: true, rawDays: "7" }),
    ).toEqual({
      name: "Pendant",
      newId: "light.pendant",
      areaId: null,
      hidden: true,
      retention: { raw: 7 },
    });
  });
});

describe("deviceDraftErrors", () => {
  const row: Row = { id: "thermostat", name: "Thermostat", areaId: "hall", icon: "fan" };
  const errorsOf = (change: Partial<ReturnType<typeof deviceDraft>>) =>
    deviceDraftErrors({ ...deviceDraft(row), ...change });

  test("a valid draft has no errors", () => {
    expect(errorsOf({})).toEqual({});
    expect(errorsOf({ id: "2nd_floor_1" })).toEqual({});
  });

  test("an empty or blank name is an error", () => {
    expect(Object.keys(errorsOf({ name: "" }))).toEqual(["name"]);
    expect(Object.keys(errorsOf({ name: "  " }))).toEqual(["name"]);
  });

  test.each([
    ["uppercase", "Thermostat"],
    ["a dot", "device.thermostat"],
    ["a space", "hall thermostat"],
    ["a dash", "hall-thermostat"],
    ["empty", ""],
  ])("an id with %s is an error", (_, id) => {
    expect(errorsOf({ id })).toEqual({ id: "An id is lowercase letters, digits and underscores." });
  });
});

describe("devicePatch", () => {
  const row: Row = { id: "thermostat", name: "Thermostat", areaId: "hall", icon: "fan" };
  const patchOf = (change: Partial<ReturnType<typeof deviceDraft>>, from: Row = row) =>
    devicePatch({ ...deviceDraft(from), ...change }, from);

  test("an untouched draft, or a name that trims to the old one, gives undefined", () => {
    expect(patchOf({})).toBeUndefined();
    expect(patchOf({ name: " Thermostat " })).toBeUndefined();
    expect(patchOf({}, { id: "lamp", name: "Lamp" })).toBeUndefined();
  });

  test("includes only the fields that changed, with the new id as newId", () => {
    expect(patchOf({ id: "hall_thermostat" })).toEqual({ newId: "hall_thermostat" });
    expect(patchOf({ name: "Nest", areaId: "" })).toEqual({ name: "Nest", areaId: null });
    expect(patchOf({ icon: "" })).toEqual({ icon: null });
    expect(patchOf({ areaId: "kitchen", icon: "home" })).toEqual({
      areaId: "kitchen",
      icon: "home",
    });
  });
});

// ───────── the History page ─────────

describe("HISTORY_RANGES", () => {
  test("offers hour, day, week and month, in that order", () => {
    expect(Object.keys(HISTORY_RANGES)).toEqual(["hour", "day", "week", "month"]);
  });

  test("each range spans its length in milliseconds, a month being 30 days", () => {
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    expect<number>(HISTORY_RANGES.hour.ms).toBe(HOUR);
    expect<number>(HISTORY_RANGES.day.ms).toBe(DAY);
    expect<number>(HISTORY_RANGES.week.ms).toBe(7 * DAY);
    expect<number>(HISTORY_RANGES.month.ms).toBe(30 * DAY);
  });
});

describe("historyKind", () => {
  test.each(["sensor", "climate", "weather"])("%s is drawn as values", (domain) => {
    expect(historyKind(domain)).toBe("values");
  });

  test.each(["light", "switch", "binary_sensor", "lock", "cover", "button", ""])(
    "%p is drawn as states",
    (domain) => {
      expect(historyKind(domain)).toBe("states");
    },
  );
});

describe("historyResolution", () => {
  test("a sensor over a month is asked for by the hour", () => {
    expect(historyResolution("sensor", "month")).toBe("hour");
  });

  test("climate over a month stays raw", () => {
    expect(historyResolution("climate", "month")).toBe("raw");
  });

  test("the weather over a month is asked for by the hour, and raw over anything shorter", () => {
    expect(historyResolution("weather", "month")).toBe("hour");
    for (const range of ["hour", "day", "week"] as const) {
      expect(historyResolution("weather", range)).toBe("raw");
    }
  });

  test("a sensor over anything shorter than a month stays raw", () => {
    for (const range of ["hour", "day", "week"] as const) {
      expect(historyResolution("sensor", range)).toBe("raw");
    }
  });

  test("every other domain stays raw over every range", () => {
    const ranges = Object.keys(HISTORY_RANGES) as HistoryRange[];
    for (const domain of ["light", "switch", "binary_sensor", "lock", "cover", "climate"]) {
      for (const range of ranges) expect(historyResolution(domain, range)).toBe("raw");
    }
  });
});

describe("rawRecords", () => {
  const rollup = (bucketStart: number, extra: Row = {}): Row => ({
    entityId: "sensor.power",
    bucketStart,
    mean: 12.5,
    min: 10,
    max: 15,
    last: { domain: "sensor", value: 14, unit: "W" },
    ...extra,
  });

  test("a raw record passes through as the same object", () => {
    const raw = record("sensor.power", { value: 3, unit: "W" });
    const [out] = rawRecords([raw]);
    expect(out).toBe(raw);
  });

  test("a rollup becomes a record at its bucket start carrying the mean", () => {
    expect(rawRecords([rollup(T0)])).toEqual([
      {
        entityId: "sensor.power",
        updatedAt: T0,
        changedAt: T0,
        available: true,
        state: { domain: "sensor", value: 12.5, unit: "W" },
      },
    ]);
  });

  test("a rollup with no mean keeps its last state", () => {
    const [out] = rawRecords([rollup(T0, { mean: undefined })]);
    expect(out?.state).toEqual({ domain: "sensor", value: 14, unit: "W" });
  });

  test("a mixed list keeps its order", () => {
    const a = record("sensor.power", { value: 1, unit: "W" }, { updatedAt: T0 - MIN });
    const b = rollup(T0);
    const c = record("sensor.power", { value: 2, unit: "W" }, { updatedAt: T0 + 90 * MIN });
    const out = rawRecords([a, b, c]);
    expect(out.map((r) => r.updatedAt)).toEqual([T0 - MIN, T0, T0 + 90 * MIN]);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(c);
  });

  test("an empty list stays empty", () => {
    expect(rawRecords([])).toEqual([]);
  });

  test("a weather rollup's mean is its temperature, not a sensor value", () => {
    const weather = rollup(T0, {
      entityId: "weather.home",
      mean: 10.5,
      last: { domain: "weather", condition: "rain", temperature: 9 },
    });
    const [out] = rawRecords([weather]);
    expect(out?.state).toEqual({ domain: "weather", condition: "rain", temperature: 10.5 });
    expect("value" in ((out?.state ?? {}) as Row)).toBe(false);
  });

  test("weather rollups fed to historyView chart each bucket's mean temperature", () => {
    const HOUR = 60 * MIN;
    const last = { domain: "weather", condition: "clear", temperature: 0 };
    const rollups = [
      rollup(T0, { entityId: "weather.home", mean: 11, last }),
      rollup(T0 + HOUR, { entityId: "weather.home", mean: 13.5, last }),
    ];
    expect(historyView("weather", rawRecords(rollups), T0).series?.[0]?.points).toEqual([
      [T0, 11],
      [T0 + HOUR, 13.5],
    ]);
  });

  test("rollups fed to historyView chart each bucket's mean at its start", () => {
    const HOUR = 60 * MIN;
    const rollups = [
      rollup(T0, { mean: 10 }),
      rollup(T0 + HOUR, { mean: 20 }),
      rollup(T0 + 2 * HOUR, { mean: 30 }),
    ];
    const view = historyView("sensor", rawRecords(rollups), T0);
    expect(view.unit).toBe("W");
    expect(view.series?.[0]?.points).toEqual([
      [T0, 10],
      [T0 + HOUR, 20],
      [T0 + 2 * HOUR, 30],
    ]);
  });
});

describe("historyCsvUrl", () => {
  test("names the entity and the window", () => {
    expect(historyCsvUrl("sensor.power", T0, T0 + MIN)).toBe(
      `/api/history.csv?entityId=sensor.power&from=${T0}&to=${T0 + MIN}`,
    );
  });

  test("URL-encodes the entity id", () => {
    const url = historyCsvUrl("sensor.a b&c=d", 1, 2);
    expect(url).toBe("/api/history.csv?entityId=sensor.a+b%26c%3Dd&from=1&to=2");
    expect(new URLSearchParams(url.split("?")[1]).get("entityId")).toBe("sensor.a b&c=d");
  });
});

describe("historySelection", () => {
  test("gives every e parameter in order", () => {
    expect(historySelection("?e=light.b&e=sensor.a&e=lock.c")).toEqual([
      "light.b",
      "sensor.a",
      "lock.c",
    ]);
  });

  test("drops repeats, keeping the first place", () => {
    expect(historySelection("?e=a.x&e=b.y&e=a.x")).toEqual(["a.x", "b.y"]);
  });

  test("drops empty values", () => {
    expect(historySelection("?e=&e=a.x&e")).toEqual(["a.x"]);
  });

  test("ignores other parameters", () => {
    expect(historySelection("?range=week&e=a.x&f=b.y")).toEqual(["a.x"]);
  });

  test("accepts a search string with or without the leading ?", () => {
    expect(historySelection("e=a.x&e=b.y")).toEqual(["a.x", "b.y"]);
    expect(historySelection("?e=a.x&e=b.y")).toEqual(["a.x", "b.y"]);
  });

  test("an empty search names nothing", () => {
    expect(historySelection("")).toEqual([]);
    expect(historySelection("?")).toEqual([]);
  });
});

describe("historySearch", () => {
  test("is empty for no entities and the default range", () => {
    expect(historySearch([], "day")).toBe("");
  });

  test("repeats e once per entity, in order", () => {
    expect(historySearch(["light.b", "sensor.a"], "day")).toBe("?e=light.b&e=sensor.a");
  });

  test("names the range only when it is not day", () => {
    expect(historySearch(["a.x"], "week")).toBe("?e=a.x&range=week");
    expect(historySearch([], "month")).toBe("?range=month");
    expect(historySearch(["a.x"], "day")).not.toContain("range");
  });

  describe("round-trips through historySelection and historyRangeOf", () => {
    const ids = ["sensor.living_room_temp", "light.kitchen", "binary_sensor.front_door"];
    for (const range of Object.keys(HISTORY_RANGES) as HistoryRange[]) {
      test(range, () => {
        const search = historySearch(ids, range);
        expect(historySelection(search)).toEqual(ids);
        expect(historyRangeOf(search)).toBe(range);
      });
    }

    test("with no entities", () => {
      const search = historySearch([], "hour");
      expect(historySelection(search)).toEqual([]);
      expect(historyRangeOf(search)).toBe("hour");
    });
  });
});

describe("historyRangeOf", () => {
  test.each(["hour", "day", "week", "month"])("reads range=%s", (range) => {
    expect(historyRangeOf(`?range=${range}`)).toBe(range as HistoryRange);
  });

  test("reads the range without a leading ? and among other parameters", () => {
    expect(historyRangeOf("e=a.x&range=week")).toBe("week");
  });

  test("is day when the range is absent", () => {
    expect(historyRangeOf("")).toBe("day");
    expect(historyRangeOf("?e=a.x")).toBe("day");
  });

  test("is day when the range is empty", () => {
    expect(historyRangeOf("?range=")).toBe("day");
  });

  test("is day when the range is unknown", () => {
    expect(historyRangeOf("?range=year")).toBe("day");
    expect(historyRangeOf("?range=Week")).toBe("day");
  });

  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "is day for %s, a name on Object's prototype",
    (name) => {
      expect(historyRangeOf(`?range=${name}`)).toBe("day");
    },
  );
});

test("hasDeviceSettings: a loaded device whose integration keeps settings", () => {
  const integrations = [
    { integrationId: "zwave-js.main", deviceSettings: true },
    { integrationId: "hue.main", deviceSettings: false },
  ];
  const house = { integrations };
  expect(hasDeviceSettings(house, { integrationId: "zwave-js.main" })).toBe(true);
  expect(hasDeviceSettings(house, { integrationId: "hue.main" })).toBe(false);
  expect(hasDeviceSettings(house, { integrationId: "gone.main" })).toBe(false);
  expect(hasDeviceSettings(house, { integrationId: "zwave-js.main", orphaned: true })).toBe(false);
  expect(hasDeviceSettings(house, undefined)).toBe(false);
});
