import { expect, test } from "bun:test";
import { setUnits } from "@casita/client";
import {
  duration,
  parseFlags,
  pretendValues,
  RUN_COLUMNS,
  runRow,
  settingArgument,
  summarize,
  table,
} from "./format.ts";

test("table aligns columns and handles empty input", () => {
  expect(
    table(
      [
        { id: "light.a", state: "on" },
        { id: "sensor.long_name", state: undefined },
      ],
      ["id", "state"],
    ),
  ).toBe("ID                STATE\nlight.a           on\nsensor.long_name");
  expect(table([], ["id"])).toBe("(none)");
});

test.each([
  [{ available: true, state: { domain: "light", on: true, brightness: 0.5 } }, "on 50%"],
  [{ available: true, state: { domain: "light", on: false, brightness: 0.5 } }, "off"],
  [{ available: false, state: { domain: "light", on: true } }, "unavailable"],
  [{ available: true, state: { domain: "sensor", value: 21.5, unit: "°C" } }, "21.5 °C"],
  [{ available: true, state: { domain: "sensor", value: null } }, "unknown"],
  [
    {
      available: true,
      state: { domain: "climate", mode: "heat", currentTemp: 20, targetTemp: 22 },
    },
    "heat 20 → 22",
  ],
  [{ available: true, state: { domain: "cover", motion: "stopped", position: 1 } }, "stopped 100%"],
  [{ available: true, state: { domain: "lock", locked: true } }, "locked"],
  [{ available: true, state: { domain: "lock", locked: false, jammed: true } }, "jammed"],
  [{ available: true, state: { domain: "button" } }, "never pressed"],
  [
    { available: true, state: { domain: "weather", condition: "overcast", temperature: 11.8 } },
    "overcast 11.8 °C",
  ],
  [{ available: true, state: { domain: "weather", condition: "clear-night" } }, "clear-night"],
  [{ available: true, state: { domain: "weather", condition: "rain", temperature: null } }, "rain"],
  [{ available: false, state: { domain: "weather", condition: "rain" } }, "unavailable"],
  [undefined, "unknown"],
])("summarize %j", (record, expected) => {
  expect(summarize(record)).toBe(expected);
});

test("parseFlags maps --key value pairs, parsing JSON values", () => {
  expect(
    parseFlags(["--brightness", "0.5", "--rgb", "[255,0,0]", "--mode", "heat", "--confirm"]),
  ).toEqual({
    brightness: 0.5,
    rgb: [255, 0, 0],
    mode: "heat",
    confirm: true,
  });
  expect(() => parseFlags(["oops"])).toThrow('Expected --key value, got "oops"');
});

test("duration picks sensible units", () => {
  expect([5_000, 125_000, 3_720_000, 90_000_000].map(duration)).toEqual([
    "5s",
    "2m 5s",
    "1h 2m",
    "1d 1h",
  ]);
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
const sensor = (value: unknown, unit?: string) =>
  summarize({ available: true, state: { domain: "sensor", value, unit } });
const climate = (state: object) =>
  summarize({ available: true, state: { domain: "climate", mode: "heat", ...state } });

test("in imperial, sensor readings are converted and rounded to two decimals", () => {
  imperial(() => {
    expect(sensor(21.5, "°C")).toBe("70.7 °F");
    // 21.4 °C is 70.52000000000001 °F before rounding.
    expect(sensor(21.4, "°C")).toBe("70.52 °F");
    expect(sensor(-40, "°C")).toBe("-40 °F");
    expect(sensor(100, "km")).toBe("62.14 mi");
  });
});

test("in metric, a Fahrenheit sensor is converted to Celsius", () => {
  expect(sensor(70, "°F")).toBe("21.11 °C");
  expect(sensor(21.5, "°C")).toBe("21.5 °C");
});

test("a converted reading that rounds to zero does not read -0", () => {
  imperial(() => {
    expect(sensor(-17.78, "°C")).toBe("0 °F");
  });
  expect(sensor(31.999, "°F")).toBe("0 °C");
});

test("in imperial, word, blank, and unitless sensor values read as they did", () => {
  imperial(() => {
    expect(sensor("offline", "°C")).toBe("offline °C");
    expect(sensor(null, "°C")).toBe("unknown °C");
    expect(sensor(1140)).toBe("1140");
    expect(sensor(42, "%")).toBe("42 %");
    expect(sensor(3, "toString")).toBe("3 toString");
  });
});

test("in imperial, a thermostat's current and target temperatures are in Fahrenheit", () => {
  imperial(() => {
    expect(climate({ currentTemp: 20, targetTemp: 22 })).toBe("heat 68 → 71.6");
    expect(climate({ currentTemp: 21.4 })).toBe("heat 70.52");
    expect(climate({ targetTemp: -40 })).toBe("heat → -40");
  });
});

test("in imperial, the weather's temperature is in Fahrenheit, rounded to two decimals", () => {
  const weather = (temperature: number) =>
    summarize({ available: true, state: { domain: "weather", condition: "snow", temperature } });
  imperial(() => {
    expect(weather(-40)).toBe("snow -40 °F");
    // 21.4 °C is 70.52000000000001 °F before rounding.
    expect(weather(21.4)).toBe("snow 70.52 °F");
  });
  expect(weather(-0.001)).toBe("snow 0 °C");
});

test("a thermostat with missing or null temperatures reads as its mode alone", () => {
  expect(climate({})).toBe("heat");
  expect(climate({ currentTemp: null, targetTemp: null })).toBe("heat");
  imperial(() => {
    expect(climate({ currentTemp: null, targetTemp: 20 })).toBe("heat → 68");
  });
});

test("settingArgument reads a value by its setting's type", () => {
  expect(settingArgument({ type: "string" }, "007")).toBe("007");
  expect(settingArgument({ type: "boolean" }, "On")).toBe(true);
  expect(settingArgument({ type: "boolean" }, "off")).toBe(false);
  expect(settingArgument({ type: "boolean" }, "maybe")).toBe("maybe");
  expect(settingArgument({ type: "number" }, "300")).toBe(300);
  expect(settingArgument({ type: "enum" }, "aux switch")).toBe("aux switch");
  expect(settingArgument(undefined, "true")).toBe(true);
});

test("runRow lists calls, then actions, each with its error, and the timers in seconds", () => {
  const row = runRow({
    at: 1_000,
    line: 3,
    trigger: "test",
    calls: [
      { entityId: "light.hall", command: { domain: "light", action: "turn_on" } },
      {
        entityId: "light.porch",
        command: { domain: "light", action: "turn_off" },
        error: "not permitted",
      },
    ],
    actions: [
      { integrationId: "zwave-js.main", action: "led_notify", params: {} },
      { integrationId: "zwave-js.main", action: "ping", params: {}, error: "offline" },
    ],
    armed: [30_000, 1_500],
    error: "boom",
  });
  expect(row).toEqual({
    at: 1_000,
    line: 3,
    trigger: "test",
    calls:
      "light.hall.turn_on, light.porch.turn_off ✗ not permitted, run zwave-js.main.led_notify, run zwave-js.main.ping ✗ offline",
    armed: "30s, 1.5s",
    error: "boom",
  });
  expect(Object.keys(row)).toEqual(RUN_COLUMNS);
});

test("runRow reads a run with no calls, actions or timers as blanks", () => {
  expect(runRow({ at: 1, line: 2, trigger: "every 5m" })).toEqual({
    at: 1,
    line: 2,
    trigger: "every 5m",
    calls: "",
    armed: "",
    error: undefined,
  });
});

test("pretendValues reads numbers, booleans and null as such and other text as written", () => {
  expect(
    pretendValues([
      "sensor.x=21",
      "sensor.y=-1.5",
      "switch.a=true",
      "switch.b=false",
      "sensor.z=null",
      "weather.home#conditionNext12h=rain",
      "light.hall=On",
    ]),
  ).toEqual({
    "sensor.x": 21,
    "sensor.y": -1.5,
    "switch.a": true,
    "switch.b": false,
    "sensor.z": null,
    "weather.home#conditionNext12h": "rain",
    "light.hall": "On",
  });
});

test("pretendValues keeps quoted text as text, even when it reads as a number or a word", () => {
  expect(pretendValues(['sensor.code="42"', 'sensor.word="true"', 'sensor.n="null"'])).toEqual({
    "sensor.code": "42",
    "sensor.word": "true",
    "sensor.n": "null",
  });
});

test("pretendValues splits on the first =, trims, and keeps an empty value as empty text", () => {
  expect(pretendValues(["sensor.eq = a=b ", "sensor.blank="])).toEqual({
    "sensor.eq": "a=b",
    "sensor.blank": "",
  });
});

test("pretendValues takes key=value and nothing else", () => {
  expect(() => pretendValues(["sensor.x"])).toThrow("--pretend takes key=value, not sensor.x");
  expect(() => pretendValues(["=21"])).toThrow("--pretend takes key=value, not =21");
  expect(pretendValues([])).toEqual({});
});
