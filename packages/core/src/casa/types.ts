// casa/types.ts
// The language's types, and what fits where. Null and Unavailable fit everywhere: every
// expression is total over them, so the checker never asks a page to guard against them.

import type { Domain } from "../types.ts";

export type Type =
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "duration" }
  | { kind: "time" }
  | { kind: "color" }
  /** A theme value of a non-colour group; `group` narrows it to one (`space`, `border`…). */
  | { kind: "token"; group?: string }
  /** `domain` is known for an entity named in the page, not for one passed as a parameter. */
  | { kind: "entity"; domain?: Domain }
  | { kind: "attribute" }
  | { kind: "area" }
  | { kind: "device" }
  | { kind: "list"; of: Type }
  | { kind: "enum"; members: readonly string[] }
  | { kind: "null" }
  | { kind: "unavailable" }
  | { kind: "event"; params: Type[] }
  | { kind: "now" }
  /** `theme`, `palette`, `surface.card`: a path into the theme, not yet a value. */
  | { kind: "theme"; path: string[] }
  /** `area` and `device`: a table of records by id. */
  | { kind: "lookup"; what: "area" | "device" }
  /** `e.attr`: a record whose fields are only known at run time. */
  | { kind: "record" }
  /** A value whose type is only known at run time: an attribute, a record field. */
  | { kind: "any" }
  | { kind: "union"; of: Type[] }
  /** A built-in's generic, bound by a sibling property. */
  | { kind: "var"; name: string }
  | { kind: "function"; name: string }
  /**
   * A component named as a value, as a `header` slot takes: what a built-in expects lists the
   * parameters it will pass; a component's own type lists what it declares, and which of
   * those have no default.
   */
  | { kind: "component"; params: Record<string, Type>; required?: string[]; name?: string };

export const NUMBER: Type = { kind: "number" };
export const STRING: Type = { kind: "string" };
export const BOOL: Type = { kind: "bool" };
export const DURATION: Type = { kind: "duration" };
export const TIME: Type = { kind: "time" };
export const COLOR: Type = { kind: "color" };
export const ENTITY: Type = { kind: "entity" };
export const ATTRIBUTE: Type = { kind: "attribute" };
export const AREA: Type = { kind: "area" };
export const DEVICE: Type = { kind: "device" };
export const ANY: Type = { kind: "any" };
export const NULL: Type = { kind: "null" };
export const UNAVAILABLE: Type = { kind: "unavailable" };
export const NOW: Type = { kind: "now" };
export const RECORD: Type = { kind: "record" };
export const list = (of: Type): Type => ({ kind: "list", of });
export const enumOf = (...members: string[]): Type => ({ kind: "enum", members });
export const token = (group?: string): Type => ({ kind: "token", group });
export const event = (...params: Type[]): Type => ({ kind: "event", params });
export const union = (...of: Type[]): Type => ({ kind: "union", of });
export const typeVar = (name: string): Type => ({ kind: "var", name });
export const entityOf = (domain: Domain): Type => ({ kind: "entity", domain });
/** A slot for a component that will be given these parameters. */
export const component = (params: Record<string, Type>): Type => ({ kind: "component", params });

export const SCREEN: Type = enumOf("Phone", "Tablet", "Desktop");
export const ON_OFF: Type = enumOf("On", "Off");
export const WEEKDAY: Type = enumOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun");

/** The `value` of an entity, per domain. */
export const DOMAIN_VALUE: Record<Domain, Type> = {
  light: ON_OFF,
  switch: ON_OFF,
  binary_sensor: ON_OFF,
  sensor: NUMBER,
  climate: enumOf("Off", "Heat", "Cool", "Auto"),
  cover: enumOf("Open", "Closed", "Opening", "Closing"),
  lock: enumOf("Locked", "Unlocked"),
  /** When it was last pressed, epoch ms. */
  button: NUMBER,
  weather: enumOf(
    "Clear",
    "ClearNight",
    "PartlyCloudy",
    "PartlyCloudyNight",
    "Cloudy",
    "Overcast",
    "Fog",
    "Haze",
    "Drizzle",
    "Rain",
    "Pouring",
    "Snow",
    "Hail",
    "Thunderstorm",
    "Windy",
    "Tornado",
  ),
};

/** Domains an enum `value` is read from, for resolving `.On` against an entity. */
export const ENTITY_FIELDS: Record<string, (domain?: Domain) => Type> = {
  value: (domain) => (domain ? DOMAIN_VALUE[domain] : ANY),
  available: () => BOOL,
  changedAt: () => NUMBER,
  updatedAt: () => NUMBER,
  name: () => STRING,
  id: () => STRING,
  domain: () => STRING,
  area: () => AREA,
  device: () => DEVICE,
  unit: () => STRING,
  attr: () => RECORD,
  capabilities: () => list(STRING),
};

export const ATTRIBUTE_FIELDS: Record<string, Type> = { value: ANY, available: BOOL };
export const AREA_FIELDS: Record<string, Type> = {
  id: STRING,
  name: STRING,
  /** The icon a person chose for it, `house` otherwise. */
  icon: STRING,
  entities: list(ENTITY),
  devices: list(DEVICE),
};
export const DEVICE_FIELDS: Record<string, Type> = {
  id: STRING,
  name: STRING,
  area: AREA,
  entities: list(ENTITY),
  manufacturer: STRING,
  model: STRING,
  /** The icon a person chose, else its kind's, else its first entity's domain, else `plug`. */
  icon: STRING,
};
export const NOW_FIELDS: Record<string, Type> = {
  time: TIME,
  date: STRING,
  weekday: WEEKDAY,
  ms: NUMBER,
};

export function show(type: Type): string {
  switch (type.kind) {
    case "number":
      return "Number";
    case "string":
      return "String";
    case "bool":
      return "Bool";
    case "duration":
      return "Duration";
    case "time":
      return "Time";
    case "color":
      return "Color";
    case "token":
      return type.group ? `Token<${type.group}>` : "Token";
    case "entity":
      return type.domain ? `Entity<${type.domain}>` : "Entity";
    case "attribute":
      return "Attribute";
    case "area":
      return "Area";
    case "device":
      return "Device";
    case "list":
      return `List<${show(type.of)}>`;
    case "enum":
      return `Enum<${type.members.join(" | ")}>`;
    case "null":
      return "Null";
    case "unavailable":
      return "Unavailable";
    case "event":
      return `Event<${type.params.map(show).join(", ")}>`;
    case "now":
      return "Now";
    case "theme":
      return type.path.length ? type.path.join(".") : "theme";
    case "lookup":
      return type.what === "area" ? "area.<id>" : "device.<id>";
    case "record":
      return "Record";
    case "any":
      return "a value";
    case "union":
      return type.of.map(show).join(" | ");
    case "var":
      return type.name;
    case "function":
      return `function ${type.name}`;
    case "component":
      return type.name
        ? `component ${type.name}`
        : `a component taking ${
            Object.entries(type.params)
              .map(([name, t]) => `${name}: ${show(t)}`)
              .join(", ") || "no parameters"
          }`;
  }
}

const sameMembers = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((m) => b.includes(m));

/** Whether a value of `actual` may stand where `expected` is wanted. */
export function assignable(actual: Type, expected: Type): boolean {
  if (expected.kind === "any" || actual.kind === "any") return true;
  if (actual.kind === "null" || actual.kind === "unavailable") return true;
  if (expected.kind === "union") return expected.of.some((t) => assignable(actual, t));
  if (actual.kind === "union") return actual.of.every((t) => assignable(t, expected));
  if (expected.kind === "var") return true;
  switch (expected.kind) {
    case "list":
      return actual.kind === "list" && assignable(actual.of, expected.of);
    case "enum":
      return (
        actual.kind === "enum" &&
        (sameMembers(actual.members, expected.members) ||
          actual.members.every((m) => expected.members.includes(m)))
      );
    case "entity":
      // An entity whose domain is not known statically (a loop variable, a parameter) is
      // accepted wherever an entity is; the renderer shows a placeholder for a wrong one.
      return (
        actual.kind === "entity" &&
        (expected.domain === undefined ||
          actual.domain === undefined ||
          actual.domain === expected.domain)
      );
    case "token":
      return (
        actual.kind === "token" && (expected.group === undefined || actual.group === expected.group)
      );
    case "event":
      return actual.kind === "event";
    case "theme":
      return actual.kind === "theme";
    case "component":
      return actual.kind === "component" && fitsSlot(actual, expected);
    default:
      return actual.kind === expected.kind;
  }
}

/**
 * Whether a component may stand in a slot: every parameter it declares is one the slot will
 * pass, of a type the slot's value fits, or has a default to fall back on.
 */
export function fitsSlot(
  actual: Extract<Type, { kind: "component" }>,
  slot: Extract<Type, { kind: "component" }>,
): boolean {
  return Object.entries(actual.params).every(([name, type]) => {
    const given = slot.params[name];
    if (given) return assignable(given, type);
    return !(actual.required ?? []).includes(name);
  });
}

/** The type of a value that may be either: the same type, or a union of the two. */
export function join(a: Type, b: Type): Type {
  if (a.kind === "null" || a.kind === "unavailable" || a.kind === "any") return b;
  if (b.kind === "null" || b.kind === "unavailable" || b.kind === "any") return a;
  if (assignable(a, b)) return b;
  if (assignable(b, a)) return a;
  return union(a, b);
}

/** Replaces a built-in's generics with what its siblings bound them to. */
export function substitute(type: Type, bindings: ReadonlyMap<string, Type>): Type {
  switch (type.kind) {
    case "var":
      return bindings.get(type.name) ?? type;
    case "list":
      return list(substitute(type.of, bindings));
    case "event":
      return event(...type.params.map((p) => substitute(p, bindings)));
    case "union":
      return union(...type.of.map((p) => substitute(p, bindings)));
    default:
      return type;
  }
}

export const hasVar = (type: Type): boolean =>
  type.kind === "var" ||
  (type.kind === "list" && hasVar(type.of)) ||
  (type.kind === "event" && type.params.some(hasVar)) ||
  (type.kind === "union" && type.of.some(hasVar));

/** What a comparison with `==` may be made between. */
export const comparable = (type: Type): boolean =>
  [
    "number",
    "string",
    "bool",
    "duration",
    "time",
    "entity",
    "enum",
    "color",
    "token",
    "null",
    "unavailable",
    "any",
    "area",
    "device",
    "attribute",
  ].includes(type.kind) ||
  (type.kind === "union" && type.of.every(comparable));

/** What `<` and its kin may be made between. */
export const ordered = (type: Type): boolean =>
  ["number", "duration", "time", "string", "any", "null", "unavailable"].includes(type.kind);
