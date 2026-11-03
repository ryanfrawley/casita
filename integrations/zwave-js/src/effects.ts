// LED effects ("notifications") on devices whose driver describes them as a configuration
// parameter split into parts: an effect, and some of color, level and duration. Found by what
// the driver calls the parts, so any device described that way works, whatever its parameter
// numbers, byte order or effect list:
//
//   Inovelli VZW31-SN   64[0xff] "LED1 Strip Effect - Duration" … 99[0xff000000] "All LED Strip Effect - Effect"
//   Inovelli LZW31-SN   16[0xff] "LED Indicator: Effect Color" … 16[0x7f000000] "LED Indicator: Effect Type"
//   Inovelli LZW36      24[…] "Light LED Effect Type", 25[…] "Fan LED Effect Type"
//
// The whole parameter is written at once, so the LEDs never show a half-changed effect.

import type { Call, Values } from "./mapping.ts";
import { type ConfigParam, settingKey } from "./settings.ts";

export const FIELDS = ["effect", "color", "level", "duration"] as const;
export type Field = (typeof FIELDS)[number];

/** What follows "Effect" in a part's label, and the field it names. */
const FIELD_NAMES: [RegExp, Field][] = [
  [/^(effect|type)$/i, "effect"],
  [/^(colou?r|hue\b.*)$/i, "color"],
  [/^(level|brightness|intensity)$/i, "level"],
  [/^duration$/i, "duration"],
];

export interface EffectField {
  param: ConfigParam;
  min: number;
  max: number;
  /** Named values, from the driver: 1 "Solid", 255 "Indefinitely". */
  options: { value: number; label: string }[];
  /** Only the named values are allowed. */
  closed: boolean;
}

export interface EffectTarget {
  /** The parameter's key: `"99"`, `"16"`. */
  id: string;
  /** What the labels call it: "All LED Strip", "LED Indicator", "Fan LED". */
  name: string;
  endpoint: number;
  parameter: number;
  valueSize: number;
  fields: Partial<Record<Field, EffectField>>;
  /** Every part of the parameter, including ones that are not effect fields, to keep them as they are. */
  parts: ConfigParam[];
}

const tidy = (text: string) => text.replace(/^[\s:\-–]+|[\s:\-–]+$/g, "").trim();

/** Which field a part's label names, and what it says the LEDs are called. */
function fieldOf(label: string): { field: Field; name: string } | undefined {
  const at = label.search(/\beffect\b/i);
  if (at < 0) return undefined;
  const rest = tidy(label.slice(at + "effect".length));
  const field = FIELD_NAMES.find(([re]) => re.test(rest))?.[1];
  return field && { field, name: tidy(label.slice(0, at)) };
}

const byteSize = (mask: number) => {
  const bits = Math.floor(Math.log2(mask)) + 1;
  return bits <= 8 ? 1 : bits <= 16 ? 2 : 4;
};

/** Every parameter of a node that is an LED effect: an effect part and at least one other. */
export function effectTargets(params: readonly ConfigParam[]): EffectTarget[] {
  const byParameter = new Map<string, ConfigParam[]>();
  for (const param of params) {
    // Configuration belongs to the root device; the raw write has no endpoint.
    if (param.bitMask === undefined || param.endpoint !== 0 || param.metadata.writeable === false)
      continue;
    const key = settingKey({ ...param, bitMask: undefined });
    byParameter.set(key, [...(byParameter.get(key) ?? []), param]);
  }
  const targets: EffectTarget[] = [];
  for (const [id, parts] of byParameter) {
    const fields: EffectTarget["fields"] = {};
    let name = "";
    for (const part of parts) {
      const found = fieldOf(part.metadata.label ?? "");
      if (!found || fields[found.field]) continue;
      name ||= found.name;
      const options = Object.entries(part.metadata.states ?? {})
        .map(([value, label]) => ({ value: Number(value), label }))
        .filter((option) => Number.isFinite(option.value));
      const closed = part.metadata.allowManualEntry === false && options.length > 0;
      const mask = part.bitMask as number;
      const top = closed
        ? Math.max(...options.map((o) => o.value))
        : (part.metadata.max ?? mask / 2 ** shift(mask));
      fields[found.field] = {
        param: part,
        min: part.metadata.min ?? 0,
        max: Math.min(top, mask / 2 ** shift(mask)),
        options,
        closed,
      };
    }
    if (!fields.effect || Object.keys(fields).length < 2) continue;
    const first = parts[0] as ConfigParam;
    const widest = Math.max(...parts.map((part) => part.bitMask ?? 0));
    targets.push({
      id,
      name: name || `Parameter ${first.parameter}`,
      endpoint: first.endpoint,
      parameter: first.parameter,
      valueSize: first.metadata.valueSize ?? byteSize(widest),
      fields,
      parts,
    });
  }
  return targets;
}

/** How far a mask's lowest bit is from bit 0. */
const shift = (mask: number) => {
  let n = 0;
  while (mask > 0 && mask % 2 === 0) {
    mask /= 2;
    n++;
  }
  return n;
};

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();

/** The target a caller named, by parameter or name; with none named, the one for every LED. */
export function pickTarget(targets: readonly EffectTarget[], wanted?: string): EffectTarget {
  const names = () => targets.map((t) => `${t.id} (${t.name})`).join(", ");
  if (!targets.length) throw new Error("This device has no LED effects its driver describes");
  if (wanted !== undefined) {
    const found =
      targets.find((t) => t.id === wanted) ??
      targets.find((t) => normalized(t.name) === normalized(wanted));
    if (!found) throw new Error(`No LED target "${wanted}"; this device has ${names()}`);
    return found;
  }
  const all = targets.filter((t) => /\ball\b/i.test(t.name));
  if (all.length === 1) return all[0] as EffectTarget;
  if (targets.length === 1) return targets[0] as EffectTarget;
  throw new Error(`Say which LEDs with target: ${names()}`);
}

export type EffectRequest = Partial<Record<Field, number | string>>;

/** A field's value as a number, from a number or one of its option names ("pulse", "indefinitely"). */
function fieldValue(field: Field, spec: EffectField, given: number | string): number {
  const named =
    typeof given === "string"
      ? spec.options.find((option) => normalized(option.label) === normalized(given))
      : undefined;
  // Number("") is 0, which is usually "off"; a blank names nothing.
  const value = named
    ? named.value
    : typeof given === "number"
      ? given
      : given.trim()
        ? Number(given)
        : Number.NaN;
  if (!Number.isInteger(value)) {
    const names = spec.options.map((o) => `${o.value} (${o.label})`).join(", ");
    throw new Error(`${field} takes a number${names ? ` or one of ${names}` : ""}; got "${given}"`);
  }
  if (spec.closed && !spec.options.some((option) => option.value === value)) {
    const names = spec.options.map((o) => `${o.value} (${o.label})`).join(", ");
    throw new Error(`${field} is one of ${names}; got ${value}`);
  }
  if (value < spec.min || value > spec.max)
    throw new Error(`${field} is ${spec.min} to ${spec.max}; got ${value}`);
  return value;
}

export interface ComposedEffect {
  value: number;
  fields: Partial<Record<Field, number>>;
}

/**
 * The whole parameter's value: the fields given, and every other part as it is now. A level or
 * duration that is not given and is 0 now would hide the effect, so it goes to its maximum.
 */
export function composeEffect(
  target: EffectTarget,
  request: EffectRequest,
  values: Values,
): ComposedEffect {
  for (const field of FIELDS) {
    if (request[field] !== undefined && !target.fields[field])
      throw new Error(`${target.name} has no ${field}`);
  }
  const fields: ComposedEffect["fields"] = {};
  for (const field of FIELDS) {
    const spec = target.fields[field];
    if (!spec) continue;
    const given = request[field];
    const now = values.get(spec.param.valueKey);
    const current = typeof now === "number" ? now : (spec.param.metadata.default ?? 0);
    fields[field] =
      given !== undefined
        ? fieldValue(field, spec, given)
        : (field === "level" || field === "duration") && current === 0
          ? spec.max
          : current;
  }
  let value = 0;
  for (const part of target.parts) {
    const mask = part.bitMask ?? 0;
    const field = FIELDS.find((name) => target.fields[name]?.param === part);
    const now = values.get(part.valueKey);
    const partValue =
      field !== undefined ? (fields[field] ?? 0) : typeof now === "number" ? now : 0;
    // Arithmetic, not bit operators: those are signed 32-bit, and the top byte is often set.
    const low = 2 ** shift(mask);
    value += (partValue % (mask / low + 1)) * low;
  }
  return { value, fields };
}

/** The raw write of the whole parameter, then a read so the driver's parts follow it. */
export function effectCalls(nodeId: number, target: EffectTarget, value: number): Call[] {
  return [
    {
      command: "node.set_raw_config_parameter_value",
      params: {
        nodeId,
        parameter: target.parameter,
        value,
        valueSize: target.valueSize,
        valueFormat: 1, // unsigned
      },
    },
    {
      command: "node.get_raw_config_parameter_value",
      params: { nodeId, parameter: target.parameter },
    },
  ];
}
