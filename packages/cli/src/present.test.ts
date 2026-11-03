import { expect, test } from "bun:test";
import { setUnits } from "@casita/client";
import { ago, carLines, carsFrom, clock, formatNumber, present, since } from "./present.ts";
import { bar, fit, setColor, strip, truncate, width } from "./style.ts";

const NOW = Date.UTC(2026, 9, 4, 2, 42); // 7:42 pm Pacific
const record = (state: object, extra: object = {}) => ({
  state,
  available: true,
  changedAt: NOW - 240_000,
  ...extra,
});

test.each([
  [record({ domain: "light", on: true, brightness: 0.4 }), "On · 40%", "on", 0.4],
  [record({ domain: "light", on: true }), "On", "on", undefined],
  [record({ domain: "light", on: false, brightness: 0.4 }), "Off", "muted", undefined],
  [record({ domain: "switch", on: true }), "On", "on", undefined],
  [record({ domain: "cover", motion: "stopped", position: 0 }), "Closed", "muted", undefined],
  [record({ domain: "cover", motion: "stopped", position: 1 }), "Open", "on", undefined],
  [record({ domain: "cover", motion: "stopped", position: 0.35 }), "35% open", "on", 0.35],
  [record({ domain: "cover", motion: "opening", position: 0.2 }), "Opening…", "pending", undefined],
  [record({ domain: "lock", locked: true }), "Locked", "good", undefined],
  [record({ domain: "lock", locked: false }), "Unlocked", "plain", undefined],
  [record({ domain: "lock", locked: true, jammed: true }), "Jammed", "warn", undefined],
  [record({ domain: "sensor", value: 1140, unit: "ppm" }), "1,140 ppm", "plain", undefined],
  [record({ domain: "sensor", value: 21.46, unit: "°C" }), "21.5 °C", "plain", undefined],
  [record({ domain: "sensor", value: null, unit: "kW" }), "Unknown", "muted", undefined],
  [record({ domain: "sensor", value: "offline" }), "offline · 4 min", "plain", undefined],
  [
    record({ domain: "binary_sensor", on: false, deviceClass: "motion" }),
    "Clear · 4 min",
    "muted",
    undefined,
  ],
  [
    record({ domain: "binary_sensor", on: true, deviceClass: "door" }),
    "Open · 4 min",
    "on",
    undefined,
  ],
  [
    record({ domain: "binary_sensor", on: true, deviceClass: "leak" }),
    "Wet · 4 min",
    "warn",
    undefined,
  ],
  [
    record({ domain: "climate", mode: "heat", currentTemp: 21.5, targetTemp: 21 }),
    "21.5°C · heat → 21°",
    "on",
    undefined,
  ],
  [record({ domain: "button" }), "Ready", "muted", undefined],
  [
    record({ domain: "button", pressedAt: NOW - 600_000 }),
    "Pressed 10 min ago",
    "plain",
    undefined,
  ],
  [
    record({ domain: "cover", motion: "stopped", position: 0 }, { available: false }),
    "Unavailable ╱╱ was Closed",
    "muted",
    undefined,
  ],
  [undefined, "No state yet", "muted", undefined],
])("present %j", (input, text, tone, level) => {
  expect(present(input, NOW)).toEqual({ text, tone, level } as never);
});

test("since reads as minutes, hours, then a clock time", () => {
  expect(since(NOW - 20_000, NOW)).toBe("just now");
  expect(since(NOW - 12 * 60_000, NOW)).toBe("12 min");
  expect(since(NOW - 3 * 3_600_000, NOW)).toBe("3 h");
  expect(since(NOW - 9 * 3_600_000, NOW)).toMatch(/^\d{1,2}:\d\d [ap]m$/);
  expect(formatNumber(34569.62)).toBe("34,569.6");
});

test("bars fill in proportion, show at least one cell for any level, and mark a limit", () => {
  setColor(false);
  expect(bar(0.4)).toBe("████░░░░░░");
  expect(bar(0)).toBe("░░░░░░░░░░");
  expect(bar(0.01)).toBe("█░░░░░░░░░");
  expect(bar(1.7)).toBe("██████████");
  expect(bar(0.5, 10, (t) => t, 0.8)).toBe("█████░░│░░");
  expect(bar(0.9, 10, (t) => t, 0.8)).toBe("█████████░"); // a tick inside the filled part is not drawn
});

test("width, truncate, and fit ignore color codes", () => {
  setColor(true);
  const colored = `\x1b[38;5;215mOn · 40%\x1b[0m`;
  expect(width(colored)).toBe(8);
  expect(strip(truncate(colored, 5))).toBe("On ·…");
  expect(width(fit(colored, 12))).toBe(12);
  expect(width(fit(colored, 4))).toBe(4);
  expect(truncate("short", 10)).toBe("short");
  setColor(false);
});

test("cars are read from the integrations that provide them", () => {
  const devices = [
    { id: "d1", name: "Terry", model: "Model Y P74D", integrationId: "teslamate.main" },
    { id: "d2", name: "Plug", integrationId: "mqtt.main" },
  ];
  const entity = (suffix: string, domain = "sensor") => ({
    id: `${domain}.terry_${suffix}`,
    uniqueId: `teslamate-1-${suffix}`,
    deviceId: "d1",
    domain,
  });
  const entities = [
    entity("battery_level"),
    entity("usable_battery_level"),
    entity("rated_battery_range_km"),
    entity("charge_limit_soc"),
    entity("charger_power"),
    entity("time_to_full_charge"),
    entity("charge_energy_added"),
    entity("state"),
    entity("plugged_in", "binary_sensor"),
    { id: "switch.plug", uniqueId: "x-battery_level", deviceId: "d2", domain: "switch" },
  ];
  const values: Record<string, unknown> = {
    battery_level: 68,
    usable_battery_level: 67,
    rated_battery_range_km: 313.2,
    charge_limit_soc: 80,
    charger_power: 7.2,
    time_to_full_charge: 1.5,
    charge_energy_added: 11.4,
    state: "charging",
  };
  const states = new Map<string, Record<string, unknown>>(
    entities.map((e) => {
      const key = e.uniqueId.replace("teslamate-1-", "");
      const state = e.domain === "binary_sensor" ? { on: true } : { value: values[key] };
      return [e.id, { state }];
    }),
  );
  const cars = carsFrom(entities, devices, states);
  expect(cars).toEqual([
    {
      name: "Terry",
      model: "Model Y P74D",
      battery: 68, // not the "usable" one, whose key merely ends the same way
      range: 313.2,
      rangeUnit: "km",
      limit: 80,
      charging: true,
      pluggedIn: true,
      powerKw: 7.2,
      hoursToFull: 1.5,
      energyAdded: 11.4,
      state: "charging",
      place: undefined,
    },
  ]);

  setColor(false);
  const [gauge, doing] = carLines(cars[0] ?? ({} as never), 10, NOW);
  expect(gauge).toBe("[███████│░░] 68%  313 km · limit 80%");
  expect(doing).toMatch(
    /^Charging · 7.2 kW · reaches 80% at about \d{1,2}:\d\d [ap]m · \+11.4 kWh$/,
  );

  const parked = carLines(
    {
      ...(cars[0] ?? ({} as never)),
      charging: false,
      state: "asleep",
      pluggedIn: false,
      place: "Home",
    },
    10,
    NOW,
  );
  expect(parked[1]).toBe("Asleep · not plugged in · at Home");
});

// ───────── since: the boundaries ─────────

test.each([
  [59, "just now"],
  [60, "1 min"],
  [59 * 60, "59 min"],
  [60 * 60, "1 h"],
  [5 * 3600 + 59 * 60, "5 h"],
  [6 * 3600, "8:42 pm"], // a clock time from six hours back
])("since %d seconds ago reads %s", (seconds, expected) => {
  expect(since(NOW - seconds * 1000, NOW)).toBe(expected);
});

test("since reads a timestamp in the future (clock skew) as just now", () => {
  expect(since(NOW + 1_000, NOW)).toBe("just now");
  expect(since(NOW + 3_600_000, NOW)).toBe("just now");
});

test("clock is a lower-case 12-hour time with an ordinary space", () => {
  expect(clock(NOW)).toBe("2:42 am");
  expect(clock(Date.UTC(2026, 0, 1, 12, 5))).toBe("12:05 pm");
  expect(clock(NOW)).not.toMatch(/[  ]/);
});

test("formatNumber groups thousands and keeps at most one decimal", () => {
  expect(formatNumber(0)).toBe("0");
  expect(formatNumber(-5.25)).toBe("-5.3");
  expect(formatNumber(1_000_000)).toBe("1,000,000");
  expect(formatNumber(123_456_789.99)).toBe("123,456,790");
  expect(formatNumber(0.05)).toBe("0.1");
});

test("formatNumber never shows a negative zero", () => {
  // A temperature sensor at -0.04 °C reads "-0 °C" today.
  expect(formatNumber(-0)).toBe("0");
  expect(formatNumber(-0.04)).toBe("0");
  expect(present(record({ domain: "sensor", value: -0.04, unit: "°C" }), NOW).text).toBe("0 °C");
});

// ───────── present: buttons at each age ─────────

test.each([
  [59, "Pressed just now"],
  [60, "Pressed 1 min ago"],
  [59 * 60, "Pressed 59 min ago"],
  [60 * 60, "Pressed 1 h ago"],
  [5 * 3600 + 59 * 60, "Pressed 5 h ago"],
  [-120, "Pressed just now"],
])("a button pressed %d seconds ago reads %s", (seconds, expected) => {
  expect(present(record({ domain: "button", pressedAt: NOW - seconds * 1000 }), NOW)).toEqual({
    text: expected,
    tone: "plain",
  });
});

test("a button pressed six or more hours ago reads 'Pressed at <time>', not '<time> ago'", () => {
  // Today: "Pressed 8:42 pm ago".
  const shown = present(record({ domain: "button", pressedAt: NOW - 6 * 3_600_000 }), NOW);
  expect(shown.text).toBe("Pressed at 8:42 pm");
});

// ───────── present: other edges ─────────

test("a binary sensor without a changedAt reads without a time", () => {
  const motion = { state: { domain: "binary_sensor", on: true, deviceClass: "motion" } };
  expect(present(motion, NOW)).toEqual({ text: "Motion", tone: "on" });
  const smoke = { state: { domain: "binary_sensor", on: true, deviceClass: "smoke" } };
  expect(present(smoke, NOW)).toEqual({ text: "Smoke", tone: "warn" });
  const unknown = { state: { domain: "binary_sensor", on: false, deviceClass: "vibration" } };
  expect(present(unknown, NOW)).toEqual({ text: "Off", tone: "muted" });
});

test("a cover just outside 0..1 reads as closed or open", () => {
  expect(present(record({ domain: "cover", position: -0.001 }), NOW)).toEqual({
    text: "Closed",
    tone: "muted",
  });
  expect(present(record({ domain: "cover", position: 1.001 }), NOW)).toEqual({
    text: "Open",
    tone: "on",
  });
  expect(present(record({ domain: "cover" }), NOW)).toEqual({ text: "Stopped", tone: "plain" });
  expect(present(record({ domain: "cover", motion: "closing", position: 0.5 }), NOW).text).toBe(
    "Closing…",
  );
});

test("a level that is neither off nor full never rounds to 0% or 100%", () => {
  // Today a cover at 0.4 % open reads "0% open" (and at 99.6 % "100% open", beside a separate
  // "Open" state), and a light at 0.4 % brightness reads "On · 0%".
  expect(present(record({ domain: "cover", position: 0.004 }), NOW).text).toBe("1% open");
  expect(present(record({ domain: "cover", position: 0.996 }), NOW).text).toBe("99% open");
  expect(present(record({ domain: "light", on: true, brightness: 0.004 }), NOW).text).toBe(
    "On · 1%",
  );
});

test("sensor values: zero, negative, very large, and word values", () => {
  const sensor = (value: unknown, unit?: string) =>
    present(record({ domain: "sensor", value, unit }), NOW).text;
  expect(sensor(0, "W")).toBe("0 W");
  expect(sensor(-5.25, "°C")).toBe("-5.3 °C");
  expect(sensor(1e21)).toBe("1,000,000,000,000,000,000,000");
  expect(sensor("driving")).toBe("driving · 4 min");
  expect(sensor(undefined, "W")).toBe("Unknown");
});

test("an empty-string sensor value reads as Unknown, not as a blank or a bare unit", () => {
  // Today: "" and " W".
  expect(present(record({ domain: "sensor", value: "" }), NOW)).toEqual({
    text: "Unknown",
    tone: "muted",
  });
  expect(present(record({ domain: "sensor", value: "", unit: "W" }), NOW).text).toBe("Unknown");
});

test("a climate with no temperatures reads as just its mode", () => {
  expect(present(record({ domain: "climate", mode: "cool" }), NOW)).toEqual({
    text: "cool",
    tone: "on",
  });
  expect(present(record({ domain: "climate", mode: "off", targetTemp: 20 }), NOW)).toEqual({
    text: "off → 20°",
    tone: "muted",
  });
  expect(present(record({ domain: "climate", mode: "heat", currentTemp: 19 }), NOW).text).toBe(
    "19°C · heat",
  );
});

test("an unavailable entity says what it was, in muted tone, dropping its level", () => {
  const shown = present(
    record({ domain: "light", on: true, brightness: 0.4 }, { available: false }),
    NOW,
  );
  expect(shown).toEqual({ text: "Unavailable ╱╱ was On · 40%", tone: "muted" });
});

test("an unknown domain shows its raw state", () => {
  expect(present(record({ domain: "vacuum", docked: true }), NOW).text).toBe(
    '{"domain":"vacuum","docked":true}',
  );
});

// ───────── cars from the tesla (Fleet API) integration ─────────

type R = Record<string, unknown>;
const teslaCar = (deviceId: string, readings: Record<string, R>, vin = `VIN${deviceId}`) => ({
  entities: Object.keys(readings).map((key) => ({
    id: `x.${deviceId}_${key}`,
    uniqueId: `${vin}-${key}`,
    deviceId,
  })),
  states: Object.entries(readings).map(
    ([key, state]) => [`x.${deviceId}_${key}`, { state, available: true }] as [string, R],
  ),
});

test("a tesla car is read from its suffixed readings, with miles and minutes to full", () => {
  const car = teslaCar("c1", {
    battery: { domain: "sensor", value: 55 },
    range: { domain: "sensor", value: 201.6 },
    "charge-limit": { domain: "sensor", value: 90 },
    "charger-power": { domain: "sensor", value: 11 },
    "time-to-full": { domain: "sensor", value: 90 },
    "plugged-in": { domain: "binary_sensor", on: true },
    charging: { domain: "binary_sensor", on: true },
    "inside-temp": { domain: "sensor", value: 21 },
    "outside-temp": { domain: "sensor", value: 9 },
    odometer: { domain: "sensor", value: 12_000 },
    awake: { domain: "binary_sensor", on: true },
    locked: { domain: "lock", locked: true },
  });
  const devices = [{ id: "c1", name: "Sparky", model: "model3", integrationId: "tesla.main" }];
  expect(carsFrom(car.entities, devices, new Map(car.states))).toEqual([
    {
      name: "Sparky",
      model: "model3",
      battery: 55,
      range: 201.6,
      rangeUnit: "mi",
      limit: 90,
      charging: true,
      pluggedIn: true,
      powerKw: 11, // the charger's power, not anything else ending in "power"
      hoursToFull: 1.5,
      energyAdded: undefined,
      state: undefined,
      place: undefined,
    },
  ]);
});

test("a tesla car that is plugged in but not charging", () => {
  const car = teslaCar("c1", {
    charging: { domain: "binary_sensor", on: false },
    "plugged-in": { domain: "binary_sensor", on: true },
    "time-to-full": { domain: "sensor", value: 0 },
  });
  const devices = [{ id: "c1", name: "Sparky", integrationId: "tesla.main" }];
  const [only] = carsFrom(car.entities, devices, new Map(car.states));
  expect(only?.charging).toBe(false);
  expect(only?.pluggedIn).toBe(true);
  expect(only?.hoursToFull).toBe(0);
});

test("readings without a state yet are left out rather than guessed", () => {
  const car = teslaCar("c1", { battery: { domain: "sensor", value: 55 } });
  car.entities.push({ id: "x.c1_range", uniqueId: "VINc1-range", deviceId: "c1" });
  const devices = [{ id: "c1", name: "Sparky", integrationId: "tesla.main" }];
  const [only] = carsFrom(car.entities, devices, new Map(car.states));
  expect(only?.battery).toBe(55);
  expect(only?.range).toBeUndefined();
});

test("a car device with no entities still appears, with nothing known", () => {
  const devices = [{ id: "c1", name: "New car", integrationId: "tesla.main" }];
  expect(carsFrom([], devices, new Map())).toEqual([
    {
      name: "New car",
      model: undefined,
      battery: undefined,
      range: undefined,
      rangeUnit: "mi",
      limit: undefined,
      charging: false,
      pluggedIn: undefined,
      powerKw: undefined,
      hoursToFull: undefined,
      energyAdded: undefined,
      state: undefined,
      place: undefined,
    },
  ]);
});

test("two cars keep their own readings, in device order", () => {
  const a = teslaCar("a", { battery: { domain: "sensor", value: 20 } });
  const b = teslaCar("b", { battery: { domain: "sensor", value: 90 } });
  const devices = [
    { id: "a", name: "Alpha", integrationId: "tesla.main" },
    { id: "b", name: "Bravo", integrationId: "tesla.main" },
  ];
  const cars = carsFrom(
    [...b.entities, ...a.entities],
    devices,
    new Map([...a.states, ...b.states]),
  );
  expect(cars.map((car) => [car.name, car.battery])).toEqual([
    ["Alpha", 20],
    ["Bravo", 90],
  ]);
});

test("teslamate's geofence 'away' is no place, and its own names come through", () => {
  const devices = [{ id: "d1", name: "Terry", integrationId: "teslamate.main" }];
  const entities = [{ id: "sensor.geo", uniqueId: "teslamate-1-geofence", deviceId: "d1" }];
  const at = (value: string) =>
    carsFrom(entities, devices, new Map([["sensor.geo", { state: { value } }]]))[0]?.place;
  expect(at("away")).toBeUndefined();
  expect(at("Work")).toBe("Work");
});

test("devices from other integrations are not cars", () => {
  const devices = [
    { id: "p", name: "Plug", integrationId: "mqtt.main" },
    { id: "q", name: "Nameless" },
  ];
  expect(carsFrom([], devices, new Map())).toEqual([]);
});

test("a reading is matched by its whole key, not by any key it happens to end with", () => {
  // The tesla keys are matched with endsWith("-battery"), so a hypothetical "climate-battery"
  // or "not-charging" reading on the same car overwrites the real one, whichever comes last.
  const car = teslaCar("c1", {
    battery: { domain: "sensor", value: 55 },
    "climate-battery": { domain: "sensor", value: 12 },
    charging: { domain: "binary_sensor", on: true },
    "not-charging": { domain: "binary_sensor", on: false },
  });
  const devices = [{ id: "c1", name: "Sparky", integrationId: "tesla.main" }];
  const [only] = carsFrom(car.entities, devices, new Map(car.states));
  expect(only?.battery).toBe(55);
  expect(only?.charging).toBe(true);
});

// ───────── carLines ─────────

const car = (extra: object = {}) => ({ name: "T", rangeUnit: "mi", charging: false, ...extra });

test("a car with no battery reading shows an empty gauge and a question mark", () => {
  setColor(false);
  const [gauge, doing] = carLines(car(), 10, NOW);
  expect(gauge).toStartWith("[░░░░░░░░░░] ?");
  expect(doing).toBe("Parked");
});

test("a car with no limit has no tick and no limit text", () => {
  setColor(false);
  const [gauge] = carLines(car({ battery: 50, range: 150.4 }), 10, NOW);
  // The fixture's range is in miles and the default unit system is metric.
  expect(gauge).toBe("[█████░░░░░] 50%  242 km");
  expect(gauge).not.toContain("│");
});

test("charging with no time estimate says so without a finish time", () => {
  setColor(false);
  expect(carLines(car({ battery: 50, charging: true, limit: 80 }), 10, NOW)[1]).toBe("Charging");
  expect(
    carLines(
      car({ battery: 50, charging: true, limit: 80, hoursToFull: 0, powerKw: 0 }),
      10,
      NOW,
    )[1],
  ).toBe("Charging");
  // A time estimate without a limit has nothing to reach.
  expect(carLines(car({ battery: 50, charging: true, hoursToFull: 2 }), 10, NOW)[1]).toBe(
    "Charging",
  );
});

test("charging with an estimate names the finish time", () => {
  setColor(false);
  const [, doing] = carLines(
    car({ battery: 50, charging: true, limit: 80, hoursToFull: 1.5, powerKw: 11 }),
    10,
    NOW,
  );
  expect(doing).toBe("Charging · 11 kW · reaches 80% at about 4:12 am");
});

test.each([
  ["driving", "Driving"],
  ["updating", "Updating"],
  ["online", "Online"],
  ["asleep", "Asleep"],
  ["offline", "Offline"],
])("a car whose state is %s reads %s", (state, expected) => {
  setColor(false);
  expect(carLines(car({ battery: 40, state }), 10, NOW)[1]).toBe(expected);
});

test("a car's plug and place follow what it is doing", () => {
  setColor(false);
  expect(carLines(car({ state: "online", pluggedIn: true, place: "Home" }), 10, NOW)[1]).toBe(
    "Online · plugged in · at Home",
  );
});

test("a full car at its limit fills the gauge", () => {
  setColor(false);
  expect(carLines(car({ battery: 100, limit: 100 }), 10, NOW)[0]).toBe(
    "[██████████] 100%  limit 100%",
  );
});

// ───────── ago: the boundaries ─────────

const MINUTE = 60;
const HOUR_S = 60 * MINUTE;
test.each([
  [0, "just now"],
  [59, "just now"],
  [59.999, "just now"],
  [60, "1 min ago"],
  [12 * MINUTE, "12 min ago"],
  [59 * MINUTE + 59, "59 min ago"],
  [60 * MINUTE, "1 h ago"],
  [3 * HOUR_S, "3 h ago"],
  [23 * HOUR_S + 59 * MINUTE, "23 h ago"],
  [24 * HOUR_S, "yesterday"],
  [47 * HOUR_S + 59 * MINUTE, "yesterday"],
  [48 * HOUR_S, "2 days ago"],
  [4 * 24 * HOUR_S, "4 days ago"],
  [400 * 24 * HOUR_S, "400 days ago"],
])("ago %d seconds back reads %s", (seconds, expected) => {
  expect(ago(NOW - seconds * 1000, NOW)).toBe(expected);
});

test("ago reads a timestamp in the future (clock skew) as just now", () => {
  expect(ago(NOW + 1_000, NOW)).toBe("just now");
  expect(ago(NOW + 3 * 24 * 3_600_000, NOW)).toBe("just now");
});

// ───────── the unit system ─────────

const imperial = (fn: () => void) => {
  setUnits("imperial");
  try {
    fn();
  } finally {
    setUnits("metric");
  }
};
const sensorText = (value: unknown, unit?: string) =>
  present(record({ domain: "sensor", value, unit }), NOW).text;

test("in imperial a Celsius sensor reads in Fahrenheit and a distance in miles", () => {
  imperial(() => {
    expect(sensorText(21.5, "°C")).toBe("70.7 °F");
    expect(sensorText(0, "°C")).toBe("32 °F");
    expect(sensorText(-40, "°C")).toBe("-40 °F");
    expect(sensorText(10, "km")).toBe("6.2 mi");
    expect(sensorText(1013, "kPa")).toBe("146.9 psi");
  });
});

test("in metric a Fahrenheit sensor reads in Celsius", () => {
  expect(sensorText(70, "°F")).toBe("21.1 °C");
  expect(sensorText(-40, "°F")).toBe("-40 °C");
});

test("a reading that converts to a sliver below zero never shows as -0", () => {
  imperial(() => {
    // -17.78 °C is -0.004 °F.
    expect(sensorText(-17.78, "°C")).toBe("0 °F");
  });
  expect(sensorText(31.97, "°F")).toBe("0 °C");
});

test("a large converted reading keeps its thousands separators", () => {
  imperial(() => {
    expect(sensorText(5000, "km")).toBe("3,106.9 mi");
  });
  expect(sensorText(2000, "mi")).toBe("3,218.7 km");
});

test("in imperial, blank and word sensor values with a convertible unit are left alone", () => {
  imperial(() => {
    expect(sensorText(null, "°C")).toBe("Unknown");
    expect(sensorText("", "°C")).toBe("Unknown");
    expect(sensorText(undefined, "°C")).toBe("Unknown");
    // A number sent as a string is not converted, and keeps the unit it came with.
    expect(sensorText("21", "°C")).toBe("21 °C · 4 min");
  });
});

test("in imperial, a sensor without a unit or with an unconvertible one reads as before", () => {
  imperial(() => {
    expect(sensorText(1140)).toBe("1,140");
    expect(sensorText(42, "%")).toBe("42 %");
    expect(sensorText(3, "M")).toBe("3 M");
    expect(sensorText(3, "constructor")).toBe("3 constructor");
  });
});

test("in imperial a thermostat reads its temperatures in Fahrenheit", () => {
  imperial(() => {
    expect(
      present(record({ domain: "climate", mode: "heat", currentTemp: 21.5, targetTemp: 21 }), NOW),
    ).toEqual({ text: "70.7°F · heat → 69.8°", tone: "on" });
    expect(present(record({ domain: "climate", mode: "cool" }), NOW).text).toBe("cool");
    expect(present(record({ domain: "climate", mode: "off", targetTemp: 20 }), NOW).text).toBe(
      "off → 68°",
    );
    expect(present(record({ domain: "climate", mode: "heat", currentTemp: 38 }), NOW).text).toBe(
      "100.4°F · heat",
    );
  });
});

test("an unavailable sensor in imperial says what it was in Fahrenheit", () => {
  imperial(() => {
    expect(
      present(record({ domain: "sensor", value: 20, unit: "°C" }, { available: false }), NOW).text,
    ).toBe("Unavailable ╱╱ was 68 °F");
  });
});

test("a car's range is shown in the system's distance unit, whichever unit it reports in", () => {
  setColor(false);
  // Tesla Fleet reports miles; TeslaMate reports kilometres.
  expect(carLines(car({ range: 150, rangeUnit: "mi" }), 10, NOW)[0]).toEndWith("241 km");
  expect(carLines(car({ range: 300, rangeUnit: "km" }), 10, NOW)[0]).toEndWith("300 km");
  imperial(() => {
    expect(carLines(car({ range: 150, rangeUnit: "mi" }), 10, NOW)[0]).toEndWith("150 mi");
    expect(carLines(car({ range: 300, rangeUnit: "km" }), 10, NOW)[0]).toEndWith("186 mi");
    expect(carLines(car({ range: 1000, rangeUnit: "km", limit: 80 }), 10, NOW)[0]).toEndWith(
      "621 mi · limit 80%",
    );
  });
  expect(carLines(car({ range: 1000, rangeUnit: "mi" }), 10, NOW)[0]).toEndWith("1,609 km");
});

test("a car with no range reading shows no range in either system", () => {
  setColor(false);
  expect(carLines(car({ battery: 50 }), 10, NOW)[0]).toBe("[█████░░░░░] 50%  ");
  imperial(() => {
    expect(carLines(car({ battery: 50 }), 10, NOW)[0]).toBe("[█████░░░░░] 50%  ");
  });
});
