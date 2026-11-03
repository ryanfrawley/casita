// Forms drawn from a JSON Schema, for integration actions; and how config is shown and typed.
// Pure, so the rules can be tested without a browser.

export type FieldKind = "text" | "number" | "boolean" | "select" | "json";

export interface Field {
  name: string;
  kind: FieldKind;
  required: boolean;
  /** For `select`. */
  options?: string[];
  description?: string;
  /** What the form starts with, as the control holds it. */
  initial: string | boolean;
  integer?: boolean;
  min?: number;
  max?: number;
  /** This one field stands for the whole parameter object: the schema was not a set of properties. */
  whole?: boolean;
  /** The integration marked it `scan: "qr"`: a camera can fill it. */
  scan?: "qr";
}

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fieldFor(name: string, schema: Schema, required: boolean): Field {
  const base = {
    name,
    required,
    description: typeof schema.description === "string" ? schema.description : undefined,
  };
  const given = schema.default;
  if (Array.isArray(schema.enum) && schema.enum.every((option) => typeof option === "string")) {
    const options = schema.enum as string[];
    return { ...base, kind: "select", options, initial: typeof given === "string" ? given : "" };
  }
  if (schema.type === "boolean") return { ...base, kind: "boolean", initial: given === true };
  if (schema.type === "number" || schema.type === "integer") {
    return {
      ...base,
      kind: "number",
      integer: schema.type === "integer",
      min: typeof schema.minimum === "number" ? schema.minimum : undefined,
      max: typeof schema.maximum === "number" ? schema.maximum : undefined,
      initial: typeof given === "number" ? String(given) : "",
    };
  }
  if (schema.type === "string") {
    return {
      ...base,
      kind: "text",
      initial: typeof given === "string" ? given : "",
      ...(schema.scan === "qr" ? { scan: "qr" } : {}),
    };
  }
  // Arrays, nested objects, unions: typed as JSON rather than guessed at.
  return { ...base, kind: "json", initial: given === undefined ? "" : JSON.stringify(given) };
}

/**
 * The fields an action's parameters need. A schema that is not a plain object of properties
 * becomes one JSON field named `params`, so nothing an integration defines is unreachable.
 */
export function schemaFields(schema: unknown): Field[] {
  if (!isObject(schema)) return [];
  if (schema.type !== "object" || !isObject(schema.properties)) {
    return Object.keys(schema).length
      ? [{ name: "params", kind: "json", required: false, initial: "", whole: true }]
      : [];
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(schema.properties).map(([name, property]) =>
    fieldFor(name, isObject(property) ? property : {}, required.has(name)),
  );
}

export type Values = Record<string, string | boolean>;

export const initialValues = (fields: Field[]): Values =>
  Object.fromEntries(fields.map((field) => [field.name, field.initial]));

/** The parameters a filled form stands for, or what is wrong with it, by field. */
export function formParams(
  fields: Field[],
  values: Values,
): { params: Record<string, unknown>; errors: Record<string, string> } {
  const params: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name] ?? field.initial;
    if (field.kind === "boolean") {
      params[field.name] = value === true;
      continue;
    }
    const text = String(value).trim();
    if (text === "") {
      if (field.required) errors[field.name] = "This is needed.";
      continue;
    }
    if (field.kind === "number") {
      const number = Number(text);
      if (!Number.isFinite(number)) errors[field.name] = "A number.";
      else if (field.integer && !Number.isInteger(number)) errors[field.name] = "A whole number.";
      else if (field.min !== undefined && number < field.min) {
        errors[field.name] = `At least ${field.min}.`;
      } else if (field.max !== undefined && number > field.max) {
        errors[field.name] = `At most ${field.max}.`;
      } else params[field.name] = number;
    } else if (field.kind === "json") {
      try {
        params[field.name] = JSON.parse(text);
      } catch {
        errors[field.name] = "This isn't valid JSON.";
      }
    } else params[field.name] = text;
  }
  // A schema that was not an object of properties: its one field is the whole parameter.
  const [only] = fields;
  if (only?.whole && only.name in params) {
    const whole = params[only.name];
    return { params: isObject(whole) ? whole : { params: whole }, errors };
  }
  return { params, errors };
}

// Words that are initialisms when they stand alone in a parameter name.
const INITIALISMS = new Set(["pin", "qr", "dsk", "id", "nvm", "url", "api", "mqtt", "ieee", "rf"]);

/** "permit_join" → "Permit join", "nodeId" → "Node ID", "timeoutSec" → "Timeout sec" */
export const actionLabel = (name: string): string => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (INITIALISMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  const label = words.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

// ───────── config ─────────

const SECRET = /token|secret|password|key/i;

/** Config as it is safe to leave on a screen: anything named like a credential is covered. */
export function redacted(value: unknown, name = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redacted(item, name));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redacted(inner, key)]),
    );
  }
  return SECRET.test(name) && typeof value === "string" && value !== "" ? "••••••••" : value;
}

/** What someone typed as a config value: JSON if it parses, else the text itself. */
export function typedValue(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** "3d 4h", "2h 5m", "12 min": how long the server has been up. */
export function uptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A device setting a person can type into: a number, or text. */
export interface TypedSetting {
  label: string;
  type: "number" | "boolean" | "enum" | "string";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: number | string; label: string }[];
}

/**
 * What a typed setting's field holds, as the value to send, or why it can't be sent. The
 * server checks again; this is so the field can say so before anything is sent.
 */
export function settingInput(
  setting: TypedSetting,
  text: string,
): { value: number | string } | { error: string } {
  const typed = text.trim();
  if (setting.type === "string") return { value: text };
  if (!typed) return { error: "A number." };
  const named = setting.options?.find((o) => o.label.toLowerCase() === typed.toLowerCase());
  const value = named ? Number(named.value) : Number(typed);
  if (!Number.isFinite(value)) return { error: "A number." };
  if (setting.min !== undefined && value < setting.min)
    return { error: `At least ${setting.min}.` };
  if (setting.max !== undefined && value > setting.max) return { error: `At most ${setting.max}.` };
  const step = setting.step ?? 1;
  const steps = (value - (setting.min ?? 0)) / step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9)
    return { error: step === 1 ? "A whole number." : `In steps of ${step}.` };
  return { value };
}

/** The hint under a number setting: its range and the values it names. */
export function settingHint(setting: TypedSetting & { unit?: string }): string | undefined {
  const range =
    setting.min !== undefined && setting.max !== undefined
      ? `${setting.min} to ${setting.max}${setting.unit ? ` ${setting.unit}` : ""}`
      : undefined;
  const named = setting.options?.map((o) => `${o.value} ${o.label}`).join(" · ");
  return [range, named].filter(Boolean).join(". ") || undefined;
}
