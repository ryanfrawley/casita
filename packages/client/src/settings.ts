// How a device's settings read to a person, and how they fall into sections. Shared by the
// CLI and the web app. The settings come from `get_device_settings` as the integration
// described them, so nothing here knows a device.

import type { Row } from "./present.ts";

export interface SettingOption {
  value: number | string;
  label: string;
}

/** A setting as the API sends it: core/types.ts `DeviceSetting`. */
export interface Setting {
  key: string;
  label: string;
  description?: string;
  group?: string;
  type: "number" | "boolean" | "enum" | "string";
  value: number | boolean | string | null;
  default?: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: SettingOption[];
  readOnly?: boolean;
  destructive?: boolean;
}

export const asSettings = (result: unknown): Setting[] =>
  ((result as Row | undefined)?.settings ?? []) as Setting[];

/** "Single pole", "On", "300 s", "255 · Indefinitely", "Not reported". */
export function settingText(setting: Setting, value = setting.value): string {
  if (value === null || value === undefined) return "Not reported";
  if (setting.type === "boolean") return value ? "On" : "Off";
  const named = setting.options?.find((option) => String(option.value) === String(value));
  if (setting.type === "enum") return named?.label ?? String(value);
  const plain = setting.unit ? `${value} ${setting.unit}` : String(value);
  return named ? `${plain} · ${named.label}` : plain;
}

/** The value it would have untouched, when the integration knows one and it differs. */
export const changedFromDefault = (setting: Setting): boolean =>
  setting.default !== undefined &&
  setting.value !== null &&
  String(setting.value) !== String(setting.default);

export interface SettingSection {
  /** `undefined` for the settings that belong to no group, listed first. */
  title?: string;
  settings: Setting[];
}

/**
 * The settings in sections: those with no group first, then each group in the order its first
 * setting came. Within a section the integration's order stands, which is the device's own.
 */
export function settingSections(settings: readonly Setting[]): SettingSection[] {
  const loose: Setting[] = [];
  const groups = new Map<string, Setting[]>();
  for (const setting of settings) {
    if (!setting.group) {
      loose.push(setting);
      continue;
    }
    const list = groups.get(setting.group) ?? [];
    list.push(setting);
    groups.set(setting.group, list);
  }
  return [
    ...(loose.length ? [{ settings: loose }] : []),
    ...[...groups].map(([title, list]) => ({ title, settings: list })),
  ];
}

/** Settings whose key, label, group or description holds every word of the query. */
export function findSettings(settings: readonly Setting[], query: string): Setting[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...settings];
  return settings.filter((setting) => {
    const text = [setting.key, setting.label, setting.group, setting.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Its label under its section's heading: "All LED Strip Effect - Duration" → "Duration". */
export function settingLabel(setting: Setting): string {
  const { group, label } = setting;
  if (!group || !label.startsWith(group)) return label;
  const rest = label.slice(group.length).replace(/^[\s:\-–]+/, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : label;
}
