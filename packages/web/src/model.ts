// From what the server said to what a screen shows: rows, a room's facts, the weather, the
// lists. All of it pure, as the CLI dashboard's layout is, so it can be tested without a browser.

import type { RequestParams } from "@casita/api/schema";
import {
  binaryWords,
  clock,
  degrees,
  degreeUnit,
  formatNumber,
  inUnits,
  present,
  type Row,
  weatherWord,
} from "@casita/client";
import { BINARY_SENSOR_CLASSES, deviceIcon, SENSOR_CLASSES } from "@casita/core/casa";
import { type ForecastDay, type ForecastProps, formatDuration, WEATHER_ICON } from "@casita/ui";
import type { Command, House } from "./store.ts";

export type RowState = "on" | "off" | "pending" | "unavailable";

/** One entity as a row or tile shows it. */
export interface EntityView {
  id: string;
  name: string;
  domain: string;
  /** A chosen icon, or a device kind when the domain's own icon is not the right picture. */
  icon?: string;
  /** The device-confirmed state, or `pending` while a command is in flight. */
  state: RowState;
  summary: string;
  /** `read`: shown with no control and "View only". */
  level: "control" | "read";
  available: boolean;
  /** 0 to 1, for a light that dims. */
  brightness?: number;
  dims: boolean;
  record?: Row;
  entity: Row;
}

const kindOf = (thing: Row) => String(thing.integrationId).split(".")[0] ?? "";
const stateOf = (record: Row | undefined) => (record?.state ?? {}) as Row;

/** The sky's own picture; a condition the map does not know, or none yet, is a plain cloud. */
const weatherIcon = (condition: unknown): string =>
  typeof condition === "string" && Object.hasOwn(WEATHER_ICON, condition)
    ? WEATHER_ICON[condition as keyof typeof WEATHER_ICON]
    : "cloud";

/** Sensors report; they are never "on" the way a light is. */
const LIT = new Set(["light", "switch", "cover"]);
/** Domains that take commands at all. */
const COMMANDED = new Set(["light", "switch", "cover", "lock", "climate", "button"]);

/** What an entity is drawn with when no icon was chosen for it; undefined means its domain's. */
export function defaultEntityIcon(entity: Row, state: Row = {}): string | undefined {
  const domain = String(entity.domain);
  if (kindOf(entity) === "rachio" && domain === "switch") return "valve";
  if (domain === "weather") return weatherIcon(state.condition);
  return undefined;
}

export function entityView(house: House, entity: Row, now = Date.now()): EntityView {
  const id = String(entity.id);
  const domain = String(entity.domain);
  const record = house.states.get(id);
  const state = stateOf(record);
  const shown = present(record, now);
  const waiting = house.pending.get(id);
  const available = record?.available !== false && record !== undefined;
  const canControl =
    entity.level === "control" && entity.controllable === true && COMMANDED.has(domain);
  return {
    id,
    name: String(entity.name),
    domain,
    icon: typeof entity.icon === "string" ? entity.icon : defaultEntityIcon(entity, state),
    state: waiting
      ? "pending"
      : !available
        ? "unavailable"
        : shown.tone === "on" && LIT.has(domain)
          ? "on"
          : "off",
    summary: waiting ?? (shown.was === undefined ? shown.text : `Unavailable · was ${shown.was}`),
    // A sensor is read by its nature; saying "View only" of it would be noise.
    level: canControl || !COMMANDED.has(domain) ? "control" : "read",
    available,
    brightness: typeof state.brightness === "number" ? state.brightness : undefined,
    dims: (entity.capabilities as Row | undefined)?.brightness === true,
    record,
    entity,
  };
}

/** Whether the row gets a control: the viewer may, the entity can, and the device is there. */
export const controllable = (view: EntityView): boolean =>
  view.level === "control" && COMMANDED.has(view.domain) && view.available;

// ───────── commands ─────────

export interface Intent {
  command: Command;
  /** What the row reads while the device has not yet confirmed. */
  waiting: string;
}

export const intents = {
  power: (view: EntityView, on: boolean): Intent => ({
    command: { domain: view.domain as "switch", action: on ? "turn_on" : "turn_off" },
    waiting: on ? "Turning on…" : "Turning off…",
  }),
  brightness: (percent: number): Intent => ({
    command:
      percent <= 0
        ? { domain: "light", action: "turn_off" }
        : { domain: "light", action: "turn_on", brightness: percent / 100 },
    waiting: percent <= 0 ? "Turning off…" : `Setting ${percent}%…`,
  }),
  lock: (locked: boolean): Intent => ({
    command: { domain: "lock", action: locked ? "lock" : "unlock" },
    waiting: locked ? "Locking…" : "Unlocking…",
  }),
  cover: (action: "open" | "close" | "stop"): Intent => ({
    command: { domain: "cover", action },
    waiting: action === "open" ? "Opening…" : action === "close" ? "Closing…" : "Stopping…",
  }),
  press: (): Intent => ({ command: { domain: "button", action: "press" }, waiting: "Pressing…" }),
  target: (celsius: number, shown: string): Intent => ({
    command: { domain: "climate", action: "set_target", temp: celsius },
    waiting: `Setting ${shown}…`,
  }),
  mode: (mode: string): Intent => ({
    command: { domain: "climate", action: "set_mode", mode: mode as "heat" },
    waiting: `Switching to ${mode}…`,
  }),
};

/** One entity as a ButtonGroup segment shows it, and what pressing it sends. */
export interface Segment {
  /** On, or open: what the device last said, never what was asked of it. */
  active: boolean;
  /** A command is in flight, or a door is moving. */
  pending: boolean;
  disabled: boolean;
  intent?: Intent;
  /** Set, the press must be confirmed: a door moves where no one may be looking. */
  confirm?: string;
}

/**
 * A segment for an entity: a light or switch toggles, a button presses, a cover opens or
 * closes once confirmed, and stops at once while it moves. Anything else is drawn, disabled.
 */
export function segmentOf(view: EntityView): Segment {
  const state = stateOf(view.record);
  const inFlight = view.state === "pending";
  const disabled = inFlight || !controllable(view);
  switch (view.domain) {
    case "light":
    case "switch": {
      const on = state.on === true;
      return { active: on, pending: inFlight, disabled, intent: intents.power(view, !on) };
    }
    case "button":
      return { active: false, pending: inFlight, disabled, intent: intents.press() };
    case "cover": {
      const open = typeof state.position === "number" && state.position > 0;
      if (state.motion === "opening" || state.motion === "closing") {
        return { active: open, pending: true, disabled, intent: intents.cover("stop") };
      }
      const closed = typeof state.position === "number" && state.position <= 0;
      return {
        active: open,
        pending: inFlight,
        disabled,
        intent: intents.cover(closed ? "open" : "close"),
        confirm: closed ? "Open?" : "Close?",
      };
    }
    default:
      return { active: false, pending: inFlight, disabled: true };
  }
}

// ───────── rooms ─────────

export interface Fact {
  label: string;
  icon?: string;
  tone?: "on" | "alert" | "ok" | "unavailable";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The chips under a room's name: lights on, covers open, locks, and what is unreachable. */
export function facts(views: EntityView[]): Fact[] {
  const out: Fact[] = [];
  const of = (domain: string) => views.filter((view) => view.domain === domain);
  const lights = of("light");
  const on = lights.filter((view) => view.state === "on").length;
  if (lights.length) out.push({ label: `${plural(on, "light")} on`, tone: on ? "on" : undefined });
  const covers = of("cover");
  const open = covers.filter((view) => view.state === "on").length;
  if (covers.length) {
    out.push({ label: `${open} of ${covers.length} open`, tone: open ? "on" : undefined });
  }
  // Only what a lock has confirmed counts: one that is unreachable is neither locked nor not.
  const locks = of("lock").filter((view) => view.available);
  if (locks.length) {
    const states = locks.map((view) => stateOf(view.record));
    const jammed = states.filter((state) => state.jammed).length;
    const unlocked = states.filter((state) => !state.locked && !state.jammed).length;
    out.push(
      jammed
        ? { label: `${plural(jammed, "lock")} jammed`, tone: "alert" }
        : unlocked
          ? { label: `${unlocked} unlocked`, icon: "lock-open" }
          : { label: locks.length === 1 ? "Locked" : "All locked", tone: "ok" },
    );
  }
  // A device is unreachable when none of its entities in the room is reporting.
  const byDevice = new Map<string, EntityView[]>();
  for (const view of views) {
    const deviceId = view.entity.deviceId;
    if (typeof deviceId !== "string") continue;
    byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), view]);
  }
  const gone = [...byDevice.values()].filter((rows) => rows.every((row) => !row.available)).length;
  if (gone) out.push({ label: `${plural(gone, "device")} unavailable`, tone: "unavailable" });
  return out;
}

/** What a device is drawn with when no icon was chosen: its kind's, else its first entity's. */
export const defaultDeviceIcon = (device: Row, rows: { domain: string }[]): string =>
  deviceIcon({ integrationId: String(device.integrationId) }, rows);

/** The words for an attribute's value, whatever the integration put there. */
export function attributeText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > ATTRIBUTE_TEXT_MAX ? `${text.slice(0, ATTRIBUTE_TEXT_MAX - 1)}…` : text;
}

/** How long an attribute may read before it is cut; a forecast is not a card reading. */
const ATTRIBUTE_TEXT_MAX = 80;

// ───────── weather ─────────

export interface ForecastView extends Pick<ForecastProps, "current" | "days" | "unit"> {
  entityId: string;
  title: string;
  /** Who the data is from; the integration's README says where this has to be shown. */
  attribution?: string;
  /** The weather beside the greeting: "53" "°F outside", "Overcast · Feels 49° · H 63° L 51°". */
  outside?: { temperature: string; unit: string; icon: string; line: string };
  /** Rain or snow under way or on its way, for a badge: "Rain until 11 pm". */
  rain?: string;
}

const HOUR_MS = 3_600_000;
/** "11 pm", "6:30 am" */
const hourOf = (ms: number) => clock(ms).replace(":00", "");

/**
 * What is falling or about to, from the hourly forecast. An hour's `at` is when it ends, and
 * its precipitation is what falls in the hour before. Nothing when the next twelve hours are dry.
 */
export function rainNote(hourly: unknown, now: number): string | undefined {
  const ahead = (Array.isArray(hourly) ? (hourly as Row[]) : [])
    .filter((hour) => typeof hour.at === "number" && hour.at > now)
    .slice(0, 24);
  const wet = (hour: Row) => typeof hour.precipitation === "number" && hour.precipitation >= 0.1;
  const kind = (hour: Row) => (hour.condition === "snow" ? "Snow" : "Rain");
  const first = ahead[0];
  if (!first) return undefined;
  if (wet(first)) {
    const dry = ahead.find((hour) => !wet(hour));
    return dry
      ? `${kind(first)} until ${hourOf(Number(dry.at) - HOUR_MS)}`
      : `${kind(first)} all day`;
  }
  const next = ahead.slice(0, 12).find(wet);
  return next && `${kind(next)} from ${hourOf(Number(next.at) - HOUR_MS)}`;
}

export interface SunPathView {
  /** Sunrise and sunset as clock words, in the house's zone: "7:29 am". */
  rise: string;
  set: string;
  /** The house's day, midnight to midnight, in ms: 23 or 25 hours when the clocks change. */
  dayStart: number;
  dayEnd: number;
  /** Sunrise, sunset and now, in ms. */
  riseAt: number;
  setAt: number;
  now: number;
  /** Where the forecast is for, when the weather says. */
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  /** What the sun does next: "Sunset in 2h 10m", "Sunrise in 11h 54m". */
  headline: string;
  /** "10h 46m of daylight". */
  detail: string;
}

/** A formatter for the house's zone; the browser's own when the zone is unknown. */
function formatterIn(timeZone: unknown, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: typeof timeZone === "string" ? timeZone : undefined,
    });
  } catch {
    return new Intl.DateTimeFormat("en-US", options);
  }
}

/** The moment a date's midnight comes in a zone, found from the zone's offset around it. */
export function midnightIn(date: string, timeZone: unknown): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wall = formatterIn(timeZone, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  // How far the zone's clock is ahead of UTC at a moment.
  const offset = (at: number) => {
    const p = Object.fromEntries(wall.formatToParts(at).map((part) => [part.type, part.value]));
    const n = (key: string) => Number(p[key]);
    const shown = Date.UTC(
      n("year"),
      n("month") - 1,
      n("day"),
      n("hour"),
      n("minute"),
      n("second"),
    );
    return shown - Math.floor(at / 1000) * 1000;
  };
  const guess = Date.UTC(year, month - 1, day);
  // Twice, so a midnight on the far side of a change of clocks finds its own offset.
  const first = guess - offset(guess);
  const midnight = guess - offset(first);
  // Where the clocks spring forward at midnight it never comes: the date begins at the jump,
  // found by halving the hours after the eve's last moment.
  if (dateIn(timeZone, midnight) === date) return midnight;
  let before = midnight;
  let after = midnight + 3 * 60 * 60 * 1000;
  while (after - before > 1000) {
    const middle = Math.floor((before + after) / 2);
    if (dateIn(timeZone, middle) === date) after = middle;
    else before = middle;
  }
  return Math.floor(after / 60_000) * 60_000;
}

/** The day after a date: "2026-10-06" for "2026-10-05". */
const nextDate = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
};

/**
 * The sun's day from a weather entity's daily forecast, on the house's clock: today, midnight
 * to midnight, its sunrise and sunset, where the house is, and what the sun does next (after
 * sunset, tomorrow's sunrise).
 */
export function sunPathView(record: Row | undefined, now = Date.now()): SunPathView | undefined {
  if (!record || record.available === false) return undefined;
  const attributes = (record.attributes ?? {}) as Row;
  const days = (Array.isArray(attributes.daily) ? (attributes.daily as Row[]) : []).flatMap(
    (day) =>
      typeof day.sunrise === "number" && typeof day.sunset === "number" && day.sunrise < day.sunset
        ? [{ date: String(day.date), rise: day.sunrise, set: day.sunset }]
        : [],
  );
  const zone = attributes.timeZone;
  const today = dateIn(zone, now);
  const day = days.find((d) => d.date === today);
  if (!day) return undefined;
  const clock = formatterIn(zone, { hour: "numeric", minute: "2-digit" });
  const words = (at: number) => clock.format(at).toLowerCase().replace(/\s/g, " ");
  // Tomorrow by its date, not the next day listed: a gap in the forecast is not tomorrow.
  const tomorrow = days.find((d) => d.date === nextDate(today));
  const headline =
    now < day.rise
      ? `Sunrise in ${formatDuration(day.rise - now)}`
      : now < day.set
        ? `Sunset in ${formatDuration(day.set - now)}`
        : tomorrow
          ? `Sunrise in ${formatDuration(tomorrow.rise - now)}`
          : "The sun has set";
  const coordinate = (value: unknown, limit: number) =>
    typeof value === "number" && Math.abs(value) <= limit ? value : undefined;
  const latitude = coordinate(attributes.latitude, 90);
  const longitude = coordinate(attributes.longitude, 180);
  const placed = latitude !== undefined && longitude !== undefined;
  return {
    rise: words(day.rise),
    set: words(day.set),
    dayStart: midnightIn(today, zone),
    dayEnd: midnightIn(nextDate(today), zone),
    riseAt: day.rise,
    setAt: day.set,
    now,
    ...(placed ? { latitude, longitude } : {}),
    ...(typeof zone === "string" ? { timeZone: zone } : {}),
    headline,
    detail: `${formatDuration(day.set - day.rise)} of daylight`,
  };
}

/** "2026-10-05" for `now` on the clock of `timeZone`; the browser's own when it is unknown. */
function dateIn(timeZone: unknown, now: number): string {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  try {
    return format(typeof timeZone === "string" ? timeZone : undefined);
  } catch {
    return format();
  }
}

/**
 * The weather Home leads with: the first weather entity the viewer can read, in the house's
 * units. Nothing when there is none or it is unavailable, since an old forecast is not one.
 */
export function forecastView(house: House, now = Date.now()): ForecastView | undefined {
  const entity = house.entities
    .filter((e) => e.domain === "weather" && !e.hidden && !e.disabled)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const record = entity && house.states.get(String(entity.id));
  if (!entity || !record || record.available === false) return undefined;
  const state = stateOf(record);
  const attributes = (record.attributes ?? {}) as Row;
  const today = dateIn(attributes.timeZone, now);
  const temperature = (value: unknown) => (typeof value === "number" ? degrees(value) : undefined);

  const days: ForecastDay[] = [];
  for (const day of Array.isArray(attributes.daily) ? (attributes.daily as Row[]) : []) {
    const date = String(day.date);
    const low = temperature(day.low);
    const high = temperature(day.high);
    // A day that has passed since the forecast was read is no longer ahead.
    if (date < today || low === undefined || high === undefined) continue;
    const chance = day.precipitationProbability;
    days.push({
      label:
        date === today
          ? "Today"
          : new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
              new Date(`${date}T00:00:00Z`),
            ),
      condition: String(day.condition) as ForecastDay["condition"],
      low: Math.round(low),
      high: Math.round(high),
      precip: typeof chance === "number" ? Math.round(chance) : undefined,
    });
  }

  const current = temperature(state.temperature);
  if (current === undefined && days.length === 0) return undefined;
  // What it feels like, when that is news: within a degree or so it only repeats the reading.
  // The numbers compared are the ones shown.
  const apparent = temperature(state.apparentTemperature);
  const feels =
    current !== undefined &&
    apparent !== undefined &&
    Math.abs(Math.round(apparent) - Math.round(current)) >= 2
      ? `Feels ${Math.round(apparent)}°`
      : null;
  const first = days[0]?.label === "Today" ? days[0] : undefined;
  return {
    entityId: String(entity.id),
    title: String(entity.name),
    unit: degreeUnit(),
    current:
      current === undefined
        ? undefined
        : {
            temperature: current,
            condition: String(state.condition) as ForecastDay["condition"],
            high: first?.high,
            low: first?.low,
          },
    days,
    attribution: typeof attributes.attribution === "string" ? attributes.attribution : undefined,
    outside:
      current === undefined
        ? undefined
        : {
            temperature: String(Math.round(current)),
            unit: `${degreeUnit()} outside`,
            icon: weatherIcon(state.condition),
            line: [
              weatherWord(String(state.condition)),
              feels,
              first ? `H ${first.high}° L ${first.low}°` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          },
    rain: rainNote(attributes.hourly, now),
  };
}

// ───────── greeting ─────────

export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// ───────── history ─────────

export interface HistoryView {
  /** Values over time, for a sensor that reports numbers or a thermostat. */
  series?: { label: string; points: [number, number | null][]; step?: boolean }[];
  unit?: string;
  /** States over time, for everything that is on or off, open or closed, locked or not. */
  segments?: { from: number; to?: number; state: string }[];
  states?: Record<string, { label: string; tone: "on" | "off" | "ok" | "alert" | "unavailable" }>;
}

const STATE_KEY: Record<string, (state: Row) => string> = {
  light: (state) => (state.on ? "on" : "off"),
  switch: (state) => (state.on ? "on" : "off"),
  binary_sensor: (state) => (state.on ? "on" : "off"),
  lock: (state) => (state.jammed ? "jammed" : state.locked ? "locked" : "unlocked"),
  cover: (state) => (typeof state.position === "number" && state.position <= 0 ? "closed" : "open"),
};

const STATE_DEFS: Record<string, HistoryView["states"]> = {
  lock: {
    locked: { label: "Locked", tone: "ok" },
    unlocked: { label: "Unlocked", tone: "on" },
    jammed: { label: "Jammed", tone: "alert" },
  },
  cover: { open: { label: "Open", tone: "on" }, closed: { label: "Closed", tone: "off" } },
};

/**
 * A binary sensor's states read as its row does: open and closed for a door, wet and dry for a
 * leak sensor. The class comes from the latest record that carries one, since an integration
 * may have started classifying the sensor partway through the range.
 */
function binaryStateDefs(records: Row[]): HistoryView["states"] {
  const classified = records.findLast((record) => stateOf(record).deviceClass !== undefined);
  const words = binaryWords(stateOf(classified).deviceClass);
  return {
    on: { label: words.on, tone: words.alarming ? "alert" : "on" },
    off: { label: words.off, tone: "off" },
  };
}

/**
 * Raw history records as a chart wants them. A record with `available: false` breaks a line
 * and hatches a timeline: a gap is shown, never drawn across.
 */
/** What a card's history of this entity would draw: a line for a number, a timeline for a state, or nothing. */
export const cardHistoryKind = (domain: string, state: Row): "series" | "timeline" | undefined =>
  STATE_KEY[domain] || (domain === "sensor" && typeof state.value === "string")
    ? "timeline"
    : domain === "weather" || (domain === "sensor" && typeof state.value === "number")
      ? "series"
      : undefined;

export function historyView(domain: string, records: Row[], from: number): HistoryView {
  const key = STATE_KEY[domain];
  if (key) {
    const segments: NonNullable<HistoryView["segments"]> = [];
    for (const record of records) {
      const state = record.available === false ? "unavailable" : key(stateOf(record));
      const last = segments.at(-1);
      if (last?.state === state) continue;
      // The record before the range says what was already so when the range began.
      const at = Math.max(from, Number(record.updatedAt));
      if (last) last.to = at;
      segments.push({ from: at, state });
    }
    return {
      segments,
      states: domain === "binary_sensor" ? binaryStateDefs(records) : STATE_DEFS[domain],
    };
  }

  const value = (record: Row, field: string): number | null => {
    const raw = stateOf(record)[field];
    return record.available !== false && typeof raw === "number" ? raw : null;
  };
  const points = (field: string, convert: (v: number) => number) =>
    records.map((record): [number, number | null] => {
      const raw = value(record, field);
      return [Math.max(from, Number(record.updatedAt)), raw === null ? null : convert(raw)];
    });

  if (domain === "climate") {
    const degrees = (celsius: number) => inUnits(celsius, "°C").value;
    return {
      unit: "°",
      series: [
        { label: "Inside", points: points("currentTemp", degrees) },
        { label: "Target", points: points("targetTemp", degrees), step: true },
      ],
    };
  }
  if (domain === "weather") {
    return {
      unit: "°",
      series: [{ label: "Outside", points: points("temperature", (v) => inUnits(v, "°C").value) }],
    };
  }
  if (domain === "sensor") {
    const unit = String(records.map((record) => stateOf(record).unit).find(Boolean) ?? "");
    const numeric = records.some((record) => typeof stateOf(record).value === "number");
    if (numeric) {
      const shown = inUnits(0, unit).unit;
      return {
        unit: shown,
        series: [{ label: "Reading", points: points("value", (v) => inUnits(v, unit).value) }],
      };
    }
    if (records.some((record) => typeof stateOf(record).value === "string")) {
      return wordTimeline(records, from);
    }
    return {};
  }
  return {};
}

/** The tones a word-valued sensor's states take, in the order the words first appear. */
const WORD_TONES = ["off", "on", "ok", "alert"] as const;

/**
 * A sensor that reports words (a car that is online, asleep or driving) as a timeline, each
 * word a state. Nothing says which word means what, so each takes the next tone as it shows up,
 * and reads as itself, capitalised.
 */
function wordTimeline(records: Row[], from: number): HistoryView {
  const segments: NonNullable<HistoryView["segments"]> = [];
  const states: NonNullable<HistoryView["states"]> = {};
  for (const record of records) {
    const raw = stateOf(record).value;
    const state =
      record.available === false || typeof raw !== "string" || raw === "" ? "unavailable" : raw;
    if (state !== "unavailable" && !states[state]) {
      const tone = WORD_TONES[Object.keys(states).length % WORD_TONES.length] ?? "off";
      states[state] = { label: state.charAt(0).toUpperCase() + state.slice(1), tone };
    }
    const last = segments.at(-1);
    if (last?.state === state) continue;
    const at = Math.max(from, Number(record.updatedAt));
    if (last) last.to = at;
    segments.push({ from: at, state });
  }
  return { segments, states };
}

// ───────── lists ─────────

export const DOMAIN_LABEL: Record<string, string> = {
  light: "Lights",
  switch: "Switches",
  cover: "Covers",
  lock: "Locks",
  climate: "Climate",
  sensor: "Sensors",
  binary_sensor: "Binary sensors",
  button: "Buttons",
  weather: "Weather",
};

const matches = (needle: string, ...fields: unknown[]) =>
  !needle ||
  fields.some((field) =>
    String(field ?? "")
      .toLowerCase()
      .includes(needle),
  );

export interface EntityItem {
  id: string;
  view: EntityView;
  area?: string;
  device?: string;
  /** What an admin should know at a glance: "Hidden", "Disabled", "Orphaned". */
  flags: string[];
}

/** Every entity the viewer can read, hidden and disabled ones included: this is the admin's list. */
export function entityList(
  house: House,
  filter: { domains?: string[]; query?: string } = {},
  now = Date.now(),
): EntityItem[] {
  const needle = (filter.query ?? "").trim().toLowerCase();
  const domains = filter.domains ?? [];
  const areaName = new Map(house.areas.map((area) => [area.id, String(area.name)]));
  const deviceName = new Map(house.devices.map((device) => [device.id, String(device.name)]));
  return house.entities
    .filter(
      (entity) =>
        (domains.length === 0 || domains.includes(String(entity.domain))) &&
        matches(needle, entity.name, entity.id, areaName.get(entity.effectiveAreaId)),
    )
    .map((entity) => ({
      id: String(entity.id),
      view: entityView(house, entity, now),
      area: areaName.get(entity.effectiveAreaId),
      device: deviceName.get(entity.deviceId),
      flags: [
        entity.hidden ? "Hidden" : null,
        entity.disabled ? "Disabled" : null,
        entity.orphaned ? "Orphaned" : null,
      ].filter((flag): flag is string => flag !== null),
    }))
    .sort((a, b) => a.view.name.localeCompare(b.view.name) || a.id.localeCompare(b.id));
}

/** How many entities each domain has, for the filter pills; domains with none are left out. */
export function domainCounts(house: House): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entity of house.entities) {
    const domain = String(entity.domain);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return Object.keys(DOMAIN_LABEL)
    .filter((domain) => counts.has(domain))
    .map((value) => ({
      value,
      label: DOMAIN_LABEL[value] ?? value,
      count: counts.get(value) ?? 0,
    }));
}

export interface DeviceItem {
  id: string;
  name: string;
  /** "IKEA · TRADFRI bulb" */
  maker: string;
  area?: string;
  integrationId: string;
  entities: number;
  status: "online" | "unavailable" | "disabled";
  device: Row;
}

export function deviceList(house: House, query = ""): DeviceItem[] {
  const needle = query.trim().toLowerCase();
  const areaName = new Map(house.areas.map((area) => [area.id, String(area.name)]));
  return house.devices
    .filter((device) =>
      matches(
        needle,
        device.name,
        device.id,
        device.manufacturer,
        device.model,
        device.integrationId,
      ),
    )
    .map((device) => {
      const own = house.entities.filter((entity) => entity.deviceId === device.id);
      // The same test a row uses: there is a record, and it does not say unavailable.
      const reachable = own.some((entity) => {
        const record = house.states.get(String(entity.id));
        return record !== undefined && record.available !== false;
      });
      return {
        id: String(device.id),
        name: String(device.name),
        maker: [device.manufacturer, device.model].filter(Boolean).join(" · "),
        area: areaName.get(device.areaId),
        integrationId: String(device.integrationId),
        entities: own.length,
        // An integration that is no longer loaded cannot say anything about its devices.
        status: device.orphaned
          ? "disabled"
          : own.length > 0 && !reachable
            ? "unavailable"
            : "online",
        device,
      } satisfies DeviceItem;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The rows of one device, for its sheet: every entity, hidden ones too. */
export const deviceEntities = (house: House, deviceId: string, now = Date.now()): EntityView[] =>
  house.entities
    .filter((entity) => entity.deviceId === deviceId)
    .map((entity) => entityView(house, entity, now));

export interface AreaItem {
  id: string;
  name: string;
  /** A chosen icon; undefined is the house. */
  icon?: string;
  devices: number;
  entities: number;
}

export const areaList = (house: House): AreaItem[] =>
  house.areas
    .map((area) => ({
      id: String(area.id),
      name: String(area.name),
      icon: typeof area.icon === "string" ? area.icon : undefined,
      devices: house.devices.filter((device) => device.areaId === area.id).length,
      entities: house.entities.filter((entity) => entity.effectiveAreaId === area.id).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

// ───────── edits ─────────

export interface EntityDraft {
  name: string;
  id: string;
  /** "" follows the device's area. */
  areaId: string;
  hidden: boolean;
  disabled: boolean;
  /** Days of raw history, as typed; "" keeps the default. */
  rawDays: string;
  /** A chosen icon; "" is the default. */
  icon: string;
  /** What a sensor is; "" keeps the class its integration gave. */
  deviceClass: string;
}

export const entityDraft = (entity: Row): EntityDraft => ({
  name: String(entity.name),
  id: String(entity.id),
  areaId: String(entity.areaId ?? ""),
  hidden: entity.hidden === true,
  disabled: entity.disabled === true,
  rawDays: (entity.retention as { raw?: number } | undefined)?.raw?.toString() ?? "",
  icon: typeof entity.icon === "string" ? entity.icon : "",
  deviceClass: typeof entity.deviceClass === "string" ? entity.deviceClass : "",
});

/**
 * The classes an entity's form offers, with the words each brings: `Window · Open / Closed`.
 * Empty for anything but a sensor or binary sensor; "" keeps the integration's class.
 */
export function classOptions(domain: string): { value: string; label: string }[] {
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  const classes =
    domain === "binary_sensor"
      ? BINARY_SENSOR_CLASSES.map((c) => {
          const words = binaryWords(c);
          return { value: c, label: `${capital(c)} · ${words.on} / ${words.off}` };
        })
      : domain === "sensor"
        ? SENSOR_CLASSES.map((c) => ({ value: c, label: capital(c) }))
        : [];
  if (!classes.length) return [];
  return [{ value: "", label: "As its integration says" }, ...classes];
}

/** What a draft gets wrong, by field; empty when it can be saved. */
export function entityDraftErrors(
  draft: EntityDraft,
  entity: Row,
): Partial<Record<keyof EntityDraft, string>> {
  const errors: Partial<Record<keyof EntityDraft, string>> = {};
  if (!draft.name.trim()) errors.name = "Give it a name.";
  const domain = String(entity.domain);
  if (!new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(draft.id)) {
    errors.id = `An id is ${domain}. then lowercase letters, digits and underscores.`;
  }
  if (draft.rawDays !== "" && !/^[1-9]\d*$/.test(draft.rawDays)) {
    errors.rawDays = "A whole number of days, or leave it empty for the default.";
  }
  return errors;
}

/** Only what the draft changes, as `update_entity` takes it; undefined when nothing did. */
export function entityPatch(
  draft: EntityDraft,
  entity: Row,
): Omit<RequestParams<"update_entity">, "entityId"> | undefined {
  const was = entityDraft(entity);
  const patch: Omit<RequestParams<"update_entity">, "entityId"> = {};
  if (draft.name.trim() !== was.name) patch.name = draft.name.trim();
  if (draft.id !== was.id) patch.newId = draft.id;
  if (draft.areaId !== was.areaId) patch.areaId = draft.areaId || null;
  if (draft.hidden !== was.hidden) patch.hidden = draft.hidden;
  if (draft.disabled !== was.disabled) patch.disabled = draft.disabled;
  if (draft.icon !== was.icon) patch.icon = draft.icon || null;
  if (draft.deviceClass !== was.deviceClass) patch.deviceClass = draft.deviceClass || null;
  if (draft.rawDays !== was.rawDays) {
    // Setting the raw window keeps any rollup tiers already there. Clearing it clears the
    // whole policy: a policy cannot exist without a raw window.
    const kept = (entity.retention ?? {}) as Record<string, number>;
    patch.retention = draft.rawDays === "" ? null : { ...kept, raw: Number(draft.rawDays) };
  }
  return Object.keys(patch).length ? patch : undefined;
}

export interface DeviceDraft {
  name: string;
  id: string;
  /** "" is no area. */
  areaId: string;
  /** A chosen icon; "" is the default. */
  icon: string;
}

export const deviceDraft = (device: Row): DeviceDraft => ({
  name: String(device.name),
  id: String(device.id),
  areaId: String(device.areaId ?? ""),
  icon: typeof device.icon === "string" ? device.icon : "",
});

/** What a draft gets wrong, by field; empty when it can be saved. */
export function deviceDraftErrors(draft: DeviceDraft): Partial<Record<keyof DeviceDraft, string>> {
  const errors: Partial<Record<keyof DeviceDraft, string>> = {};
  if (!draft.name.trim()) errors.name = "Give it a name.";
  if (!/^[a-z0-9_]+$/.test(draft.id)) {
    errors.id = "An id is lowercase letters, digits and underscores.";
  }
  return errors;
}

/** Only what the draft changes, as `update_device` takes it; undefined when nothing did. */
export function devicePatch(
  draft: DeviceDraft,
  device: Row,
): Omit<RequestParams<"update_device">, "deviceId"> | undefined {
  const was = deviceDraft(device);
  const patch: Omit<RequestParams<"update_device">, "deviceId"> = {};
  if (draft.name.trim() !== was.name) patch.name = draft.name.trim();
  if (draft.id !== was.id) patch.newId = draft.id;
  if (draft.areaId !== was.areaId) patch.areaId = draft.areaId || null;
  if (draft.icon !== was.icon) patch.icon = draft.icon || null;
  return Object.keys(patch).length ? patch : undefined;
}

// ───────── the History page ─────────

export const HISTORY_RANGES = {
  hour: { label: "Hour", ms: 3_600_000 },
  day: { label: "24 hours", ms: 86_400_000 },
  week: { label: "7 days", ms: 7 * 86_400_000 },
  month: { label: "30 days", ms: 30 * 86_400_000 },
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

/** Whether an entity's history is drawn as a line (numbers) or a bar (states). */
export const historyKind = (domain: string): "values" | "states" =>
  domain === "sensor" || domain === "climate" || domain === "weather" ? "values" : "states";

/**
 * What to ask the recorder for. A month of a sensor's raw readings would not fit in one
 * answer, so it is asked for by the hour; states are kept exact, since a rollup cannot say
 * when within the hour a door opened.
 */
export const historyResolution = (domain: string, range: HistoryRange): "raw" | "hour" =>
  range === "month" && (domain === "sensor" || domain === "weather") ? "hour" : "raw";

/**
 * History records as raw ones, whichever tier the recorder answered from. A rollup becomes a
 * record at the start of its bucket carrying the bucket's mean.
 */
export function rawRecords(records: Row[]): Row[] {
  return records.map((record) => {
    if (typeof record.bucketStart !== "number") return record;
    const last = (record.last ?? {}) as Row;
    return {
      entityId: record.entityId,
      updatedAt: record.bucketStart,
      changedAt: record.bucketStart,
      available: true,
      state:
        typeof record.mean !== "number"
          ? last
          : last.domain === "weather"
            ? { ...last, temperature: record.mean }
            : { ...last, value: record.mean },
    };
  });
}

/** Where a browser downloads an entity's raw history as CSV. */
export const historyCsvUrl = (entityId: string, from: number, to: number): string =>
  `/api/history.csv?${new URLSearchParams({ entityId, from: String(from), to: String(to) })}`;

/** The entities a History address names, in order, without repeats. */
export const historySelection = (search: string): string[] => [
  ...new Set(new URLSearchParams(search).getAll("e").filter(Boolean)),
];

export function historySearch(entityIds: string[], range: HistoryRange): string {
  const params = new URLSearchParams();
  for (const id of entityIds) params.append("e", id);
  if (range !== "day") params.set("range", range);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const historyRangeOf = (search: string): HistoryRange => {
  const range = new URLSearchParams(search).get("range") ?? "";
  return Object.hasOwn(HISTORY_RANGES, range) ? (range as HistoryRange) : "day";
};

/** Whether a device's integration keeps settings for its devices: a Settings button is worth showing. */
export function hasDeviceSettings(
  house: Pick<House, "integrations">,
  device: Row | undefined,
): boolean {
  if (!device || device.orphaned) return false;
  return house.integrations.some(
    (integration) =>
      integration.integrationId === device.integrationId && integration.deviceSettings === true,
  );
}
