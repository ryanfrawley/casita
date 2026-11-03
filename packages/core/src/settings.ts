// A device setting's value, checked against what its integration said the setting takes,
// before the integration is asked to send it. One rule for every integration.

import { CoreError } from "./errors.ts";
import type { DeviceSetting, SettingValue } from "./types.ts";

/** The value to send, or a CoreError("invalid") saying why it does not fit. */
export function checkSetting(setting: DeviceSetting, value: SettingValue): SettingValue {
  const refuse = (why: string) => new CoreError("invalid", `${setting.label} ${why}`);
  if (setting.readOnly) throw refuse("is reported by the device and can't be changed");
  switch (setting.type) {
    case "boolean":
      if (typeof value !== "boolean") throw refuse("is on or off: true or false");
      return value;
    case "string":
      if (typeof value !== "string") throw refuse("takes text");
      return value;
    case "enum": {
      // A choice may be given by its value or by its label, whichever the caller has.
      const options = setting.options ?? [];
      const found =
        options.find((option) => option.value === value) ??
        options.find((option) => String(option.value) === String(value)) ??
        options.find((option) => option.label.toLowerCase() === String(value).toLowerCase());
      if (!found)
        throw refuse(`is one of: ${options.map((o) => `${o.value} (${o.label})`).join(", ")}`);
      return found.value;
    }
    case "number": {
      const named =
        typeof value === "string"
          ? setting.options?.find((o) => o.label.toLowerCase() === value.toLowerCase())
          : undefined;
      const number = named
        ? Number(named.value)
        : typeof value === "string"
          ? Number(value)
          : value;
      // Number("") is 0; a blank is not a number.
      if (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        (typeof value === "string" && !named && !value.trim())
      )
        throw refuse("takes a number");
      if (setting.min !== undefined && number < setting.min)
        throw refuse(`is at least ${setting.min}`);
      if (setting.max !== undefined && number > setting.max)
        throw refuse(`is at most ${setting.max}`);
      const step = setting.step ?? 1;
      const from = setting.min ?? 0;
      // Steps are counted from the minimum, with room for floating-point drift.
      if (Math.abs((number - from) / step - Math.round((number - from) / step)) > 1e-9)
        throw refuse(step === 1 ? "takes a whole number" : `goes in steps of ${step}`);
      return number;
    }
  }
}
