// Configuration parameters as settings, and LED effects found in them, from the metadata the
// driver gives three Inovelli models with three different layouts.

import { describe, expect, test } from "bun:test";
import { composeEffect, effectCalls, effectTargets, pickTarget } from "../src/effects.ts";
import { valueKey, type ZwaveNode, zwaveNode } from "../src/mapping.ts";
import {
  type ConfigMetadata,
  type ConfigParam,
  configParams,
  nodeSettings,
  setSettingCall,
  settingKey,
  writeFailure,
} from "../src/settings.ts";

const dump = (await Bun.file(
  new URL("../../../tests/fixtures/zwave-js/config-nodes.synthetic.json", import.meta.url),
).json()) as { state: { nodes: unknown[] } };
const nodes = new Map(
  dump.state.nodes.map((raw) => {
    const node = zwaveNode.parse(raw);
    return [node.nodeId, node] as const;
  }),
);
const nodeOf = (id: number): ZwaveNode => nodes.get(id) as ZwaveNode;
const valuesOf = (node: ZwaveNode) => new Map(node.values.map((v) => [valueKey(v), v.value]));
const paramsOf = (id: number) => configParams(nodeOf(id).values);
const settingsOf = (id: number) => nodeSettings(paramsOf(id), valuesOf(nodeOf(id)));

const VZW31 = 11;
const LZW31 = 12;
const LZW36 = 13;

describe("nodeSettings", () => {
  test("keys a whole parameter by number and a part by its mask, in the device's order", () => {
    expect(settingsOf(VZW31).map((s) => s.key)).toEqual([
      "12",
      "21",
      "22",
      "52",
      "59[0x1]",
      "59[0x2]",
      "64[0xff]",
      "64[0xff00]",
      "64[0xff0000]",
      "64[0xff000000]",
      "95",
      "97",
      "99[0xff]",
      "99[0xff00]",
      "99[0xff0000]",
      "99[0xff000000]",
      "240",
    ]);
    expect(settingKey({ endpoint: 2, parameter: 5, bitMask: undefined })).toBe("2.5");
  });

  test("reads the driver's metadata as a number, a list, a switch or a reading", () => {
    const byKey = new Map(settingsOf(VZW31).map((s) => [s.key, s]));
    expect(byKey.get("12")).toEqual({
      key: "12",
      label: "Auto Off Timer",
      type: "number",
      value: 0,
      default: 0,
      min: 0,
      max: 32767,
      unit: "seconds",
      options: [{ value: 0, label: "Disabled" }],
    });
    expect(byKey.get("22")).toMatchObject({ type: "enum", value: 0 });
    expect(byKey.get("22")?.options).toHaveLength(4);
    expect(byKey.get("22")?.min).toBeUndefined();
    // Disable/Enable is a switch, its value and default as booleans.
    expect(byKey.get("52")).toMatchObject({ type: "boolean", value: false, default: false });
    expect(byKey.get("52")?.options).toBeUndefined();
    expect(byKey.get("21")).toMatchObject({ type: "enum", value: 1, readOnly: true });
    expect(byKey.get("240")).toMatchObject({ type: "enum", destructive: true });
  });

  test("the parts of a parameter share a heading: what their labels have in common", () => {
    const groups = (id: number) => [...new Set(settingsOf(id).map((s) => s.group))];
    expect(groups(VZW31)).toEqual([
      undefined,
      "Parameter 59", // "Send Local…" and "Forward Z-Wave…" share no words
      "LED1 Strip Effect",
      "All LED Strip Effect",
    ]);
    expect(groups(LZW31)).toEqual(["LED Indicator: Effect"]);
    expect(groups(LZW36)).toEqual(["Light LED Effect", "Fan LED Effect"]);
  });

  test("a value the device has not reported is null", () => {
    const node = nodeOf(VZW31);
    const values = valuesOf(node);
    values.delete(valueKey({ commandClass: 112, endpoint: 0, property: 22 }));
    values.delete(valueKey({ commandClass: 112, endpoint: 0, property: 52 }));
    const settings = nodeSettings(configParams(node.values), values);
    expect(settings.find((s) => s.key === "22")?.value).toBeNull();
    expect(settings.find((s) => s.key === "52")?.value).toBeNull();
  });

  test("a setting is written through set_value, a part with its mask, a switch as 0 or 1", () => {
    const params = paramsOf(VZW31);
    const param = (key: string) => params.find((p) => settingKey(p) === key);
    expect(setSettingCall(11, param("52") as never, true)).toEqual({
      command: "node.set_value",
      params: {
        nodeId: 11,
        valueId: { commandClass: 112, endpoint: 0, property: 52 },
        value: 1,
      },
    });
    expect(setSettingCall(11, param("59[0x2]") as never, 1).params.valueId).toEqual({
      commandClass: 112,
      endpoint: 0,
      property: 59,
      propertyKey: 2,
    });
  });

  test("a node with no Configuration values has no settings", () => {
    expect(nodeSettings(configParams([]), new Map())).toEqual([]);
  });
});

describe("effectTargets", () => {
  test("finds each LED effect parameter by its parts' labels, on all three layouts", () => {
    const summary = (id: number) =>
      effectTargets(paramsOf(id)).map((t) => [t.id, t.name, Object.keys(t.fields).sort()]);
    const all = ["color", "duration", "effect", "level"];
    expect(summary(VZW31)).toEqual([
      ["64", "LED1 Strip", all],
      ["99", "All LED Strip", all],
    ]);
    expect(summary(LZW31)).toEqual([["16", "LED Indicator", all]]);
    expect(summary(LZW36)).toEqual([
      ["24", "Light LED", all],
      ["25", "Fan LED", all],
    ]);
  });

  test("a field's range is its options' when they are the only values allowed", () => {
    const [target] = effectTargets(paramsOf(LZW31));
    expect(target?.fields.level).toMatchObject({ min: 0, max: 10, closed: true });
    expect(target?.fields.effect).toMatchObject({ max: 5, closed: true });
    expect(target?.fields.duration).toMatchObject({ max: 255, closed: false });
  });

  test("a partial parameter that is not an effect is not a target", () => {
    expect(effectTargets(paramsOf(VZW31)).some((t) => t.id === "59")).toBe(false);
  });
});

describe("pickTarget", () => {
  const vzw = effectTargets(paramsOf(VZW31));
  const fan = effectTargets(paramsOf(LZW36));
  test("with nothing named, the one for every LED, or the only one", () => {
    expect(pickTarget(vzw).id).toBe("99");
    expect(pickTarget(effectTargets(paramsOf(LZW31))).id).toBe("16");
  });
  test("by parameter or by name, in any case or spacing", () => {
    expect(pickTarget(vzw, "64").id).toBe("64");
    expect(pickTarget(fan, "fan_led").id).toBe("25");
  });
  test("says what there is when it can't tell", () => {
    expect(() => pickTarget(fan)).toThrow(
      "Say which LEDs with target: 24 (Light LED), 25 (Fan LED)",
    );
    expect(() => pickTarget(vzw, "7")).toThrow(
      'No LED target "7"; this device has 64 (LED1 Strip), 99 (All LED Strip)',
    );
    expect(() => pickTarget([])).toThrow("This device has no LED effects its driver describes");
  });
});

describe("composeEffect", () => {
  const vzw = pickTarget(effectTargets(paramsOf(VZW31)));
  const values = valuesOf(nodeOf(VZW31));

  test("places each field by its mask: VZW31 is effect, color, level, duration from the top", () => {
    const { value, fields } = composeEffect(
      vzw,
      { effect: "pulse", color: 0, level: 100, duration: "indefinitely" },
      values,
    );
    expect(fields).toEqual({ effect: 4, color: 0, level: 100, duration: 255 });
    expect(value).toBe(4 * 2 ** 24 + 0 * 2 ** 16 + 100 * 2 ** 8 + 255); // 67134719
  });

  test("a top byte with its high bit set stays unsigned", () => {
    const { value } = composeEffect(vzw, { effect: "clear", level: 1, duration: 1 }, values);
    expect(value).toBe(255 * 2 ** 24 + 170 * 2 ** 16 + 1 * 2 ** 8 + 1);
    expect(value).toBeGreaterThan(2 ** 31);
  });

  test("a field not given keeps its value; a level or duration at 0 goes to its maximum", () => {
    // Color is 170 in the fixture; level and duration are 0.
    expect(composeEffect(vzw, { effect: 1 }, values).fields).toEqual({
      effect: 1,
      color: 170,
      level: 100,
      duration: 255,
    });
  });

  test("LZW31 is color, brightness, duration, effect from the bottom, its effect in 7 bits", () => {
    const target = pickTarget(effectTargets(paramsOf(LZW31)));
    const { value, fields } = composeEffect(
      target,
      { effect: "slow blink", color: "red", level: "50%", duration: 30 },
      valuesOf(nodeOf(LZW31)),
    );
    expect(fields).toEqual({ effect: 4, color: 0, level: 5, duration: 30 });
    expect(value).toBe(4 * 2 ** 24 + 30 * 2 ** 16 + 5 * 2 ** 8 + 0);
  });

  test("refuses a value out of range, not among closed options, or unnamed", () => {
    const lzw = pickTarget(effectTargets(paramsOf(LZW31)));
    const lzwValues = valuesOf(nodeOf(LZW31));
    expect(() => composeEffect(vzw, { effect: 1, level: 101 }, values)).toThrow(
      "level is 0 to 100; got 101",
    );
    expect(() => composeEffect(lzw, { effect: 6 }, lzwValues)).toThrow(
      "effect is one of 0 (Off), 1 (Solid), 2 (Chase), 3 (Fast blink), 4 (Slow blink), 5 (Pulse); got 6",
    );
    expect(() => composeEffect(vzw, { effect: "sparkle" }, values)).toThrow(
      "effect takes a number or one of 0 (Off)",
    );
  });

  test("the write is the whole parameter, unsigned, then a read so the parts follow", () => {
    expect(effectCalls(11, vzw, 67134719)).toEqual([
      {
        command: "node.set_raw_config_parameter_value",
        params: { nodeId: 11, parameter: 99, value: 67134719, valueSize: 4, valueFormat: 1 },
      },
      { command: "node.get_raw_config_parameter_value", params: { nodeId: 11, parameter: 99 } },
    ]);
  });
});

/** A synthetic configuration parameter, or one part of it, as configParams would give it. */
const param = (
  parameter: number,
  bitMask: number | undefined,
  metadata: ConfigMetadata,
  endpoint = 0,
): ConfigParam => ({
  endpoint,
  parameter,
  bitMask,
  metadata,
  valueKey: valueKey({ commandClass: 112, endpoint, property: parameter, propertyKey: bitMask }),
});
const valuesFor = (entries: [ConfigParam, number][]) =>
  new Map<string, unknown>(entries.map(([p, value]) => [p.valueKey, value]));

describe("nodeSettings on synthetic metadata", () => {
  const groupsOf = (labels: string[]) =>
    nodeSettings(
      labels.map((label, i) => param(7, 0xff * 2 ** (8 * i), { label })),
      new Map(),
    ).map((s) => s.group);

  test("a parameter with a single part is headed by its number", () => {
    expect(groupsOf(["LED Color"])).toEqual(["Parameter 7"]);
  });

  test("labels that share only part of a word share the words before it", () => {
    expect(groupsOf(["Fan Speed Low", "Fan Spin"])).toEqual(["Fan", "Fan"]);
    expect(groupsOf(["Brightness", "Bright Mode"])).toEqual(["Parameter 7", "Parameter 7"]);
  });

  test("a label that is all of the shared part keeps it whole", () => {
    expect(groupsOf(["LED", "LED Color"])).toEqual(["LED", "LED"]);
  });

  test("Off and On as 0 and 1 are a switch, in any case or spacing", () => {
    const p = param(3, undefined, {
      label: "Indicator",
      states: { "0": " off ", "1": "ON" },
      allowManualEntry: false,
      default: 1,
    });
    const [setting] = nodeSettings([p], valuesFor([[p, 1]]));
    expect(setting).toEqual({
      key: "3",
      label: "Indicator",
      type: "boolean",
      value: true,
      default: true,
    });
  });

  test("No and Yes are a switch, and a value other than 0 reads as on", () => {
    const p = param(3, undefined, { label: "Beep", states: { "0": "No", "1": "Yes" } });
    expect(nodeSettings([p], valuesFor([[p, 2]]))[0]).toMatchObject({
      type: "boolean",
      value: true,
    });
  });

  test("Off and On that also allow other values are a number naming them", () => {
    const p = param(3, undefined, {
      label: "Level",
      states: { "0": "Off", "1": "On" },
      allowManualEntry: true,
      min: 0,
      max: 99,
      default: 0,
    });
    const [setting] = nodeSettings([p], valuesFor([[p, 40]]));
    expect(setting).toEqual({
      key: "3",
      label: "Level",
      type: "number",
      value: 40,
      default: 0,
      min: 0,
      max: 99,
      options: [
        { value: 0, label: "Off" },
        { value: 1, label: "On" },
      ],
    });
  });

  test("two states that are not off then on are a list", () => {
    const states = (s: Record<string, string>) =>
      nodeSettings([param(3, undefined, { states: s, allowManualEntry: false })], new Map())[0]
        ?.type;
    expect(states({ "0": "On", "1": "Off" })).toBe("enum");
    expect(states({ "0": "Off", "1": "Low" })).toBe("enum");
    expect(states({ "0": "Off", "1": "On", "2": "Auto" })).toBe("enum");
    expect(states({ "1": "Off", "2": "On" })).toBe("enum");
  });

  test("a parameter with no label is called by its number", () => {
    expect(nodeSettings([param(41, undefined, {})], new Map())[0]?.label).toBe("Parameter 41");
  });
});

describe("effectTargets on synthetic metadata", () => {
  const ledParts = (endpoint = 0, overrides: Partial<Record<string, ConfigMetadata>> = {}) => [
    param(30, 0xff, { label: "LED Effect Type", ...overrides.effect }, endpoint),
    param(30, 0xff00, { label: "LED Effect Level", max: 100, ...overrides.level }, endpoint),
    param(30, 0xff0000, { label: "LED Effect Color", ...overrides.color }, endpoint),
  ];

  test("a parameter on an endpoint other than the root is not a target", () => {
    expect(effectTargets(ledParts(1))).toEqual([]);
    expect(effectTargets([...ledParts(1), ...ledParts(0)]).map((t) => t.id)).toEqual(["30"]);
  });

  test("a read-only part is left out, and a target needs a writable effect", () => {
    const [target] = effectTargets(ledParts(0, { level: { writeable: false } }));
    expect(Object.keys(target?.fields ?? {}).sort()).toEqual(["color", "effect"]);
    expect(target?.parts).toHaveLength(2);
    expect(effectTargets(ledParts(0, { effect: { writeable: false } }))).toEqual([]);
  });

  test("an effect part alone, or with parts that are not fields, is not a target", () => {
    expect(effectTargets([param(30, 0xff, { label: "LED Effect Type" })])).toEqual([]);
    expect(
      effectTargets([
        param(30, 0xff, { label: "LED Effect Type" }),
        param(30, 0xff00, { label: "LED Reserved" }),
      ]),
    ).toEqual([]);
    expect(
      effectTargets([
        param(30, 0xff, { label: "LED Color" }),
        param(30, 0xff00, { label: "LED Level" }),
      ]),
    ).toEqual([]);
  });

  test("a whole parameter is never a target", () => {
    expect(effectTargets([param(30, undefined, { label: "LED Effect Type" })])).toEqual([]);
  });

  test("names the LEDs by what comes before Effect, or by the parameter's number", () => {
    expect(effectTargets(ledParts())[0]?.name).toBe("LED");
    const unnamed = effectTargets([
      param(31, 0xff, { label: "Effect Type" }),
      param(31, 0xff00, { label: "Effect Colour" }),
    ]);
    expect(unnamed[0]).toMatchObject({ id: "31", name: "Parameter 31" });
    expect(Object.keys(unnamed[0]?.fields ?? {}).sort()).toEqual(["color", "effect"]);
  });

  test("its size is the driver's, or the smallest that holds its widest part", () => {
    expect(effectTargets(ledParts())[0]?.valueSize).toBe(4);
    expect(effectTargets(ledParts(0, { effect: { valueSize: 2 } }))[0]?.valueSize).toBe(2);
    expect(effectTargets(ledParts().slice(0, 2))[0]?.valueSize).toBe(2);
  });
});

describe("composeEffect on synthetic metadata", () => {
  const effect = param(30, 0xff, {
    label: "LED Effect Type",
    states: { "0": "Off", "1": "Slow Blink", "2": "Fast Blink" },
    allowManualEntry: false,
  });
  const level = param(30, 0xff00, { label: "LED Effect Level", max: 100 });
  const reserved = param(30, 0xff0000, { label: "LED Reserved" });
  const repeat = param(30, 0xff000000, { label: "LED Effect Type" });
  const [target] = effectTargets([effect, level, reserved, repeat]);
  const led = target as NonNullable<typeof target>;

  test("a part that is not a field keeps its current value", () => {
    const values = valuesFor([
      [effect, 0],
      [level, 20],
      [reserved, 7],
      [repeat, 3],
    ]);
    const { value, fields } = composeEffect(led, { effect: 2, level: 50 }, values);
    expect(fields).toEqual({ effect: 2, level: 50 });
    expect(value).toBe(2 + 50 * 2 ** 8 + 7 * 2 ** 16 + 3 * 2 ** 24);
  });

  test("a part that is not a field and has no value is written as 0", () => {
    expect(composeEffect(led, { effect: 1, level: 1 }, valuesFor([])).value).toBe(1 + 2 ** 8);
  });

  test("an option is found by its name with underscores, hyphens or extra spaces", () => {
    const pick = (given: string) => composeEffect(led, { effect: given }, new Map()).fields.effect;
    expect(pick("slow_blink")).toBe(1);
    expect(pick("Fast-Blink")).toBe(2);
    expect(pick("  fast   blink ")).toBe(2);
    expect(pick("2")).toBe(2);
  });

  test("refuses a field the target does not have, by the target's name", () => {
    expect(() => composeEffect(led, { effect: 1, color: 0 }, new Map())).toThrow(
      "LED has no color",
    );
    expect(() => composeEffect(led, { duration: 10 }, new Map())).toThrow("LED has no duration");
  });

  test("a field not given and not reported starts from the driver's default", () => {
    const withDefault = effectTargets([
      param(32, 0xff, { label: "Effect Type", default: 2 }),
      param(32, 0xff00, { label: "Effect Level", max: 10, default: 4 }),
    ])[0] as typeof led;
    expect(composeEffect(withDefault, {}, new Map()).fields).toEqual({ effect: 2, level: 4 });
  });

  test("a fractional number is refused", () => {
    expect(() => composeEffect(led, { effect: 1, level: 1.5 }, new Map())).toThrow(
      'level takes a number; got "1.5"',
    );
  });

  // Bug: Number("") is 0, so an empty string is read as the value 0 (here, "Off").
  test("an empty value is refused rather than read as 0", () => {
    expect(() => composeEffect(led, { effect: "" }, new Map())).toThrow("effect takes a number");
  });
});

describe("writeFailure", () => {
  test.each([
    [{ result: { status: 255 } }, undefined],
    [{ result: { status: 254 } }, undefined],
    [{ result: { status: 1 } }, undefined],
    [{}, undefined],
    [undefined, undefined],
    [
      { result: { status: 5, message: "out of range" } },
      "the device refused the value: out of range",
    ],
    [{ result: { status: 0 } }, "the device doesn't support it"],
    [{ status: 2 }, "the device refused it"],
  ])("%p", (result, why) => {
    expect(writeFailure(result)).toBe(why);
  });
});
