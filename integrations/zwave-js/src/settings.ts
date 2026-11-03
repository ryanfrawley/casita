// A node's configuration parameters as device settings. Everything comes from the metadata
// the driver attaches to each Configuration CC value: from the device's config file when the
// driver has one (labels, options, ranges, partial parameters), or from what the device says
// about itself when it supports Configuration CC v3+. Nothing here names a model.

import type { DeviceSetting, SettingValue } from "@casita/core/types";
import { z } from "zod";
import type { Call, NodeValue, Values } from "./mapping.ts";
import { valueKey } from "./mapping.ts";

export const CONFIGURATION = 112;

const configMetadata = z.looseObject({
  type: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  readable: z.boolean().optional(),
  writeable: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.number().optional(),
  unit: z.string().optional(),
  states: z.record(z.string(), z.string()).optional(),
  allowManualEntry: z.boolean().optional(),
  valueSize: z.number().optional(),
  /** 0 signed, 1 unsigned, 2 enumerated, 3 bit field */
  format: z.number().optional(),
  isAdvanced: z.boolean().optional(),
  destructive: z.boolean().optional(),
});
export type ConfigMetadata = z.infer<typeof configMetadata>;

/** A configuration value with what the driver says about it. */
export interface ConfigParam {
  endpoint: number;
  parameter: number;
  /** The bits of a partial parameter; undefined for a whole one. */
  bitMask?: number;
  metadata: ConfigMetadata;
  /** Where its current value is kept in the node's value map. */
  valueKey: string;
}

/** The node's configuration parameters, in parameter order and then bit order. */
export function configParams(values: readonly NodeValue[]): ConfigParam[] {
  const params: ConfigParam[] = [];
  for (const value of values) {
    if (value.commandClass !== CONFIGURATION || typeof value.property !== "number") continue;
    // A value id with a string key is not a parameter (the driver's own bookkeeping).
    if (value.propertyKey !== undefined && typeof value.propertyKey !== "number") continue;
    const metadata = configMetadata.safeParse(value.metadata ?? {});
    params.push({
      endpoint: value.endpoint ?? 0,
      parameter: value.property,
      bitMask: value.propertyKey,
      metadata: metadata.success ? metadata.data : {},
      valueKey: valueKey(value),
    });
  }
  return params.sort(
    (a, b) =>
      a.endpoint - b.endpoint || a.parameter - b.parameter || (a.bitMask ?? 0) - (b.bitMask ?? 0),
  );
}

/** `"22"`, `"64[0xff00]"`, `"2.5"` on endpoint 2: the driver's own way of writing a parameter. */
export const settingKey = (param: Pick<ConfigParam, "endpoint" | "parameter" | "bitMask">) =>
  `${param.endpoint ? `${param.endpoint}.` : ""}${param.parameter}${
    param.bitMask === undefined ? "" : `[0x${param.bitMask.toString(16)}]`
  }`;

const OFF = /^(disabled?|off|false|no)$/i;
const ON = /^(enabled?|on|true|yes)$/i;

/** Two states, 0 and 1, that read as off and on: a switch, not a list. */
function isOnOff(states: Record<string, string> | undefined): boolean {
  if (!states) return false;
  const keys = Object.keys(states).sort();
  return (
    keys.length === 2 &&
    keys[0] === "0" &&
    keys[1] === "1" &&
    OFF.test(states["0"]?.trim() ?? "") &&
    ON.test(states["1"]?.trim() ?? "")
  );
}

/** What the labels of a partial parameter's parts share: "LED1 Strip Effect - Duration" → "LED1 Strip Effect". */
function sharedPrefix(labels: string[]): string {
  if (labels.length < 2) return "";
  let prefix = labels[0] ?? "";
  for (const label of labels.slice(1)) {
    while (!label.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  // Whole words only, without the separator that led into the part's own name.
  if (
    !labels.every(
      (label) => label.length === prefix.length || /[\s:\-–(]/.test(label[prefix.length] ?? ""),
    )
  )
    prefix = prefix.replace(/\S*$/, "");
  return prefix.replace(/[\s:\-–(]+$/, "").trim();
}

const labelOf = (param: ConfigParam) =>
  param.metadata.label?.trim() || `Parameter ${param.parameter}`;

/** Every configuration parameter of a node as a device setting, with its current value. */
export function nodeSettings(params: readonly ConfigParam[], values: Values): DeviceSetting[] {
  // The parts of a partial parameter share a heading: what their labels have in common, or
  // the parameter's number.
  const groups = new Map<string, string>();
  const parts = new Map<string, ConfigParam[]>();
  for (const param of params) {
    if (param.bitMask === undefined) continue;
    const whole = settingKey({ ...param, bitMask: undefined });
    parts.set(whole, [...(parts.get(whole) ?? []), param]);
  }
  for (const [whole, list] of parts) {
    groups.set(whole, sharedPrefix(list.map(labelOf)) || `Parameter ${list[0]?.parameter}`);
  }

  return params.map((param) => {
    const { metadata } = param;
    const raw = values.get(param.valueKey);
    const current = typeof raw === "number" ? raw : null;
    const states = metadata.states;
    const options = states
      ? Object.entries(states)
          .map(([value, label]) => ({ value: Number(value), label }))
          .filter((option) => Number.isFinite(option.value))
      : undefined;
    const onOff = isOnOff(states) && metadata.allowManualEntry !== true;
    const type: DeviceSetting["type"] = onOff
      ? "boolean"
      : options?.length && metadata.allowManualEntry === false
        ? "enum"
        : "number";
    const group =
      param.bitMask === undefined
        ? undefined
        : groups.get(settingKey({ ...param, bitMask: undefined }));
    const setting: DeviceSetting = {
      key: settingKey(param),
      label: labelOf(param),
      type,
      value: onOff ? (current === null ? null : current !== 0) : current,
    };
    if (metadata.description) setting.description = metadata.description;
    if (group) setting.group = group;
    if (metadata.default !== undefined)
      setting.default = onOff ? metadata.default !== 0 : metadata.default;
    if (type === "number") {
      if (metadata.min !== undefined) setting.min = metadata.min;
      if (metadata.max !== undefined) setting.max = metadata.max;
    }
    if (metadata.unit) setting.unit = metadata.unit;
    if (options?.length && !onOff) setting.options = options;
    if (metadata.writeable === false) setting.readOnly = true;
    if (metadata.destructive) setting.destructive = true;
    return setting;
  });
}

/** The call that sets a parameter through the driver, which keeps partial parameters whole. */
export function setSettingCall(nodeId: number, param: ConfigParam, value: SettingValue): Call {
  return {
    command: "node.set_value",
    params: {
      nodeId,
      valueId: {
        commandClass: CONFIGURATION,
        endpoint: param.endpoint,
        property: param.parameter,
        ...(param.bitMask === undefined ? {} : { propertyKey: param.bitMask }),
      },
      value: typeof value === "boolean" ? (value ? 1 : 0) : Number(value),
    },
  };
}

// zwave-js's SetValueStatus (node.set_value) and SupervisionStatus (raw configuration writes).
const WRITE_FAILED: Record<number, string> = {
  0: "the device doesn't support it",
  2: "the device refused it",
  3: "the device has no such endpoint",
  4: "the driver can't set it",
  5: "the device refused the value",
};

/**
 * Why a write the server answered failed, or undefined when it went through. zwave-js reports a
 * refused write as a status in the result, not as an error. A result with no status (an
 * unsupervised raw write) went out.
 */
export function writeFailure(result: unknown): string | undefined {
  const outer = (result ?? {}) as { status?: unknown; message?: unknown; result?: unknown };
  const inner = (outer.result ?? outer) as { status?: unknown; message?: unknown };
  const status = typeof inner.status === "number" ? inner.status : undefined;
  if (status === undefined || !(status in WRITE_FAILED)) return undefined;
  const why = WRITE_FAILED[status] ?? "it failed";
  return typeof inner.message === "string" && inner.message ? `${why}: ${inner.message}` : why;
}
