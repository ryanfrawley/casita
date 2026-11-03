// casa/eval.ts
// Evaluates a compiled expression over a host. Every read of the house goes through the host,
// which reports it as a dependency, so a caller that collects them knows exactly what to
// watch. Null and Unavailable pass through every operator.

import type { Device, Entity, EntityState, StateRecord } from "../types.ts";
import type { CExpr, CFn } from "./compiled.ts";
import { FUNCTIONS } from "./functions.ts";
import {
  type AreaValue,
  type DeviceValue,
  dep,
  type EntityValue,
  type FnValue,
  type Host,
  isAbsent,
  isArea,
  isAttribute,
  isDevice,
  isEntity,
  isNow,
  isRecord,
  isUnavailable,
  UNAVAILABLE,
  type Value,
} from "./values.ts";

export interface Env {
  host: Host;
  /** Innermost binding wins; a lambda extends the chain. */
  vars: ReadonlyMap<string, Value>;
}

export const withVars = (env: Env, bound: Record<string, Value>): Env => ({
  host: env.host,
  vars: new Map([...env.vars, ...Object.entries(bound)]),
});

const entityValue = (id: string): EntityValue => ({ $: "entity", id });
const areaValue = (id: string): AreaValue => ({ $: "area", id });
const deviceValue = (id: string): DeviceValue => ({ $: "device", id });

// ───────── the house, as values ─────────

const WEATHER_MEMBER: Record<string, string> = {
  clear: "Clear",
  "clear-night": "ClearNight",
  "partly-cloudy": "PartlyCloudy",
  "partly-cloudy-night": "PartlyCloudyNight",
  cloudy: "Cloudy",
  overcast: "Overcast",
  fog: "Fog",
  haze: "Haze",
  drizzle: "Drizzle",
  rain: "Rain",
  pouring: "Pouring",
  snow: "Snow",
  hail: "Hail",
  thunderstorm: "Thunderstorm",
  windy: "Windy",
  tornado: "Tornado",
};

/** The domain's state as one value: `On`, `21.5`, `Locked`. */
export function stateValue(state: EntityState): Value {
  switch (state.domain) {
    case "light":
    case "switch":
    case "binary_sensor":
      return state.on ? "On" : "Off";
    case "sensor":
      return state.value === undefined ? null : state.value;
    case "climate":
      return state.mode.charAt(0).toUpperCase() + state.mode.slice(1);
    case "cover":
      if (state.motion === "opening") return "Opening";
      if (state.motion === "closing") return "Closing";
      return state.position !== undefined && state.position <= 0 ? "Closed" : "Open";
    case "lock":
      return state.locked ? "Locked" : "Unlocked";
    case "button":
      return state.pressedAt ?? null;
    case "weather":
      return WEATHER_MEMBER[state.condition] ?? null;
  }
}

/** The entity's state fields and attributes as one record; state fields win. */
export function attributeFields(record: StateRecord): Record<string, unknown> {
  const { domain: _domain, ...fields } = record.state;
  return { ...(record.attributes ?? {}), ...fields };
}

const effectiveArea = (entity: Entity, host: Host): string | undefined =>
  entity.areaId ??
  (entity.deviceId ? host.devices().find((d) => d.id === entity.deviceId)?.areaId : undefined);

const shown = (entity: Entity) => !entity.hidden && !entity.disabled;

function entityField(e: EntityValue, name: string, host: Host): Value {
  const read = (what: string) => host.onRead?.(what);
  if (name === "id") return e.id;
  if (name === "domain") return e.id.split(".")[0] ?? "";
  if (
    name === "value" ||
    name === "available" ||
    name === "changedAt" ||
    name === "updatedAt" ||
    name === "unit" ||
    name === "attr"
  ) {
    read(dep.state(e.id));
    const record = host.state(e.id);
    if (name === "available") return record?.available === true;
    if (!record?.available) return UNAVAILABLE;
    switch (name) {
      case "value":
        return stateValue(record.state);
      case "changedAt":
        return record.changedAt;
      case "updatedAt":
        return record.updatedAt;
      case "unit":
        return record.state.domain === "sensor" ? (record.state.unit ?? null) : null;
      default:
        return { $: "record", fields: attributeFields(record) };
    }
  }
  read(dep.registry);
  const entity = host.entity(e.id);
  if (!entity) return UNAVAILABLE;
  switch (name) {
    case "name":
      return entity.name;
    case "area": {
      const area = effectiveArea(entity, host);
      return area ? areaValue(area) : null;
    }
    case "device":
      return entity.deviceId ? deviceValue(entity.deviceId) : null;
    case "capabilities":
      return Object.entries(entity.capabilities ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k);
    default:
      return null;
  }
}

function areaField(a: AreaValue, name: string, host: Host): Value {
  host.onRead?.(dep.registry);
  const area = host.areas().find((candidate) => candidate.id === a.id);
  if (!area) return UNAVAILABLE;
  switch (name) {
    case "id":
      return area.id;
    case "name":
      return area.name;
    case "icon":
      return area.icon ?? "house";
    case "entities":
      return host
        .entities()
        .filter((e) => shown(e) && effectiveArea(e, host) === a.id)
        .map((e) => entityValue(e.id));
    case "devices":
      return host
        .devices()
        .filter((d) => d.areaId === a.id)
        .map((d) => deviceValue(d.id));
    default:
      return null;
  }
}

/** The picture of a device's kind, by the integration it came through. */
const DEVICE_ICON: Record<string, string> = {
  rachio: "irrigation",
  teslamate: "car",
  tesla: "car",
  "open-meteo": "cloud-sun",
};

/**
 * What a device is drawn with: the icon a person chose, else its kind's, else its first
 * entity's domain, else a plug. The Devices page and a Casa `device.x.icon` agree on this.
 */
export function deviceIcon(
  device: Pick<Device, "integrationId" | "icon">,
  entities: readonly { domain: string }[],
): string {
  if (device.icon) return device.icon;
  const kind = String(device.integrationId).split(".")[0] ?? "";
  return DEVICE_ICON[kind] ?? entities[0]?.domain ?? "plug";
}

function deviceField(d: DeviceValue, name: string, host: Host): Value {
  host.onRead?.(dep.registry);
  const device = host.devices().find((candidate) => candidate.id === d.id);
  if (!device) return UNAVAILABLE;
  switch (name) {
    case "id":
      return device.id;
    case "name":
      return device.name;
    case "area":
      return device.areaId ? areaValue(device.areaId) : null;
    case "entities":
      return host
        .entities()
        .filter((e) => shown(e) && e.deviceId === d.id)
        .map((e) => entityValue(e.id));
    case "manufacturer":
      return device.manufacturer ?? null;
    case "model":
      return device.model ?? null;
    case "icon":
      return deviceIcon(
        device,
        host.entities().filter((e) => shown(e) && e.deviceId === d.id),
      );
    default:
      return null;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock parts of an instant in a zone. */
export function clock(
  ms: number,
  timezone: string,
): { minutes: number; date: string; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return {
    minutes: hour * 60 + Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAYS.includes(get("weekday")) ? get("weekday") : "Mon",
  };
}

function nowField(name: string, host: Host): Value {
  host.onRead?.(dep.now);
  const ms = host.now();
  if (name === "ms") return ms;
  const parts = clock(ms, host.timezone);
  if (name === "time") return parts.minutes;
  if (name === "date") return parts.date;
  if (name === "weekday") return parts.weekday;
  return null;
}

function attributeField(a: { id: string; name: string }, name: string, host: Host): Value {
  host.onRead?.(dep.state(a.id));
  const record = host.state(a.id);
  if (name === "available") return record?.available === true;
  if (!record?.available) return UNAVAILABLE;
  const value = attributeFields(record)[a.name];
  return value === undefined ? UNAVAILABLE : (value as Value);
}

// ───────── operators ─────────

export function equal(a: Value, b: Value): boolean {
  if (isEntity(a) && isEntity(b)) return a.id === b.id;
  if (isArea(a) && isArea(b)) return a.id === b.id;
  if (isDevice(a) && isDevice(b)) return a.id === b.id;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i] as Value));
  return a === b;
}

function binary(op: string, a: Value, b: Value): Value {
  if (op === "==" || op === "!=") {
    if (isUnavailable(a) || isUnavailable(b)) return UNAVAILABLE;
    const same = equal(a, b);
    return op === "==" ? same : !same;
  }
  if (isUnavailable(a) || isUnavailable(b)) return UNAVAILABLE;
  if (op === "+" && (typeof a === "string" || typeof b === "string")) {
    return `${a === null ? "" : String(a)}${b === null ? "" : String(b)}`;
  }
  if (a === null || b === null) return null;
  const x = a as number;
  const y = b as number;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    case "%":
      return y === 0 ? null : x % y;
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    default:
      return null;
  }
}

// ───────── evaluation ─────────

export function evaluate(expr: CExpr, env: Env): Value {
  const { host } = env;
  switch (expr[0]) {
    case "lit":
      return expr[1];
    case "entity":
      return entityValue(expr[1]);
    case "attr":
      return { $: "attr", id: expr[1], name: expr[2] };
    case "var": {
      host.onRead?.(dep.var(expr[1]));
      const value = env.vars.get(expr[1]);
      return value === undefined ? null : value;
    }
    case "global":
      switch (expr[1]) {
        case "entities":
          host.onRead?.(dep.registry);
          return host
            .entities()
            .filter(shown)
            .map((e) => entityValue(e.id));
        case "areas":
          host.onRead?.(dep.registry);
          return host.areas().map((a) => areaValue(a.id));
        case "devices":
          host.onRead?.(dep.registry);
          return host.devices().map((d) => deviceValue(d.id));
        case "screen":
          host.onRead?.(dep.screen);
          return host.screen();
        case "now":
          return { $: "now" };
        default:
          return null;
      }
    case "lookup":
      return expr[1] === "area" ? areaValue(expr[2]) : deviceValue(expr[2]);
    case "theme":
      return expr[1];
    case "member":
      return expr[1];
    case "list":
      return expr.slice(1).map((item) => evaluate(item as CExpr, env));
    case "get": {
      const object = evaluate(expr[1], env);
      const name = expr[2];
      if (isAbsent(object)) return object;
      if (isEntity(object)) return entityField(object, name, host);
      if (isAttribute(object)) return attributeField(object, name, host);
      if (isArea(object)) return areaField(object, name, host);
      if (isDevice(object)) return deviceField(object, name, host);
      if (isNow(object)) return nowField(name, host);
      if (isRecord(object)) {
        const value = object.fields[name];
        return value === undefined ? UNAVAILABLE : (value as Value);
      }
      return null;
    }
    case "index": {
      const object = evaluate(expr[1], env);
      const index = evaluate(expr[2], env);
      if (isAbsent(object)) return object;
      if (!Array.isArray(object) || typeof index !== "number") return null;
      return object[index] ?? null;
    }
    case "call": {
      const spec = FUNCTIONS[expr[1]];
      if (!spec) return null;
      const args = expr
        .slice(2)
        .map((arg) => (arg[0] === "fn" ? closure(arg as CFn, env) : evaluate(arg as CExpr, env)));
      return spec.run(args, host);
    }
    case "un": {
      const operand = evaluate(expr[2], env);
      if (isAbsent(operand)) return operand;
      return expr[1] === "!" ? operand !== true : -(operand as number);
    }
    case "bin": {
      const op = expr[1];
      const left = evaluate(expr[2], env);
      if (op === "??") return isAbsent(left) ? evaluate(expr[3], env) : left;
      if (op === "&&") {
        if (isUnavailable(left)) return left;
        return left === true ? evaluate(expr[3], env) : false;
      }
      if (op === "||") {
        if (isUnavailable(left)) return left;
        return left === true ? true : evaluate(expr[3], env);
      }
      return binary(op, left, evaluate(expr[3], env));
    }
    case "if": {
      const test = evaluate(expr[1], env);
      if (isUnavailable(test)) return test;
      return test === true ? evaluate(expr[2], env) : evaluate(expr[3], env);
    }
  }
}

function closure(fn: CFn, env: Env): FnValue {
  const [, params, body] = fn;
  return {
    $: "fn",
    params,
    call: (args) => {
      const bound: Record<string, Value> = {};
      params.forEach((name, i) => {
        bound[name] = args[i] ?? null;
      });
      return evaluate(body, withVars(env, bound));
    },
  };
}

/** Evaluates and collects what was read, for a subscription. */
export function evaluateWithDeps(expr: CExpr, env: Env): { value: Value; deps: Set<string> } {
  const deps = new Set<string>();
  return { value: evaluate(expr, { host: tracking(env.host, deps), vars: env.vars }), deps };
}

/** The same host, reporting every read into `deps` as well as to its own `onRead`. */
export function tracking(host: Host, deps: Set<string>): Host {
  const inner = host.onRead;
  return Object.create(host, {
    onRead: {
      value: (d: string) => {
        deps.add(d);
        inner?.call(host, d);
      },
    },
  }) as Host;
}
