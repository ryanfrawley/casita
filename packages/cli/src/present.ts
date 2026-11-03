// The terminal's side of how state reads: colors, bars, and the lines that describe a car.
// The words themselves come from @casita/client.

import {
  type Car,
  clock,
  formatNumber,
  inUnits,
  present as presentState,
  type Row,
  type Shown,
  type Tone,
} from "@casita/client";
import { bar, c, SYMBOL } from "./style.ts";

export {
  ago,
  type Car,
  carsFrom,
  clock,
  formatNumber,
  type Row,
  type Shown,
  since,
  type Tone,
} from "@casita/client";

/** The state as it should read in a terminal; an unavailable entity keeps its last known state. */
export function present(record: Row | undefined, now = Date.now()): Shown {
  const { was, ...shown } = presentState(record, now);
  return was === undefined ? shown : { ...shown, text: `Unavailable ╱╱ was ${was}` };
}

const TONE: Record<Tone, (text: string) => string> = {
  on: c.amber,
  good: c.green,
  warn: c.red,
  pending: c.blue,
  plain: (text) => text,
  muted: c.dim,
};
export const tint = (shown: Shown): string => TONE[shown.tone](shown.text);

/** A level bar for a shown state, or blank space of the same width. */
export const levelBar = (shown: Shown, cells = 10): string =>
  shown.level === undefined ? " ".repeat(cells) : bar(shown.level, cells);

/** The symbol that leads a result line. */
export const mark = {
  pending: () => c.blue(SYMBOL.pending),
  ok: () => c.amber(SYMBOL.ok),
  warn: () => c.red(SYMBOL.warn),
};

/** The two lines that describe a car: the battery bar, then what it is doing. */
export function carLines(car: Car, cells: number, now = Date.now()): [string, string] {
  const battery = car.battery ?? 0;
  const gauge = `[${bar(battery / 100, cells, c.amber, car.limit === undefined ? undefined : car.limit / 100)}]`;
  const shown = car.range === undefined ? undefined : inUnits(car.range, car.rangeUnit);
  const range = shown ? `${formatNumber(Math.round(shown.value))} ${shown.unit}` : "";
  const limit = car.limit === undefined ? "" : `limit ${car.limit}%`;
  const first = `${gauge} ${c.bold(car.battery === undefined ? "?" : `${battery}%`)}  ${c.dim([range, limit].filter(Boolean).join(" · "))}`;

  const parts: string[] = [];
  if (car.charging) {
    parts.push(c.amber("Charging"));
    if (car.powerKw) parts.push(`${formatNumber(car.powerKw)} kW`);
    if (car.hoursToFull && car.limit !== undefined) {
      parts.push(`reaches ${car.limit}% at about ${clock(now + car.hoursToFull * 3_600_000)}`);
    }
    if (car.energyAdded) parts.push(`+${formatNumber(car.energyAdded)} kWh`);
  } else {
    const doing = car.state ? car.state[0]?.toUpperCase() + car.state.slice(1) : "Parked";
    parts.push(car.state === "offline" || car.state === "asleep" ? c.dim(doing) : doing);
    if (car.pluggedIn !== undefined) parts.push(car.pluggedIn ? "plugged in" : "not plugged in");
    if (car.place) parts.push(`at ${car.place}`);
  }
  return [first, parts.join(c.dim(" · "))];
}
