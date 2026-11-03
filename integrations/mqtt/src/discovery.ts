// Parsing for the MQTT discovery convention: <prefix>/<component>/[<node>/]<object>/config.
// Only the fields this integration honors are read; everything else is ignored.

import { z } from "zod";

export const COMPONENTS = [
  "light",
  "switch",
  "sensor",
  "binary_sensor",
  "cover",
  "button",
] as const;
export type Component = (typeof COMPONENTS)[number];

/** Devices commonly publish abbreviated keys; these are the ones for the fields honored here. */
const ABBREVIATIONS: Record<string, string> = {
  avty: "availability",
  avty_t: "availability_topic",
  bri_cmd_t: "brightness_command_topic",
  bri_scl: "brightness_scale",
  bri_stat_t: "brightness_state_topic",
  bri_val_tpl: "brightness_value_template",
  cmd_t: "command_topic",
  dev: "device",
  dev_cla: "device_class",
  pl_avail: "payload_available",
  pl_cls: "payload_close",
  pl_not_avail: "payload_not_available",
  pl_off: "payload_off",
  pl_on: "payload_on",
  pl_open: "payload_open",
  pl_prs: "payload_press",
  pl_stop: "payload_stop",
  pos_t: "position_topic",
  set_pos_t: "set_position_topic",
  stat_t: "state_topic",
  uniq_id: "unique_id",
  unit_of_meas: "unit_of_measurement",
  val_tpl: "value_template",
};

const DEVICE_ABBREVIATIONS: Record<string, string> = {
  ids: "identifiers",
  mf: "manufacturer",
  mdl: "model",
  sw: "sw_version",
};

const topic = z.string().min(1);
const scalar = z.union([z.string(), z.number()]).transform(String);

const configSchema = z.looseObject({
  name: z.string().nullish(),
  unique_id: z.string().optional(),
  state_topic: topic.optional(),
  command_topic: topic.optional(),
  availability_topic: topic.optional(),
  availability: z.array(z.looseObject({ topic })).optional(),
  payload_available: z.string().default("online"),
  payload_not_available: z.string().default("offline"),
  payload_on: scalar.default("ON"),
  payload_off: scalar.default("OFF"),
  value_template: z.string().optional(),
  unit_of_measurement: z.string().nullish(),
  device_class: z.string().nullish(),
  brightness_state_topic: topic.optional(),
  brightness_command_topic: topic.optional(),
  brightness_scale: z.number().positive().default(255),
  brightness_value_template: z.string().optional(),
  schema: z.string().optional(),
  position_topic: topic.optional(),
  set_position_topic: topic.optional(),
  payload_open: z.string().default("OPEN"),
  payload_close: z.string().default("CLOSE"),
  payload_stop: z.string().default("STOP"),
  payload_press: z.string().default("PRESS"),
  device: z
    .looseObject({
      identifiers: z.union([z.string(), z.array(z.string())]).optional(),
      name: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      sw_version: z.string().optional(),
    })
    .optional(),
});
export type DiscoveryConfig = z.infer<typeof configSchema>;

export interface Discovered {
  component: Component;
  /** `<component>/[<node>/]<object>`: identifies the config topic, and the entity if it has no unique_id. */
  key: string;
  objectId: string;
  /** null when the payload was empty, which removes the entity. */
  config: DiscoveryConfig | null;
}

const rename = (object: Record<string, unknown>, names: Record<string, string>) =>
  Object.fromEntries(Object.entries(object).map(([k, v]) => [names[k] ?? k, v]));

/**
 * Parses one discovery message. Returns undefined for topics that are not discovery configs
 * of a supported component; throws with a readable reason for a config that cannot be used.
 */
export function parseDiscovery(
  prefix: string,
  messageTopic: string,
  payload: string,
): Discovered | undefined {
  const parts = messageTopic.slice(prefix.length + 1).split("/");
  if (!messageTopic.startsWith(`${prefix}/`) || parts.at(-1) !== "config") return undefined;
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const component = parts[0] as Component;
  if (!COMPONENTS.includes(component)) return undefined;
  const key = parts.slice(0, -1).join("/");
  const objectId = parts.at(-2) ?? "";
  if (payload.trim() === "") return { component, key, objectId, config: null };

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new Error("payload is not JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("payload is not an object");

  const expanded = rename(raw as Record<string, unknown>, ABBREVIATIONS);
  if (expanded.device && typeof expanded.device === "object") {
    expanded.device = rename(expanded.device as Record<string, unknown>, DEVICE_ABBREVIATIONS);
  }
  if (Array.isArray(expanded.availability)) {
    expanded.availability = expanded.availability.map((entry) =>
      entry && typeof entry === "object"
        ? rename(entry as Record<string, unknown>, { t: "topic" })
        : entry,
    );
  }
  // "~" stands for a base topic at the start or end of any topic field.
  const base = typeof expanded["~"] === "string" ? expanded["~"] : undefined;
  if (base !== undefined) {
    const substitute = (fields: Record<string, unknown>) => {
      for (const [field, value] of Object.entries(fields)) {
        if (!(field === "topic" || field.endsWith("_topic")) || typeof value !== "string") continue;
        if (value.startsWith("~")) fields[field] = base + value.slice(1);
        else if (value.endsWith("~")) fields[field] = value.slice(0, -1) + base;
      }
    };
    substitute(expanded);
    for (const entry of Array.isArray(expanded.availability) ? expanded.availability : []) {
      if (entry && typeof entry === "object") substitute(entry as Record<string, unknown>);
    }
  }

  const parsed = configSchema.safeParse(expanded);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return { component, key, objectId, config: parsed.data };
}

/** Extracts a value from a payload. Built by compileTemplate. */
export type Extract = (payload: string) => unknown;

const TEMPLATE = /^\{\{\s*value_json((?:\.[A-Za-z_]\w*|\[\d+\]|\[(?:'[^']*'|"[^"]*")\])+)\s*\}\}$/;

/**
 * Supports only `{{ value_json.<path> }}`. No template means the raw payload.
 * Throws for any other template, so the caller can skip the entity.
 */
export function compileTemplate(template: string | undefined): Extract {
  if (template === undefined) return (payload) => payload;
  const match = TEMPLATE.exec(template.trim());
  if (!match?.[1]) throw new Error(`unsupported template "${template}"`);
  const path = [...match[1].matchAll(/\.(\w+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "",
  );
  return (payload) => {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return undefined;
    }
    for (const segment of path) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
}
