// ASCII history for the dashboard's detail view. Time runs left to right. A reading that is
// a number (a temperature) is drawn as columns of bars; one that is a state (a light on or
// off, a door open or closed) as a single horizontal bar colored by that state.

import { binaryWords, inUnits } from "@casita/client";
import { clock, formatNumber, type Row } from "./present.ts";
import { c, pad, padStart, truncate, width } from "./style.ts";

export interface Point {
  at: number;
  value: number;
}

/** `on` is undefined while the entity was unavailable. */
export interface StatePoint {
  at: number;
  on: boolean | undefined;
}

/** A word-valued reading, such as a car being "asleep" or "driving"; undefined while unknown. */
export interface CategoryPoint {
  at: number;
  value: string | undefined;
}

export interface ChartOptions {
  from: number;
  to: number;
  /** Total width in columns, axis labels included. */
  width: number;
  /** Rows of bars. */
  height: number;
  unit?: string;
}

export interface TimelineOptions {
  from: number;
  to: number;
  width: number;
  /** What the two states are called, e.g. ["On", "Off"] or ["Open", "Closed"]. */
  labels: [on: string, off: string];
  /** Color of the "on" state. */
  tone?: (text: string) => string;
}

/** A history ready to draw: numbers for a chart, or states for a timeline. */
export type Series =
  | { kind: "value"; points: Point[]; unit?: string }
  | { kind: "state"; states: StatePoint[]; labels: [string, string]; tone?: "amber" | "green" }
  | { kind: "category"; points: CategoryPoint[] };

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const DAY_MS = 86_400_000;

/** "8:10 pm" within a day, "Sat 3" across several. */
const timeLabel = (ms: number, span: number): string =>
  span > DAY_MS
    ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric" }).format(ms)
    : clock(ms);

/** The labels under the axis: start, middle, and end, as many as fit without touching. */
function timeAxis(from: number, to: number, columns: number): string {
  const span = to - from;
  const start = timeLabel(from, span);
  const middle = timeLabel(from + span / 2, span);
  const end = span > DAY_MS ? "now" : timeLabel(to, span);
  if (columns >= width(start) + width(middle) + width(end) + 4) {
    const half = Math.floor(columns / 2);
    const left = `${pad(start, half - Math.floor(width(middle) / 2))}${middle}`;
    return `${pad(left, columns - width(end))}${end}`;
  }
  if (columns >= width(start) + width(end) + 1) return `${pad(start, columns - width(end))}${end}`;
  return truncate(start, columns);
}

/**
 * One value per column: the mean of the readings that fall in it. A column with no reading
 * keeps the one before it, since a sensor that reports only on change is still at that value;
 * a reading from before the range fills in from the left edge. Columns before the first
 * reading stay empty.
 */
export function buckets(
  points: Point[],
  from: number,
  to: number,
  columns: number,
): (number | undefined)[] {
  if (to < from) return new Array<undefined>(columns).fill(undefined);
  const span = Math.max(1, to - from);
  const sums = new Array<number>(columns).fill(0);
  const counts = new Array<number>(columns).fill(0);
  let last: number | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.at > to) continue;
    if (point.at < from) {
      // The most recent reading before the range is what the range starts with.
      if (point.at >= lastAt) {
        last = point.value;
        lastAt = point.at;
      }
      continue;
    }
    const index = Math.min(columns - 1, Math.floor(((point.at - from) / span) * columns));
    sums[index] = (sums[index] ?? 0) + point.value;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return sums.map((sum, i) => {
    const count = counts[i] ?? 0;
    if (count > 0) last = sum / count;
    return last;
  });
}

/** The chart as lines: bars with a value axis on the left, a time axis below, then a summary. */
export function chart(points: Point[], options: ChartOptions): string[] {
  if (options.to < options.from) return [c.dim("No readings in this range.")];
  const finite = points.filter((p) => Number.isFinite(p.value) && p.at <= options.to);
  const inRange = finite.filter((p) => p.at >= options.from);
  // A reading from before the range still tells what the range started at; if nothing has
  // been reported since, that value held for the whole of it.
  const before = finite
    .filter((p) => p.at < options.from)
    .sort((x, y) => x.at - y.at)
    .at(-1);
  if (inRange.length === 0 && !before) return [c.dim("No readings in this range.")];
  const drawn = finite;

  const values = inRange.length > 0 ? inRange.map((p) => p.value) : [before?.value ?? 0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const unit = options.unit ? ` ${options.unit}` : "";
  const label = (value: number) => `${formatNumber(value)}${unit}`;
  // No room for both labels and bars: the bars win.
  const labelW = Math.max(width(label(min)), width(label(max)));
  const axisW = options.width >= labelW + 6 ? labelW : 0;
  const gutter = axisW ? axisW + 1 : 0;
  const columns = Math.max(1, options.width - gutter - 1);
  const height = Math.max(2, options.height);
  const series = buckets(drawn, options.from, options.to, columns);

  // Readings that read the same are the same: a flat line across the middle, not a cliff
  // between two values that differ in the fifteenth decimal place.
  const flat = label(min) === label(max);
  const level = (value: number) => {
    if (flat) return (height * 8) / 2;
    const clamped = Math.min(max, Math.max(min, value));
    return Math.max(1, Math.round(((clamped - min) / (max - min)) * height * 8));
  };

  const lines: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let bars = "";
    for (const value of series) {
      const filled = value === undefined ? 0 : Math.min(8, Math.max(0, level(value) - row * 8));
      bars += EIGHTHS[filled] ?? " ";
    }
    const mark = row === height - 1 ? (flat ? "" : label(max)) : row === 0 ? label(min) : "";
    const axis = axisW ? `${c.dim(padStart(mark, axisW))} ` : "";
    lines.push(`${axis}${c.faint("│")}${c.amber(bars)}`);
  }
  lines.push(`${" ".repeat(gutter)}${c.faint(`└${"─".repeat(columns)}`)}`);
  lines.push(c.dim(`${" ".repeat(gutter + 1)}${timeAxis(options.from, options.to, columns)}`));

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const summary = [
    `min ${label(min)}`,
    `avg ${label(mean)}`,
    `max ${label(max)}`,
    inRange.length === 0
      ? "no change in this range"
      : `${formatNumber(inRange.length)} reading${inRange.length === 1 ? "" : "s"}`,
  ].join(c.dim(" · "));
  lines.push("", summary);
  return lines;
}

/** A share of time as text. Anything that happened at all never reads 0%, nor its complement 100%. */
function percentOf(part: number, whole: number): string {
  const percent = (part / whole) * 100;
  if (percent > 0 && percent < 0.5) return "<1%";
  if (percent < 100 && percent >= 99.5) return ">99%";
  return `${Math.round(percent)}%`;
}

/** The state in each column: on if it was on at any moment in it, so a brief pulse still shows. */
export function stateColumns(
  states: StatePoint[],
  from: number,
  to: number,
  columns: number,
): (boolean | undefined)[] {
  if (to < from) return new Array<undefined>(columns).fill(undefined);
  const span = Math.max(1, to - from);
  const sorted = [...states].filter((s) => s.at <= to).sort((a, b) => a.at - b.at);
  const out: (boolean | undefined)[] = [];
  let index = 0;
  let current: boolean | undefined;
  let known = false;
  // What it was doing when the range began.
  while (index < sorted.length && (sorted[index]?.at ?? 0) < from) {
    current = sorted[index]?.on;
    known = true;
    index++;
  }
  for (let column = 0; column < columns; column++) {
    const start = from + (column / columns) * span;
    const end = from + ((column + 1) / columns) * span;
    // A change exactly on the column's edge is what the column starts as, not a moment in it.
    while (index < sorted.length && (sorted[index]?.at ?? 0) <= start) {
      current = sorted[index]?.on;
      known = true;
      index++;
    }
    let on = known ? current : undefined;
    let any = known && current !== undefined;
    while (index < sorted.length && ((sorted[index]?.at ?? 0) < end || column === columns - 1)) {
      current = sorted[index]?.on;
      known = true;
      if (current !== undefined) {
        on = any ? on || current : current;
        any = true;
      }
      index++;
    }
    out.push(any ? on : undefined);
  }
  return out;
}

/**
 * A horizontal bar colored by state, with a time axis and a summary of how much of the
 * range was spent on and how often it changed.
 */
export function timeline(states: StatePoint[], options: TimelineOptions): string[] {
  const inRange = states.filter((s) => s.at <= options.to);
  if (inRange.length === 0 || options.to < options.from)
    return [c.dim("No history in this range.")];
  const tone = options.tone ?? c.amber;
  const [onLabel, offLabel] = options.labels;
  // One column goes to the axis; a width of one leaves none for the bar.
  const columns = Math.max(0, options.width - 1);
  const cells = stateColumns(inRange, options.from, options.to, Math.max(1, columns));
  if (cells.every((cell) => cell === undefined)) return [c.dim("No history in this range.")];
  cells.length = columns;

  // Runs of the same state are colored together, so the line carries few color codes.
  let bar = "";
  for (let i = 0; i < cells.length; ) {
    const state = cells[i];
    let run = 1;
    while (i + run < cells.length && cells[i + run] === state) run++;
    bar +=
      state === undefined
        ? " ".repeat(run)
        : state
          ? tone("█".repeat(run))
          : c.faint("░".repeat(run));
    i += run;
  }

  // The share is measured in time, not columns: a two-minute run should not count as a
  // whole column of a day-long bar. Changes are counted the same way, from the records.
  const sorted = [...inRange].sort((a, b) => a.at - b.at);
  let onMs = 0;
  let knownMs = 0;
  let changes = 0;
  let current: boolean | undefined;
  let cursor = options.from;
  const advance = (until: number) => {
    const end = Math.min(options.to, Math.max(cursor, until));
    if (current !== undefined) {
      knownMs += end - cursor;
      if (current) onMs += end - cursor;
    }
    cursor = end;
  };
  let previous: boolean | undefined;
  for (const state of sorted) {
    advance(state.at);
    current = state.on;
    if (state.on === undefined) continue;
    if (previous !== undefined && state.on !== previous && state.at >= options.from) changes++;
    previous = state.on;
  }
  advance(options.to);
  // With no measurable time known (a single record at the very end) there are no shares to give.
  const summary = [
    ...(knownMs > 0
      ? [
          `${tone("█")} ${onLabel} ${percentOf(onMs, knownMs)}`,
          `${c.faint("░")} ${offLabel} ${percentOf(knownMs - onMs, knownMs)}`,
        ]
      : []),
    `${changes} change${changes === 1 ? "" : "s"}`,
  ].join(c.dim(" · "));
  return [
    `${c.faint("│")}${bar}`,
    c.faint(`└${"─".repeat(columns)}`),
    c.dim(` ${timeAxis(options.from, options.to, columns)}`),
    "",
    summary,
  ];
}

/**
 * Turns history records into something drawable. Lights, switches, locks, covers, and
 * binary sensors are states; sensors with numeric values and thermostats are values.
 * Undefined for entities with nothing to chart (buttons, word-valued sensors).
 */
export function seriesFor(domain: string, records: Row[]): Series | undefined {
  const at = (r: Row) => (typeof r.updatedAt === "number" ? r.updatedAt : 0);
  const state = (r: Row) => (r.state ?? {}) as Row;
  const states = (on: (s: Row) => boolean | undefined): StatePoint[] =>
    records.map((r) => ({ at: at(r), on: r.available === false ? undefined : on(state(r)) }));
  const last = records.length > 0 ? state(records[records.length - 1] ?? {}) : {};

  switch (domain) {
    case "light":
    case "switch":
      return { kind: "state", states: states((s) => s.on === true), labels: ["On", "Off"] };
    case "binary_sensor": {
      const words = binaryWords(last.deviceClass);
      return {
        kind: "state",
        states: states((s) => s.on === true),
        labels: [words.on, words.off],
      };
    }
    case "lock":
      return {
        kind: "state",
        states: states((s) => s.locked === true),
        labels: ["Locked", "Unlocked"],
        tone: "green",
      };
    case "cover":
      return {
        kind: "state",
        // A cover that does not report a position is not known to be closed.
        states: states((s) => (typeof s.position === "number" ? s.position > 0 : undefined)),
        labels: ["Open", "Closed"],
      };
    case "sensor":
    case "weather":
    case "climate": {
      const key =
        domain === "climate" ? "currentTemp" : domain === "weather" ? "temperature" : "value";
      const numeric = records.some((r) => typeof state(r)[key] === "number");
      // Words instead of numbers (a car that is "asleep" or "driving") are named states.
      if (
        !numeric &&
        domain === "sensor" &&
        records.some((r) => typeof state(r).value === "string")
      ) {
        return { kind: "category", points: categoriesFor(records) };
      }
      if (!numeric && records.length > 0) return undefined;
      // A thermostat's and the weather's temperatures are Celsius; a sensor says what its
      // readings are in.
      const celsius = domain !== "sensor";
      const reported = celsius ? "°C" : typeof last.unit === "string" ? last.unit : undefined;
      const points = records.flatMap((r) => {
        const value = state(r)[key];
        if (typeof value !== "number" || r.available === false) return [];
        // Each reading is converted by its own unit: a sensor can change what it reports in.
        const own = celsius ? "°C" : typeof state(r).unit === "string" ? state(r).unit : reported;
        return [{ at: at(r), value: own ? inUnits(value, String(own)).value : value }];
      });
      const unit = celsius ? "°" : reported && inUnits(0, reported).unit;
      return { kind: "value", points, unit };
    }
    default:
      return undefined;
  }
}

// ───────── timelines of named states ─────────

type Tone = (text: string) => string;

/** States that mean the same thing everywhere get the same color everywhere. */
const KNOWN_TONES: Record<string, Tone> = {
  driving: c.blue,
  charging: c.amber,
  online: c.green,
  updating: c.red,
  asleep: c.dim,
  suspended: c.dim,
  offline: c.faint,
};
const SPARE_TONES: Tone[] = [c.amber, c.blue, c.green, c.red, c.dim];
/** Shapes too, so the states can be told apart where there is no color. */
const GLYPHS = ["█", "▓", "▒", "░"];

/**
 * A horizontal bar colored by a named state, one color per state, with a legend giving
 * each state's share of the time and the number of changes.
 */
export function categoryTimeline(
  points: CategoryPoint[],
  options: { from: number; to: number; width: number },
): string[] {
  const { from, to } = options;
  const sorted = points.filter((p) => p.at <= to).sort((a, b) => a.at - b.at);
  if (sorted.length === 0 || to < from) return [c.dim("No history in this range.")];
  // One column goes to the axis; a width of one leaves none for the bar.
  const columns = Math.max(0, options.width - 1);
  const span = Math.max(1, to - from);

  // Time spent in each state, per column and over the whole range.
  const totals = new Map<string, number>();
  const perColumn: Map<string, number>[] = Array.from({ length: columns }, () => new Map());
  const spend = (value: string | undefined, start: number, end: number) => {
    if (value === undefined || end <= start) return;
    totals.set(value, (totals.get(value) ?? 0) + (end - start));
    if (columns === 0) return;
    const first = Math.min(columns - 1, Math.floor(((start - from) / span) * columns));
    // The column holding the stretch's last instant; `end` itself belongs to the next one.
    const last = Math.min(columns - 1, Math.ceil(((end - from) / span) * columns) - 1);
    for (let column = first; column <= last; column++) {
      const left = from + (column / columns) * span;
      const right = from + ((column + 1) / columns) * span;
      const overlap = Math.min(end, right) - Math.max(start, left);
      const tally = perColumn[column];
      if (tally && overlap > 0) tally.set(value, (tally.get(value) ?? 0) + overlap);
    }
  };
  let current: string | undefined;
  let cursor = from;
  let changes = 0;
  let previous: string | undefined;
  for (const point of sorted) {
    const at = Math.max(from, point.at);
    spend(current, cursor, at);
    cursor = at;
    current = point.value;
    if (point.value === undefined) continue;
    if (previous !== undefined && point.value !== previous && point.at >= from) changes++;
    previous = point.value;
  }
  spend(current, cursor, to);
  if (totals.size === 0) return [c.dim("No history in this range.")];

  // The states in order of time spent; that order also hands out shapes and spare colors.
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  let spare = 0;
  const look = new Map<string, { tone: Tone; glyph: string }>();
  const taken = new Set<string>();
  const everyTone = [...SPARE_TONES, c.faint];
  ranked.forEach((name, i) => {
    const glyph = GLYPHS[Math.min(i, GLYPHS.length - 1)] ?? "█";
    let tone =
      KNOWN_TONES[name.toLowerCase()] ?? SPARE_TONES[spare++ % SPARE_TONES.length] ?? c.amber;
    // Past the fourth state the shapes repeat, so the color has to tell them apart.
    const key = (t: Tone) => `${everyTone.indexOf(t)}${glyph}`;
    if (taken.has(key(tone))) tone = everyTone.find((t) => !taken.has(key(t))) ?? tone;
    taken.add(key(tone));
    look.set(name, { tone, glyph });
  });

  // Each column shows the state it spent the most time in.
  const cells = perColumn.map((tally) => [...tally].sort((a, b) => b[1] - a[1])[0]?.[0]);
  let bar = "";
  for (let i = 0; i < cells.length; ) {
    const name = cells[i];
    let run = 1;
    while (i + run < cells.length && cells[i + run] === name) run++;
    const style = name === undefined ? undefined : look.get(name);
    bar += style ? style.tone(style.glyph.repeat(run)) : " ".repeat(run);
    i += run;
  }

  const known = [...totals.values()].reduce((a, b) => a + b, 0);
  const legend = ranked.map((name) => {
    const style = look.get(name);
    return `${style?.tone(style.glyph) ?? ""} ${name} ${percentOf(totals.get(name) ?? 0, known)}`;
  });
  return [
    `${c.faint("│")}${bar}`,
    c.faint(`└${"─".repeat(columns)}`),
    c.dim(` ${timeAxis(from, to, columns)}`),
    "",
    [...legend, `${changes} change${changes === 1 ? "" : "s"}`].join(c.dim(" · ")),
  ];
}

/** History records of a word-valued sensor as named states. */
export function categoriesFor(records: Row[]): CategoryPoint[] {
  return records.map((r) => {
    const value = ((r.state ?? {}) as Row).value;
    return {
      at: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      value: typeof value === "string" && value !== "" && r.available !== false ? value : undefined,
    };
  });
}
