// The arithmetic behind the charts, apart from React so it can be tested as plain functions.

import { DAY, HOUR } from "./time.ts";

export type ChartTone =
  | "on"
  | "off"
  | "ok"
  | "alert"
  | "heat"
  | "cool"
  | "unavailable"
  | "series-1"
  | "series-2"
  | "series-3";

export type TimePoint = [t: number, value: number | null] | { t: number; v: number | null };
export interface Point {
  t: number;
  /** null where the entity was unavailable: the line breaks there. */
  v: number | null;
}

export interface TimeSeries {
  id?: string;
  label: string;
  points: TimePoint[];
  /** A target or set point: drawn stepped and carried to the right edge. */
  step?: boolean;
  color?: "series-1" | "series-2" | "series-3";
}

export const toPoint = (point: TimePoint): Point =>
  Array.isArray(point) ? { t: Number(point[0]), v: point[1] } : { t: Number(point.t), v: point.v };

/** Points in time order. */
export const sortedPoints = (series: TimeSeries): Point[] =>
  series.points.map(toPoint).sort((a, b) => a.t - b.t);

/** What each tone is drawn in. Unavailable is a hatch, so it has no fill here. */
export const TONE_FILL: Partial<Record<ChartTone, string>> = {
  on: "var(--lamp)",
  // Off is a step darker than the card it lies on, the faint line's tone.
  off: "var(--line)",
  ok: "var(--sage)",
  alert: "var(--danger)",
  heat: "var(--ember)",
  cool: "var(--sky)",
  "series-1": "var(--series-1)",
  "series-2": "var(--series-2)",
  "series-3": "var(--series-3)",
};

/** A series' colour: its own if it names one, else by its place (measured first, target second). */
export const seriesColor = (series: Pick<TimeSeries, "color">, index: number): string =>
  series.color ? `var(--${series.color})` : `var(--series-${index + 1})`;

/**
 * The low and high a set of readings spans. A flat line gets a unit of room either side, so it
 * is drawn mid-plot and not on the baseline; no readings at all is 0 to 1.
 */
export function valueRange(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? [low - 1, high + 1] : [low, high];
}

/** About `count` round values covering min to max: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const raw = (max - min || 1) / count;
  let step = 10 ** Math.floor(Math.log10(raw));
  const error = raw / step;
  if (error >= 7.5) step *= 10;
  else if (error >= 3.5) step *= 5;
  else if (error >= 1.5) step *= 2;
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = low; v <= high + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const TIME_STEPS = [
  HOUR / 4,
  HOUR / 2,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/**
 * Tick times for a range drawn `width` pixels wide: one about every 96px, on round local
 * times (the hour, midnight), and the step between them.
 */
export function timeTicks(
  t0: number,
  t1: number,
  width: number,
  offsetMinutes = new Date(t0).getTimezoneOffset(),
): { ticks: number[]; step: number } {
  const target = Math.max(2, Math.floor(width / 96));
  const step = TIME_STEPS.find((candidate) => (t1 - t0) / candidate <= target) ?? 7 * DAY;
  const offset = offsetMinutes * 6e4;
  const ticks: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

/**
 * The point that speaks for a series at time `t`: for a stepped series the last one at or
 * before `t` (the value in force); otherwise the nearest in time.
 */
export function valueAt(points: Point[], t: number, step?: boolean): Point | null {
  let best: Point | null = null;
  if (step) {
    for (const point of points) {
      if (point.t <= t) best = point;
      else break;
    }
    return best;
  }
  let distance = Infinity;
  for (const point of points) {
    const d = Math.abs(point.t - t);
    if (d < distance) {
      distance = d;
      best = point;
    }
  }
  return best;
}

/**
 * An SVG path through the points. A null value breaks the line: gaps are shown, never
 * smoothed over. A stepped series holds each value until the next and runs on to `xEnd`.
 */
export function linePath(
  points: Point[],
  x: (t: number) => number,
  y: (v: number) => number,
  step?: boolean,
  xEnd?: number,
): string {
  let d = "";
  let drawing = false;
  for (const point of points) {
    if (point.v == null) {
      drawing = false;
      continue;
    }
    const px = x(point.t).toFixed(1);
    const py = y(point.v).toFixed(1);
    if (!drawing) d += `M${px} ${py}`;
    else d += step ? `H${px}V${py}` : `L${px} ${py}`;
    drawing = true;
  }
  if (step && drawing && xEnd != null) d += `H${xEnd.toFixed(1)}`;
  return d;
}

export interface StateSegment {
  from: number;
  /** Absent while the state still holds. */
  to?: number;
  state: string;
}

/** Milliseconds spent in `state` within the range; an open segment runs to the range's end. */
export const timeInState = (
  segments: StateSegment[],
  state: string,
  [t0, t1]: [number, number],
): number =>
  segments.reduce(
    (total, segment) =>
      segment.state === state ? total + (segment.to ?? t1) - Math.max(t0, segment.from) : total,
    0,
  );
