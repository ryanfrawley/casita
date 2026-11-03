// How an entity's state reads to a person: "On · 40%", "Jammed", "Clear · 4 min".
// Shared by the CLI and the web app; how the words are colored is each one's own business.

import { degrees, degreeUnit, inUnits } from "./units.ts";

export type Row = Record<string, unknown>;
export type Tone = "on" | "good" | "warn" | "pending" | "plain" | "muted";

export interface Shown {
  text: string;
  tone: Tone;
  /** 0 to 1, for entities with a level worth a bar: brightness, position. */
  level?: number;
  /** Set when the entity is unavailable: how its last known state read. */
  was?: string;
}

/** A level that is neither off nor full reads between 1% and 99%, never rounded onto either end. */
const percent = (fraction: number) =>
  `${fraction > 0 && fraction < 1 ? Math.min(99, Math.max(1, Math.round(fraction * 100))) : Math.round(fraction * 100)}%`;

/** "1,140", "21.5": grouped thousands, at most one decimal. */
export function formatNumber(value: number): string {
  // signDisplay keeps a value that rounds to zero from reading "-0".
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    signDisplay: "negative",
  }).format(value);
}

/** "Pressed 4 min ago", "Pressed just now", or "Pressed at 8:42 pm" once `since` gives a clock time. */
const pressed = (when: string) =>
  when === "just now"
    ? "Pressed just now"
    : /[ap]m$/.test(when)
      ? `Pressed at ${when}`
      : `Pressed ${when} ago`;

/** "7:42 pm" */
export function clock(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
    .format(ms)
    .toLowerCase()
    .replace(/\s/g, " "); // Intl puts a narrow no-break space before am/pm
}

/** "just now", "4 min", "2 h", or a clock time once it is more than a few hours back. */
export function since(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 6 * 60) return `${Math.floor(minutes / 60)} h`;
  return clock(ms);
}

/** How long ago, for things that can be days back: "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago". */
export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const BINARY: Record<string, [on: string, off: string, alarming: boolean]> = {
  motion: ["Motion", "Clear", false],
  occupancy: ["Occupied", "Clear", false],
  door: ["Open", "Closed", false],
  window: ["Open", "Closed", false],
  leak: ["Wet", "Dry", true],
  smoke: ["Smoke", "Clear", true],
};

/**
 * What a binary sensor's two states are called, by its device class: a door is open or
 * closed, a leak sensor wet or dry. `alarming` says that "on" is bad news. One place, so the
 * row, the history and the CLI chart agree; a class nobody knows reads on or off.
 */
export function binaryWords(deviceClass: unknown): { on: string; off: string; alarming: boolean } {
  const [on, off, alarming] = BINARY[String(deviceClass)] ?? ["On", "Off", false];
  return { on, off, alarming };
}

const WEATHER: Record<string, string> = {
  clear: "Clear",
  "clear-night": "Clear",
  "partly-cloudy": "Partly cloudy",
  "partly-cloudy-night": "Partly cloudy",
  cloudy: "Cloudy",
  overcast: "Overcast",
  fog: "Fog",
  haze: "Haze",
  drizzle: "Drizzle",
  rain: "Rain",
  pouring: "Heavy rain",
  snow: "Snow",
  hail: "Hail",
  thunderstorm: "Thunderstorm",
  windy: "Windy",
  tornado: "Tornado",
};

/** A weather condition in words; one this list does not know reads as its own name. */
export const weatherWord = (condition: string): string =>
  Object.hasOwn(WEATHER, condition) ? (WEATHER[condition] ?? condition) : condition;

/** The state as it should read, given the entity and its state record. */
export function present(record: Row | undefined, now = Date.now()): Shown {
  if (!record) return { text: "No state yet", tone: "muted" };
  const state = record.state as Row;
  if (record.available === false) {
    const was = present({ ...record, available: true }, now).text;
    return { text: "Unavailable", tone: "muted", was };
  }
  switch (state.domain) {
    case "light": {
      if (!state.on) return { text: "Off", tone: "muted" };
      const level = typeof state.brightness === "number" ? state.brightness : undefined;
      return { text: level === undefined ? "On" : `On · ${percent(level)}`, tone: "on", level };
    }
    case "switch":
      return state.on ? { text: "On", tone: "on" } : { text: "Off", tone: "muted" };
    case "cover": {
      if (state.motion === "opening") return { text: "Opening…", tone: "pending" };
      if (state.motion === "closing") return { text: "Closing…", tone: "pending" };
      const position = typeof state.position === "number" ? state.position : undefined;
      if (position === undefined) return { text: "Stopped", tone: "plain" };
      if (position <= 0) return { text: "Closed", tone: "muted" };
      if (position >= 1) return { text: "Open", tone: "on" };
      return { text: `${percent(position)} open`, tone: "on", level: position };
    }
    case "lock":
      if (state.jammed) return { text: "Jammed", tone: "warn" };
      return state.locked ? { text: "Locked", tone: "good" } : { text: "Unlocked", tone: "plain" };
    case "sensor": {
      if (state.value === null || state.value === undefined || state.value === "") {
        return { text: "Unknown", tone: "muted" };
      }
      // A word says when it became so, as a binary sensor's does; a number is a reading. A
      // word that names a moment (a sunrise's "7:29 am", with the moment as `at`) is its own time.
      if (typeof state.value !== "number") {
        const value = String(state.value);
        const moment = typeof (record.attributes as Row | undefined)?.at === "number";
        const changed =
          typeof record.changedAt === "number" && !moment
            ? ` · ${since(record.changedAt, now)}`
            : "";
        const text = state.unit ? `${value} ${state.unit}` : value;
        return { text: `${text}${changed}`, tone: "plain" };
      }
      const shown = inUnits(state.value, typeof state.unit === "string" ? state.unit : "");
      const value = formatNumber(shown.value);
      return { text: shown.unit ? `${value} ${shown.unit}` : value, tone: "plain" };
    }
    case "binary_sensor": {
      const { on, off, alarming } = binaryWords(state.deviceClass);
      const changed =
        typeof record.changedAt === "number" ? ` · ${since(record.changedAt, now)}` : "";
      if (state.on) return { text: `${on}${changed}`, tone: alarming ? "warn" : "on" };
      return { text: `${off}${changed}`, tone: "muted" };
    }
    case "climate": {
      const current =
        typeof state.currentTemp === "number"
          ? `${formatNumber(degrees(state.currentTemp))}${degreeUnit()} · `
          : "";
      const target =
        typeof state.targetTemp === "number"
          ? ` → ${formatNumber(degrees(state.targetTemp))}°`
          : "";
      return {
        text: `${current}${state.mode}${target}`,
        tone: state.mode === "off" ? "muted" : "on",
      };
    }
    case "button":
      return typeof state.pressedAt === "number"
        ? { text: pressed(since(state.pressedAt, now)), tone: "plain" }
        : { text: "Ready", tone: "muted" };
    case "weather": {
      const temperature =
        typeof state.temperature === "number"
          ? ` · ${formatNumber(degrees(state.temperature))}${degreeUnit()}`
          : "";
      return { text: `${weatherWord(String(state.condition))}${temperature}`, tone: "plain" };
    }
    default:
      return { text: JSON.stringify(state), tone: "plain" };
  }
}

// ───────── vehicles ─────────

export interface Car {
  name: string;
  model?: string;
  battery?: number; // percent
  range?: number;
  rangeUnit: string;
  limit?: number; // percent
  charging: boolean;
  pluggedIn?: boolean;
  powerKw?: number;
  hoursToFull?: number;
  energyAdded?: number; // kWh
  /** TeslaMate's word for what the car is doing: online, asleep, driving, charging, offline. */
  state?: string;
  place?: string;
}

/** uniqueId suffix → field, for each integration that provides a car. */
const CAR_FIELDS: Record<string, Record<string, string>> = {
  teslamate: {
    battery_level: "battery",
    rated_battery_range_km: "range",
    charge_limit_soc: "limit",
    charger_power: "powerKw",
    time_to_full_charge: "hoursToFull",
    charge_energy_added: "energyAdded",
    plugged_in: "pluggedIn",
    state: "state",
    geofence: "place",
  },
  tesla: {
    battery: "battery",
    range: "range",
    "charge-limit": "limit",
    "charger-power": "powerKw",
    "time-to-full": "minutesToFull",
    "plugged-in": "pluggedIn",
    charging: "charging",
  },
};

/** The vehicles among the entities, read from the integrations that provide them. */
export function carsFrom(entities: Row[], devices: Row[], states: Map<string, Row>): Car[] {
  const cars: Car[] = [];
  for (const device of devices) {
    const kind = String(device.integrationId).split(".")[0] ?? "";
    const fields = CAR_FIELDS[kind];
    if (!fields) continue;
    const raw: Row = {};
    const matched = new Map<string, number>();
    for (const entity of entities) {
      if (entity.deviceId !== device.id) continue;
      const suffix = Object.keys(fields)
        .sort((a, b) => b.length - a.length)
        .find((key) => String(entity.uniqueId).endsWith(`-${key}`));
      const record = states.get(String(entity.id));
      const state = record?.state as Row | undefined;
      if (!suffix || !state) continue;
      // Of several ids ending in the same key ("battery", "climate-battery"), the shortest is the key itself.
      const field = fields[suffix] ?? suffix;
      const length = String(entity.uniqueId).length;
      if (length >= (matched.get(field) ?? Number.POSITIVE_INFINITY)) continue;
      matched.set(field, length);
      raw[field] = state.value ?? state.on ?? state.locked;
    }
    const n = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : undefined);
    const state = typeof raw.state === "string" ? raw.state : undefined;
    const minutes = n("minutesToFull");
    cars.push({
      name: String(device.name),
      model: typeof device.model === "string" ? device.model : undefined,
      battery: n("battery"),
      range: n("range"),
      rangeUnit: kind === "tesla" ? "mi" : "km",
      limit: n("limit"),
      charging: raw.charging === true || state === "charging",
      pluggedIn: typeof raw.pluggedIn === "boolean" ? raw.pluggedIn : undefined,
      powerKw: n("powerKw"),
      hoursToFull: n("hoursToFull") ?? (minutes === undefined ? undefined : minutes / 60),
      energyAdded: n("energyAdded"),
      state,
      place: typeof raw.place === "string" && raw.place !== "away" ? raw.place : undefined,
    });
  }
  return cars;
}
