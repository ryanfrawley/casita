import { describe, expect, test } from "bun:test";
import {
  changedFromDefault,
  findSettings,
  type Setting,
  settingLabel,
  settingSections,
  settingText,
} from "./settings.ts";

const base = { value: 0 } as const;
const switchType: Setting = {
  ...base,
  key: "22",
  label: "Switch Type",
  type: "enum",
  default: 0,
  options: [
    { value: 0, label: "Single pole" },
    { value: 2, label: "Multi-way with aux switch" },
  ],
};
const autoOff: Setting = {
  key: "12",
  label: "Auto Off Timer",
  type: "number",
  value: 300,
  unit: "seconds",
  options: [{ value: 0, label: "Disabled" }],
};
const duration: Setting = {
  key: "99[0xff]",
  label: "All LED Strip Effect - Duration",
  group: "All LED Strip Effect",
  type: "number",
  value: 255,
  options: [{ value: 255, label: "Indefinitely" }],
};
const effect: Setting = {
  ...duration,
  key: "99[0xff000000]",
  label: "All LED Strip Effect - Effect",
  type: "enum",
  value: 4,
  options: [{ value: 4, label: "Pulse" }],
};

describe("settingText", () => {
  test.each([
    [switchType, "Single pole"],
    [{ ...switchType, value: 9 }, "9"],
    [autoOff, "300 seconds"],
    [{ ...autoOff, value: 0 }, "0 seconds · Disabled"],
    [duration, "255 · Indefinitely"],
    [{ ...autoOff, type: "boolean", value: true } as Setting, "On"],
    [{ ...autoOff, type: "boolean", value: false } as Setting, "Off"],
    [{ ...autoOff, value: null }, "Not reported"],
  ])("%#", (setting, text) => {
    expect(settingText(setting)).toBe(text);
  });
});

test("changedFromDefault compares as text, and is false with no default or no value", () => {
  expect(changedFromDefault(switchType)).toBe(false);
  expect(changedFromDefault({ ...switchType, value: 2 })).toBe(true);
  expect(changedFromDefault(autoOff)).toBe(false);
  expect(changedFromDefault({ ...switchType, value: null })).toBe(false);
});

test("settingSections puts the ungrouped first, then groups in first-seen order", () => {
  const other = { ...duration, key: "64[0xff]", group: "LED1 Strip Effect" };
  expect(settingSections([duration, switchType, other, effect, autoOff])).toEqual([
    { settings: [switchType, autoOff] },
    { title: "All LED Strip Effect", settings: [duration, effect] },
    { title: "LED1 Strip Effect", settings: [other] },
  ]);
  expect(settingSections([duration])).toEqual([
    { title: "All LED Strip Effect", settings: [duration] },
  ]);
});

test("findSettings matches every word across key, label and group", () => {
  const all = [switchType, autoOff, duration, effect];
  expect(findSettings(all, "")).toEqual(all);
  expect(findSettings(all, "led duration")).toEqual([duration]);
  expect(findSettings(all, "22")).toEqual([switchType]);
  expect(findSettings(all, "nothing")).toEqual([]);
});

test("settingLabel drops its group's words, and keeps a label that does not start with them", () => {
  expect(settingLabel(duration)).toBe("Duration");
  expect(
    settingLabel({ ...duration, label: "LED Indicator: Effect color", group: "LED Indicator:" }),
  ).toBe("Effect color");
  expect(settingLabel({ ...duration, group: "Parameter 99" })).toBe(duration.label);
  expect(settingLabel({ ...duration, label: "All LED Strip Effect" })).toBe("All LED Strip Effect");
  expect(settingLabel(autoOff)).toBe("Auto Off Timer");
});
