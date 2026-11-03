import { describe, expect, test } from "bun:test";
import { CoreError } from "./errors.ts";
import { checkSetting } from "./settings.ts";
import type { DeviceSetting, SettingValue } from "./types.ts";

const number: DeviceSetting = {
  key: "12",
  label: "Auto off",
  type: "number",
  value: 0,
  min: 0,
  max: 32767,
  options: [{ value: 0, label: "Disabled" }],
};
const choice: DeviceSetting = {
  key: "22",
  label: "Switch type",
  type: "enum",
  value: 0,
  options: [
    { value: 0, label: "Single pole" },
    { value: 2, label: "Multi-way with aux switch" },
  ],
};

const refusal = (setting: DeviceSetting, value: SettingValue): string => {
  try {
    checkSetting(setting, value);
  } catch (err) {
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe("invalid");
    return (err as Error).message;
  }
  throw new Error("accepted");
};

describe("checkSetting", () => {
  test.each([
    [number, 300, 300],
    [number, "300", 300],
    [number, "disabled", 0],
    [choice, 2, 2],
    [choice, "2", 2],
    [choice, "single pole", 0],
    [{ ...number, type: "boolean" } as DeviceSetting, true, true],
    [{ ...number, type: "string", options: undefined } as DeviceSetting, "abc", "abc"],
    [{ ...number, min: 1, step: 2 }, 5, 5],
  ] as [DeviceSetting, SettingValue, SettingValue][])(
    "%#: accepts and normalizes",
    (setting, value, out) => {
      expect(checkSetting(setting, value)).toBe(out);
    },
  );

  test.each([
    [number, -1, "Auto off is at least 0"],
    [number, 40000, "Auto off is at most 32767"],
    [number, 1.5, "Auto off takes a whole number"],
    [number, "soon", "Auto off takes a number"],
    [{ ...number, min: 1, step: 2 }, 4, "Auto off goes in steps of 2"],
    [choice, 1, "Switch type is one of: 0 (Single pole), 2 (Multi-way with aux switch)"],
    [{ ...number, type: "boolean" } as DeviceSetting, 1, "Auto off is on or off: true or false"],
    [{ ...number, readOnly: true }, 1, "Auto off is reported by the device and can't be changed"],
  ] as [DeviceSetting, SettingValue, string][])(
    "%#: refuses with a reason",
    (setting, value, why) => {
      expect(refusal(setting, value)).toBe(why);
    },
  );

  // Bug: Number("") and Number(" ") are 0, so an empty value from the API or CLI is sent as 0.
  test("refuses an empty or blank number", () => {
    expect(refusal(number, "")).toBe("Auto off takes a number");
    expect(refusal(number, "  ")).toBe("Auto off takes a number");
  });
});
