import { expect, test } from "bun:test";
import { setUnits } from "@casita/client";
import { buckets, chart, type StatePoint, seriesFor, stateColumns, timeline } from "./chart.ts";
import type { Row } from "./present.ts";
import { setColor, width } from "./style.ts";

setColor(false);
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0);
const at = (minutes: number, value: number) => ({ at: T0 + minutes * 60_000, value });

test("buckets average the readings in each column and carry the last value across gaps", () => {
  const points = [at(5, 10), at(10, 20), at(35, 40)];
  // Four 15-minute columns over an hour.
  expect(buckets(points, T0, T0 + HOUR, 4)).toEqual([15, 15, 40, 40]);
  // Nothing is known before the first reading.
  expect(buckets([at(40, 7)], T0, T0 + HOUR, 4)).toEqual([undefined, undefined, 7, 7]);
  // A reading from before the range is what the range starts at; one after it is ignored;
  // one exactly at the end lands in the last column.
  expect(buckets([at(-5, 1), at(60, 9), at(61, 2)], T0, T0 + HOUR, 4)).toEqual([1, 1, 1, 9]);
  // Of several earlier readings, the latest one counts.
  expect(buckets([at(-50, 3), at(-5, 1), at(-20, 2)], T0, T0 + HOUR, 2)).toEqual([1, 1]);
});

test("the chart scales bars between the lowest and highest reading, with both labelled", () => {
  const points = [at(0, 10), at(15, 20), at(30, 30), at(45, 20)];
  const lines = chart(points, { from: T0, to: T0 + HOUR, width: 12, height: 2, unit: "°C" });
  // Axis labels are 5 wide, which leaves 5 columns of bars.
  // The top half holds only the peak; the lowest reading still shows a sliver.
  expect(lines.slice(0, 2)).toEqual(["30 °C │  █  ", "10 °C │▁████"]);
  expect(lines[2]).toBe("      └─────");
  expect(lines.at(-1)).toBe("min 10 °C · avg 20 °C · max 30 °C · 4 readings");
});

test("bars and axes fit the width asked for, at several sizes", () => {
  const points = Array.from({ length: 200 }, (_, i) => at(i * 7, 15 + 8 * Math.sin(i / 9)));
  for (const size of [30, 60, 100, 160]) {
    const lines = chart(points, {
      from: T0,
      to: T0 + 24 * HOUR,
      width: size,
      height: 8,
      unit: "°C",
    });
    // Bars and axes are sized to fit; the summary line is the caller's to cut.
    expect(Math.max(...lines.slice(0, 10).map(width))).toBeLessThanOrEqual(size);
    expect(lines).toHaveLength(8 + 4);
  }
});

test("the time axis shows clock times within a day and dates across several", () => {
  const day = chart([at(0, 1), at(600, 2)], { from: T0, to: T0 + 12 * HOUR, width: 60, height: 3 });
  expect(day[4]).toMatch(/^ +12:00 pm +6:00 pm +12:00 am$/);
  const week = chart([at(0, 1), at(600, 2)], {
    from: T0,
    to: T0 + 7 * 24 * HOUR,
    width: 60,
    height: 3,
  });
  expect(week[4]).toMatch(/^ +Sat 3 +Wed 7 +now$/);
});

test("a flat series draws a line through the middle instead of nothing", () => {
  const lines = chart([at(0, 21), at(30, 21)], { from: T0, to: T0 + HOUR, width: 14, height: 4 });
  expect(lines.slice(0, 4).map((l) => l.replace(/^ *\d* *│/, ""))).toEqual([
    "          ".slice(0, 10),
    "          ".slice(0, 10),
    "██████████",
    "██████████",
  ]);
  expect(lines[3]).toStartWith("21 │");
  expect(lines.at(-1)).toBe("min 21 · avg 21 · max 21 · 2 readings");
});

test("no readings in range says so; a single reading is still drawn", () => {
  expect(chart([], { from: T0, to: T0 + HOUR, width: 40, height: 4 })).toEqual([
    "No readings in this range.",
  ]);
  // A value set before the range and not reported since held for the whole of it.
  const held = chart([at(-90, 5)], { from: T0, to: T0 + HOUR, width: 20, height: 2 });
  expect(held[1]).toMatch(/^5 │█+$/);
  expect(held.at(-1)).toBe("min 5 · avg 5 · max 5 · no change in this range");
  const one = chart([at(30, 5)], { from: T0, to: T0 + HOUR, width: 20, height: 2 });
  expect(one.at(-1)).toBe("min 5 · avg 5 · max 5 · 1 reading");
});

test("negative and large values keep their labels and order", () => {
  const lines = chart([at(0, -5.25), at(30, 1234.5)], {
    from: T0,
    to: T0 + HOUR,
    width: 30,
    height: 3,
    unit: "W",
  });
  expect(lines[0]).toStartWith("1,234.5 W │");
  expect(lines[2]).toStartWith("   -5.3 W │");
});

// ───────── buckets: edges of the range and of the input ─────────

test("a reading exactly at the start lands in the first column, one exactly at the end in the last", () => {
  expect(buckets([at(0, 3)], T0, T0 + HOUR, 4)).toEqual([3, 3, 3, 3]);
  expect(buckets([at(60, 9)], T0, T0 + HOUR, 4)).toEqual([undefined, undefined, undefined, 9]);
});

test("an empty range puts every reading in the first column instead of dividing by zero", () => {
  expect(
    buckets(
      [
        { at: T0, value: 2 },
        { at: T0, value: 4 },
      ],
      T0,
      T0,
      3,
    ),
  ).toEqual([3, 3, 3]);
  // A reading beside the instant is outside it.
  expect(buckets([{ at: T0 + 1, value: 2 }], T0, T0, 3)).toEqual([undefined, undefined, undefined]);
});

test("a range that ends before it starts holds no readings", () => {
  expect(buckets([{ at: T0, value: 1 }], T0 + HOUR, T0, 4)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("readings out of time order bucket the same as sorted ones", () => {
  const sorted = [at(2, 1), at(20, 2), at(40, 3), at(41, 5)];
  const shuffled = [sorted[3], sorted[0], sorted[2], sorted[1]].flatMap((p) => (p ? [p] : []));
  expect(buckets(shuffled, T0, T0 + HOUR, 6)).toEqual(buckets(sorted, T0, T0 + HOUR, 6));
});

test("readings with the same timestamp are averaged, not overwritten", () => {
  expect(buckets([at(10, 1), at(10, 5), at(10, 6)], T0, T0 + HOUR, 2)).toEqual([4, 4]);
});

test("one column holds the mean of every reading in range", () => {
  expect(buckets([at(0, 1), at(30, 2), at(60, 6), at(61, 100)], T0, T0 + HOUR, 1)).toEqual([3]);
});

test("more columns than readings carries each reading forward to the next", () => {
  expect(buckets([at(0, 1), at(30, 2)], T0, T0 + HOUR, 8)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
});

// ───────── chart: shape ─────────

/** The bar rows of a chart of `height` rows: what follows the axis line on each. */
const barRows = (lines: string[], height: number) =>
  lines.slice(0, height).map((line) => line.slice(line.indexOf("│") + 1));

test("a range that ends before it starts says there is nothing to draw", () => {
  expect(chart([at(0, 1)], { from: T0 + HOUR, to: T0, width: 40, height: 4 })).toEqual([
    "No readings in this range.",
  ]);
});

test("an empty range with a reading in it still draws a chart", () => {
  const lines = chart([at(0, 7)], { from: T0, to: T0, width: 20, height: 2 });
  expect(lines).toHaveLength(2 + 4);
  expect(lines.at(-1)).toBe("min 7 · avg 7 · max 7 · 1 reading");
  expect(lines.join("\n")).not.toContain("NaN");
});

test("a negative-only series puts the least negative reading on top", () => {
  const lines = chart([at(0, -10), at(30, -2)], { from: T0, to: T0 + HOUR, width: 20, height: 2 });
  expect(lines[0]).toStartWith(" -2 │");
  expect(lines[1]).toStartWith("-10 │▁");
  // The later, higher reading fills both rows; the earlier, lowest still shows a sliver.
  expect(barRows(lines, 2)).toEqual(["       ████████", "▁▁▁▁▁▁▁████████"]);
  expect(lines.at(-1)).toBe("min -10 · avg -6 · max -2 · 2 readings");
});

test("a height below two still draws two rows, so the top and bottom labels both fit", () => {
  const lines = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + HOUR, width: 20, height: 1 });
  expect(lines[0]).toStartWith("3 │");
  expect(lines[1]).toStartWith("1 │");
  expect(lines[2]).toContain("└");
});

test("a tall chart has as many bar rows as asked, labelled only at the top and bottom", () => {
  const lines = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + HOUR, width: 20, height: 30 });
  expect(lines).toHaveLength(30 + 4);
  expect(lines[0]).toStartWith("3 │");
  expect(lines[29]).toStartWith("1 │");
  expect(lines.slice(1, 29).every((line) => line.startsWith("  │"))).toBe(true);
  expect(lines[30]).toContain("└");
});

test("the tallest column reaches the top row and the lowest still shows a sliver, at every height", () => {
  const points = Array.from({ length: 50 }, (_, i) => at(i, ((i * 37) % 23) - 4));
  for (const height of [2, 3, 5, 8, 12, 30]) {
    const rows = barRows(chart(points, { from: T0, to: T0 + HOUR, width: 70, height }), height);
    expect(rows[0]).toContain("█");
    // Every column with a reading shows something on the bottom row.
    const bottom = rows.at(-1) ?? "";
    expect(bottom.trimStart()).not.toContain(" ");
    expect(bottom).toContain("▁");
  }
});

test("bar rows never run past the width, whatever the labels", () => {
  const cases = [
    { values: [1e12, 3], unit: "Wh" },
    { values: [-0.001, 1e-9], unit: undefined },
    { values: [-5.25, 1234.5], unit: "°C" },
    { values: [1, 2], unit: "度度" },
  ];
  for (const { values, unit } of cases) {
    const points = values.map((value, i) => at(i * 20, value));
    for (const size of [30, 36, 50, 80, 200]) {
      const lines = chart(points, { from: T0, to: T0 + HOUR, width: size, height: 4, unit });
      for (const line of lines.slice(0, 5)) expect(width(line)).toBeLessThanOrEqual(size);
    }
  }
});

test("labels of very different magnitudes are right-aligned against one axis", () => {
  const lines = chart([at(0, 1e12), at(30, 3)], {
    from: T0,
    to: T0 + HOUR,
    width: 40,
    height: 3,
    unit: "Wh",
  });
  expect(lines[0]).toStartWith("1,000,000,000,000 Wh │");
  expect(lines[2]).toStartWith("                3 Wh │");
  const axis = lines.slice(0, 3).map((line) => line.indexOf("│"));
  expect(new Set(axis).size).toBe(1);
  expect(lines[3]?.indexOf("└")).toBe(axis[0]);
});

test("a unit with wide characters is measured by the columns it takes", () => {
  const lines = chart([at(0, 1), at(30, 3)], {
    from: T0,
    to: T0 + HOUR,
    width: 20,
    height: 2,
    unit: "度度",
  });
  expect(lines[0]).toBe("3 度度 │      ██████");
  expect(lines[1]).toBe("1 度度 │▁▁▁▁▁▁██████");
  expect(width(lines[2] ?? "")).toBe(20);
});

test("many readings are summarised without exhausting the stack", () => {
  const points = Array.from({ length: 200_000 }, (_, i) => ({ at: T0 + i * 10, value: i % 100 }));
  const lines = chart(points, { from: T0, to: T0 + HOUR, width: 40, height: 3 });
  expect(lines.at(-1)).toBe("min 0 · avg 49.5 · max 99 · 200,000 readings");
});

// ───────── chart: time axis ─────────

test("the time axis of an hour shows the start, middle, and end clock times", () => {
  const lines = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + HOUR, width: 60, height: 2 });
  expect(lines[3]).toMatch(/^ {3}12:00 pm +12:30 pm +1:00 pm$/);
  expect(width(lines[3] ?? "")).toBe(60);
});

test("a range of exactly a day still uses clock times; a millisecond more switches to dates", () => {
  const day = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + 24 * HOUR, width: 60, height: 2 });
  expect(day[3]).toMatch(/^ {3}12:00 pm +12:00 am +12:00 pm$/);
  const more = chart([at(0, 1), at(30, 3)], {
    from: T0,
    to: T0 + 24 * HOUR + 1,
    width: 60,
    height: 2,
  });
  expect(more[3]).toMatch(/^ {3}Sat 3 +Sun 4 +now$/);
});

test("a week's axis drops the middle date first when it is narrow", () => {
  const lines = chart([at(0, 1), at(30, 3)], {
    from: T0,
    to: T0 + 7 * 24 * HOUR,
    width: 14,
    height: 2,
  });
  expect(lines[3]).toBe("   Sat 3   now");
});

// ───────── chart: bugs found while probing ─────────

test("the time axis stays within the width when the start and end labels barely fit", () => {
  // Width 14 leaves 11 columns: "12:00 pm" + "1:00 pm" is 15, so the line ran to 18 columns.
  const lines = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + HOUR, width: 14, height: 2 });
  for (const line of lines.slice(0, 4)) expect(width(line)).toBeLessThanOrEqual(14);
});

test("the start and end time labels never run together", () => {
  // At width 18 (15 columns of bars) this printed "12:00 pm1:00 pm".
  const lines = chart([at(0, 1), at(30, 3)], { from: T0, to: T0 + HOUR, width: 18, height: 2 });
  expect(lines[3]).not.toContain("pm1");
  expect(lines[3]).toMatch(/12:00 pm +1:00 pm$|^ +12:00 pm$/);
});

test("a width narrower than the value labels does not draw rows wider than asked", () => {
  // Width 8 with "°C": labels are 4 wide, and the 4-column minimum made 10-column rows.
  const lines = chart([at(0, 1), at(30, 3)], {
    from: T0,
    to: T0 + HOUR,
    width: 8,
    height: 2,
    unit: "°C",
  });
  for (const line of lines.slice(0, 4)) expect(width(line)).toBeLessThanOrEqual(8);
});

test("readings that are not finite numbers are left out of the chart and summary", () => {
  // One NaN made every label and the summary "NaN" and blanked every bar; an Infinity became
  // the top label and squashed the finite readings to a sliver.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const lines = chart([at(0, bad), at(30, 3), at(40, 5)], {
      from: T0,
      to: T0 + HOUR,
      width: 20,
      height: 2,
    });
    expect(lines[0]).toStartWith("5 │");
    expect(lines[1]).toStartWith("3 │");
    expect(lines.at(-1)).toBe("min 3 · avg 4 · max 5 · 2 readings");
  }
});

test("readings that differ only by floating-point rounding draw as a flat line", () => {
  // 0.1 + 0.2 and 0.3 are labelled "0.3" alike, yet were drawn as a full-height step.
  const lines = chart([at(0, 0.1 + 0.2), at(30, 0.3)], {
    from: T0,
    to: T0 + HOUR,
    width: 20,
    height: 4,
  });
  const rows = barRows(lines, 4);
  expect(rows[0]).not.toContain("█");
  expect(new Set(rows.at(-1)).size).toBe(1);
});

// ───────── timelines: a bar colored by state ─────────

const state = (minutes: number, on: boolean | undefined) => ({ at: T0 + minutes * 60_000, on });

test("a state is drawn as one bar: solid while on, shaded while off", () => {
  const states = [state(0, false), state(15, true), state(45, false)];
  const lines = timeline(states, { from: T0, to: T0 + HOUR, width: 13, labels: ["On", "Off"] });
  // Twelve 5-minute columns: off for three, on for six, off for three.
  expect(lines[0]).toBe("│░░░██████░░░");
  expect(lines[1]).toBe("└────────────");
  expect(lines.at(-1)).toBe("█ On 50% · ░ Off 50% · 2 changes");
});

test("the state when the range began comes from the last record before it", () => {
  const lines = timeline([state(-600, true), state(30, false)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(lines[0]).toBe("│██░░");
  expect(lines.at(-1)).toContain("1 change");
  // Nothing happened in the range at all: it was simply on throughout.
  const steady = timeline([state(-600, true)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(steady[0]).toBe("│████");
  expect(steady.at(-1)).toBe("█ On 100% · ░ Off 0% · 0 changes");
});

test("a brief pulse still shows, time before the first record is blank, and unavailable is a gap", () => {
  // The pulse fills its column, but the share is measured in time: one minute of sixty.
  const brief = timeline([state(0, false), state(31, true), state(32, false)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(brief.at(-1)).toBe("█ On 2% · ░ Off 98% · 2 changes");
  const pulse = timeline([state(0, false), state(31, true), state(32, false)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(pulse[0]).toBe("│░░█░");
  const late = timeline([state(30, true)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(late[0]).toBe("│  ██");
  const gap = timeline([state(0, true), state(15, undefined), state(45, true)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
  });
  expect(gap[0]).toBe("│█  █");
});

test("timelines use the entity's own words and fit their width", () => {
  const lines = timeline([state(0, true), state(40, false)], {
    from: T0,
    to: T0 + HOUR,
    width: 60,
    labels: ["Open", "Closed"],
  });
  expect(lines.at(-1)).toMatch(/^█ Open \d+% · ░ Closed \d+% · 1 change$/);
  expect(lines[2]).toMatch(/^ 12:00 pm +12:30 pm +1:00 pm$/);
  for (const size of [2, 10, 40, 200]) {
    const out = timeline([state(0, true), state(40, false)], {
      from: T0,
      to: T0 + HOUR,
      width: size,
      labels: ["On", "Off"],
    });
    expect(Math.max(...out.slice(0, 3).map(width))).toBeLessThanOrEqual(size);
  }
  expect(timeline([], { from: T0, to: T0 + HOUR, width: 20, labels: ["On", "Off"] })).toEqual([
    "No history in this range.",
  ]);
});

test("records become a state series or a value series by domain", () => {
  const rec = (s: object, extra: object = {}) => ({
    state: s,
    available: true,
    updatedAt: T0,
    ...extra,
  });
  expect(seriesFor("light", [rec({ on: true, brightness: 0.4 }), rec({ on: false })])).toEqual({
    kind: "state",
    states: [
      { at: T0, on: true },
      { at: T0, on: false },
    ],
    labels: ["On", "Off"],
  });
  expect(seriesFor("switch", [rec({ on: true }, { available: false })])).toMatchObject({
    states: [{ on: undefined }],
  });
  expect(seriesFor("binary_sensor", [rec({ on: true, deviceClass: "door" })])).toMatchObject({
    labels: ["Open", "Closed"],
  });
  expect(seriesFor("binary_sensor", [rec({ on: true })])).toMatchObject({ labels: ["On", "Off"] });
  expect(seriesFor("lock", [rec({ locked: true })])).toMatchObject({
    states: [{ on: true }],
    labels: ["Locked", "Unlocked"],
    tone: "green",
  });
  expect(seriesFor("cover", [rec({ position: 0 }), rec({ position: 0.3 })])).toMatchObject({
    states: [{ on: false }, { on: true }],
    labels: ["Open", "Closed"],
  });
  expect(
    seriesFor("sensor", [rec({ value: 21.5, unit: "°C" }), rec({ value: null, unit: "°C" })]),
  ).toEqual({
    kind: "value",
    points: [{ at: T0, value: 21.5 }],
    unit: "°C",
  });
  expect(seriesFor("climate", [rec({ mode: "heat", currentTemp: 20 })])).toMatchObject({
    kind: "value",
    points: [{ value: 20 }],
  });
  // Nothing to plot for presses.
  // Words are named states.
  expect(seriesFor("sensor", [rec({ value: "offline" })])).toEqual({
    kind: "category",
    points: [{ at: T0, value: "offline" }],
  });
  expect(seriesFor("button", [rec({ pressedAt: 1 })])).toBeUndefined();
});

// ───────── stateColumns: one state per column ─────────

const cols = (states: StatePoint[], columns: number, from = T0, to = T0 + HOUR) =>
  stateColumns(states, from, to, columns);

test("a change exactly on a column's edge starts that column, not the one before it", () => {
  // Four 15-minute columns; changes at 15 and 30 are on edges.
  expect(cols([state(0, false), state(15, true), state(30, false)], 4)).toEqual([
    false,
    true,
    false,
    false,
  ]);
});

test("a record exactly at the start of the range holds from the first column", () => {
  expect(cols([state(0, true)], 4)).toEqual([true, true, true, true]);
});

test("a record exactly at the end of the range lands in the last column; one after it is ignored", () => {
  expect(cols([state(0, false), state(60, true)], 4)).toEqual([false, false, false, true]);
  expect(cols([state(0, false), state(61, true)], 4)).toEqual([false, false, false, false]);
});

test("records are placed by time, whatever order they arrive in", () => {
  const sorted = [state(0, true), state(15, false), state(30, false), state(50, true)];
  const shuffled = [sorted[2], sorted[0], sorted[3], sorted[1]].flatMap((s) => (s ? [s] : []));
  expect(cols(shuffled, 4)).toEqual(cols(sorted, 4));
  expect(cols(shuffled, 4)).toEqual([true, false, false, true]);
});

test("of two records at the same moment, the later one listed is what carries on", () => {
  // Mid-column: the zero-length "on" still marks its column, but off carries on after it.
  expect(cols([state(0, false), state(20, true), state(20, false)], 4).slice(2)).toEqual([
    false,
    false,
  ]);
  expect(cols([state(0, false), state(20, false), state(20, true)], 4).slice(2)).toEqual([
    true,
    true,
  ]);
  // Before the range: the later of the two is what the range starts as.
  expect(cols([state(-5, false), state(-5, true)], 2)).toEqual([true, true]);
});

test("a single column is on if the state was on at any moment of the range", () => {
  expect(cols([state(0, false), state(30, true), state(40, false)], 1)).toEqual([true]);
  expect(cols([state(-5, false)], 1)).toEqual([false]);
  expect(cols([state(-5, false), state(60, true)], 1)).toEqual([true]);
});

test("more columns than records: columns before the first record are unknown, the rest carry it", () => {
  const out = cols([state(10, true)], 12);
  expect(out).toHaveLength(12);
  expect(out.slice(0, 2)).toEqual([undefined, undefined]);
  expect(out.slice(2).every((cell) => cell === true)).toBe(true);
});

test("a range that was unavailable throughout is unknown in every column", () => {
  expect(cols([state(-5, undefined), state(10, undefined)], 4)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("unavailable at the start, then known, leaves only the unavailable stretch blank", () => {
  expect(cols([state(-5, undefined), state(20, true)], 4)).toEqual([undefined, true, true, true]);
  // Unavailable partway through a column that was on still shows on, then a gap.
  expect(cols([state(-5, false), state(5, true), state(10, undefined)], 2)).toEqual([
    true,
    undefined,
  ]);
});

test("an empty range or no columns does not throw and gives the asked-for length", () => {
  expect(cols([state(0, true)], 3, T0, T0)).toHaveLength(3);
  expect(cols([state(0, true)], 0)).toEqual([]);
  expect(cols([], 5)).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test("two thousand columns come back quickly, exactly that many, split where the state changed", () => {
  const many = Array.from({ length: 5000 }, (_, i) => state(-1 + i * 1e-6, false));
  many.push(state(30, true));
  const started = performance.now();
  const out = cols(many, 2000);
  expect(performance.now() - started).toBeLessThan(200);
  expect(out).toHaveLength(2000);
  expect(out.filter((cell) => cell === true)).toHaveLength(1000);
  expect(out.filter((cell) => cell === false)).toHaveLength(1000);
});

test("a reversed range (to before from) has nothing known, as buckets() does", () => {
  // stateColumns(…, from = T0 + HOUR, to = T0) returned [true, true, true] for a record at T0;
  // buckets() returns all undefined for the same reversed range.
  expect(cols([state(0, true)], 3, T0 + HOUR, T0)).toEqual([undefined, undefined, undefined]);
});

// ───────── timeline: share and changes ─────────

const line = (states: StatePoint[], width = 13, labels: [string, string] = ["On", "Off"]) =>
  timeline(states, { from: T0, to: T0 + HOUR, width, labels });
const shares = (summary: string | undefined) =>
  [...(summary ?? "").matchAll(/(\d+)%/g)].map((m) => Number(m[1]));

test("the share is of the time the state was known, and the two shares add to 100", () => {
  // Unknown for the first half hour, then 15 minutes on and 15 off.
  const late = line([state(30, true), state(45, false)]);
  expect(late[0]).toBe("│      ███░░░");
  expect(late.at(-1)).toBe("█ On 50% · ░ Off 50% · 1 change");
  // On 15 minutes, unavailable for 30, off for 15.
  const gap = line([state(0, true), state(15, undefined), state(45, false)]);
  expect(gap[0]).toBe("│███      ░░░");
  expect(gap.at(-1)).toBe("█ On 50% · ░ Off 50% · 1 change");
  // On 10 of the 50 known minutes.
  const uneven = line([state(0, true), state(10, undefined), state(20, false)]);
  expect(uneven.at(-1)).toBe("█ On 20% · ░ Off 80% · 1 change");
  for (const out of [late, gap, uneven]) {
    expect(shares(out.at(-1)).reduce((a, b) => a + b, 0)).toBe(100);
  }
});

test("a record from before the range and none inside it fills the whole range with no changes", () => {
  const out = line([state(-10, false)]);
  expect(out[0]).toBe(`│${"░".repeat(12)}`);
  expect(out.at(-1)).toBe("█ On 0% · ░ Off 100% · 0 changes");
});

test("a record that repeats the state it was already in is not a change", () => {
  expect(line([state(0, true), state(10, true), state(20, true)]).at(-1)).toBe(
    "█ On 100% · ░ Off 0% · 0 changes",
  );
});

test("unavailable in between is a change only if the state differs on either side", () => {
  expect(line([state(0, true), state(10, undefined), state(20, true)]).at(-1)).toContain(
    "0 changes",
  );
  expect(line([state(0, true), state(10, undefined), state(20, false)]).at(-1)).toContain(
    "· 1 change",
  );
});

test("a change exactly at the start of the range counts; one before it does not", () => {
  expect(line([state(-10, false), state(0, true)]).at(-1)).toBe("█ On 100% · ░ Off 0% · 1 change");
  expect(line([state(-20, false), state(-10, true)]).at(-1)).toBe(
    "█ On 100% · ░ Off 0% · 0 changes",
  );
});

test("a state that was on, or off, for any time never reads 0%", () => {
  // On for 14.4 s of an hour (0.4%) rendered "█ On 0% · ░ Off 100% · 2 changes" beside a
  // bar showing an on column; on for all but 14.4 s rendered "░ Off 0%".
  const brief = line([
    state(0, false),
    state(30, true),
    { at: T0 + 30 * 60_000 + 14_400, on: false },
  ]);
  expect(brief.at(-1)).not.toContain("On 0%");
  const mostly = line([
    state(0, true),
    state(30, false),
    { at: T0 + 30 * 60_000 + 14_400, on: true },
  ]);
  expect(mostly.at(-1)).not.toContain("Off 0%");
});

test("a state known only at the very end of the range is not summarized as off throughout", () => {
  // The bar's last column is on, but no time was known, so the share fell back to
  // "█ On 0% · ░ Off 100%" for an entity that was never off. The same for from === to.
  const out = line([state(60, true)]);
  expect(out[0]).toBe("│           █");
  expect(out.at(-1)).not.toContain("Off 100%");
  const empty = timeline([state(0, true)], { from: T0, to: T0, width: 13, labels: ["On", "Off"] });
  expect(empty.at(-1)).not.toContain("Off 100%");
});

test("nothing known in the range, or only records after it, says there is no history", () => {
  expect(line([state(61, true)])).toEqual(["No history in this range."]);
  expect(line([state(0, undefined)])).toEqual(["No history in this range."]);
});

// ───────── timeline: widths, labels, tone ─────────

test("the bar and axis rows are exactly the width asked for, from 2 to 200", () => {
  const states = [state(-5, true), state(7, false), state(31, undefined), state(44, true)];
  for (let size = 2; size <= 200; size++) {
    const out = line(states, size);
    expect(width(out[0] ?? "")).toBe(size);
    expect(width(out[1] ?? "")).toBe(size);
    expect(width(out[2] ?? "")).toBeLessThanOrEqual(size);
  }
});

test("the narrowest timelines still draw a bar", () => {
  expect(line([state(0, true), state(30, false)], 2)[0]).toBe("│█");
  expect(line([state(0, true), state(30, false)], 3)[0]).toBe("│█░");
});

test("a timeline one column wide is no wider than one column", () => {
  // Width 1 leaves no room for a bar, yet `columns` is floored at 1, so the bar row is
  // "│█", two columns wide.
  const out = line([state(0, true), state(30, false)], 1);
  for (const row of out.slice(0, 3)) expect(width(row)).toBeLessThanOrEqual(1);
});

test("labels with spaces are used as given", () => {
  const out = line([state(0, true), state(30, false)], 40, ["Wide open", "Shut tight"]);
  expect(out.at(-1)).toBe("█ Wide open 50% · ░ Shut tight 50% · 1 change");
});

test("the tone colors the on runs and the summary's on glyph, even with colors off", () => {
  const out = timeline([state(0, true), state(30, false)], {
    from: T0,
    to: T0 + HOUR,
    width: 5,
    labels: ["On", "Off"],
    tone: (text) => `<${text}>`,
  });
  expect(out[0]).toBe("│<██>░░");
  expect(out.at(-1)).toBe("<█> On 50% · ░ Off 50% · 1 change");
});

// ───────── seriesFor: edge cases ─────────

const record = (s: unknown, extra: Row = {}): Row => ({
  state: s,
  available: true,
  updatedAt: T0,
  ...extra,
});

test("no records gives an empty series for every chartable domain, and each draws without throwing", () => {
  const range = { from: T0, to: T0 + HOUR, width: 30 };
  for (const domain of ["light", "switch", "binary_sensor", "lock", "cover", "sensor", "climate"]) {
    const series = seriesFor(domain, []);
    expect(series).toBeDefined();
    if (series?.kind === "state") {
      expect(series.states).toEqual([]);
      expect(timeline(series.states, { ...range, labels: series.labels })).toEqual([
        "No history in this range.",
      ]);
    } else if (series?.kind === "value") {
      expect(series.points).toEqual([]);
      expect(chart(series.points, { ...range, height: 4, unit: series.unit })).toEqual([
        "No readings in this range.",
      ]);
    }
  }
  expect(seriesFor("button", [])).toBeUndefined();
});

test("an unknown domain has nothing to chart", () => {
  expect(seriesFor("fan", [record({ on: true })])).toBeUndefined();
  expect(seriesFor("", [record({ on: true })])).toBeUndefined();
});

test("records missing a time or a state do not throw", () => {
  const untimed = seriesFor("light", [{ state: { on: true }, available: true }]);
  expect(untimed?.kind).toBe("state");
  if (untimed?.kind === "state") expect(Number.isFinite(untimed.states[0]?.at)).toBe(true);
  const stateless = seriesFor("light", [{ available: true, updatedAt: T0 }]);
  expect(stateless).toMatchObject({ kind: "state", states: [{ at: T0 }] });
  // A sensor with no state has no number to plot.
  expect(seriesFor("sensor", [{ available: true, updatedAt: T0 }])).toBeUndefined();
});

test("a sensor that mixes numbers and words plots only the numbers", () => {
  const series = seriesFor("sensor", [
    record({ value: 1, unit: "W" }, { updatedAt: T0 }),
    record({ value: "high", unit: "W" }, { updatedAt: T0 + 1 }),
    record({ value: 3, unit: "W" }, { updatedAt: T0 + 2 }),
  ]);
  expect(series).toEqual({
    kind: "value",
    points: [
      { at: T0, value: 1 },
      { at: T0 + 2, value: 3 },
    ],
    unit: "W",
  });
});

test("a sensor whose last record is unavailable keeps the earlier readings and the unit", () => {
  // The core keeps the last state on a record that goes unavailable.
  const series = seriesFor("sensor", [
    record({ value: 1, unit: "W" }),
    record({ value: 1, unit: "W" }, { available: false, updatedAt: T0 + 1 }),
  ]);
  expect(series).toEqual({ kind: "value", points: [{ at: T0, value: 1 }], unit: "W" });
});

test("a numeric sensor that is unavailable still has a value series to draw", () => {
  // Returned undefined, the answer meant for word-valued sensors. dash-run's loadHistory
  // asks seriesFor about the current state alone (dash-run.ts:349), so a sensor that is
  // unavailable right now (as every entity is after a restart until it reports) gets no
  // history chart at all.
  expect(seriesFor("sensor", [record({ value: 21, unit: "°C" }, { available: false })])).toEqual({
    kind: "value",
    points: [],
    unit: "°C",
  });
});

test("binary sensors use their device class's words, and On/Off for any other class", () => {
  const words: [string | undefined, [string, string]][] = [
    ["motion", ["Motion", "Clear"]],
    ["occupancy", ["Occupied", "Clear"]],
    ["door", ["Open", "Closed"]],
    ["window", ["Open", "Closed"]],
    ["leak", ["Wet", "Dry"]],
    ["smoke", ["Smoke", "Clear"]],
    ["garage_door", ["On", "Off"]],
    [undefined, ["On", "Off"]],
  ];
  for (const [deviceClass, labels] of words) {
    expect(seriesFor("binary_sensor", [record({ on: true, deviceClass })])).toEqual({
      kind: "state",
      states: [{ at: T0, on: true }],
      labels,
    });
  }
});

test("a cover that reports no position is unknown, not closed", () => {
  // A cover whose state is only { motion: "stopped" } was charted as Closed 100% of the time.
  expect(
    seriesFor("cover", [record({ motion: "stopped" }), record({ position: null })]),
  ).toMatchObject({ states: [{ on: undefined }, { on: undefined }] });
});

test("a thermostat plots only records with a current temperature", () => {
  expect(seriesFor("climate", [record({ mode: "heat" })])).toBeUndefined();
  expect(
    seriesFor("climate", [
      record({ mode: "heat" }),
      record({ currentTemp: 20 }, { updatedAt: T0 + 1 }),
    ]),
  ).toEqual({ kind: "value", points: [{ at: T0 + 1, value: 20 }], unit: "°" });
});

// ───────── seriesFor in the unit system ─────────

const reading = (minutes: number, s: object, extra: object = {}) => ({
  state: s,
  available: true,
  updatedAt: T0 + minutes * 60_000,
  ...extra,
});
const imperial = <T>(fn: () => T): T => {
  setUnits("imperial");
  try {
    return fn();
  } finally {
    setUnits("metric");
  }
};

test("in imperial a Celsius sensor's series is plotted in Fahrenheit", () => {
  const records = [reading(0, { value: 20, unit: "°C" }), reading(5, { value: -40, unit: "°C" })];
  expect(imperial(() => seriesFor("sensor", records))).toEqual({
    kind: "value",
    points: [
      { at: T0, value: 68 },
      { at: T0 + 5 * 60_000, value: -40 },
    ],
    unit: "°F",
  });
});

test("in metric a Fahrenheit sensor's series is plotted in Celsius", () => {
  const series = seriesFor("sensor", [reading(0, { value: 212, unit: "°F" })]);
  expect(series).toEqual({ kind: "value", points: [{ at: T0, value: 100 }], unit: "°C" });
});

test("in imperial a thermostat's series is in Fahrenheit and keeps its bare degree label", () => {
  const series = imperial(() =>
    seriesFor("climate", [
      reading(0, { mode: "heat", currentTemp: 20 }),
      reading(5, { mode: "heat" }),
      reading(10, { mode: "heat", currentTemp: 0 }),
    ]),
  );
  expect(series).toEqual({
    kind: "value",
    points: [
      { at: T0, value: 68 },
      { at: T0 + 10 * 60_000, value: 32 },
    ],
    unit: "°",
  });
});

test("the weather's series is its temperature in Celsius, with a bare degree label", () => {
  const records = [
    reading(0, { domain: "weather", condition: "clear", temperature: 11.8 }),
    reading(5, { domain: "weather", condition: "rain" }), // no temperature: left out
    reading(10, { domain: "weather", condition: "rain", temperature: 9 }, { available: false }),
    reading(15, { domain: "weather", condition: "rain", temperature: 10.5, unit: "°F" }),
  ];
  expect(seriesFor("weather", records)).toEqual({
    kind: "value",
    // A stray unit on the state is not believed: the weather is always Celsius.
    points: [
      { at: T0, value: 11.8 },
      { at: T0 + 15 * 60_000, value: 10.5 },
    ],
    unit: "°",
  });
});

test("in imperial the weather's series is in Fahrenheit", () => {
  const series = imperial(() =>
    seriesFor("weather", [
      reading(0, { domain: "weather", condition: "clear", temperature: 20 }),
      reading(5, { domain: "weather", condition: "snow", temperature: -40 }),
    ]),
  );
  expect(series).toEqual({
    kind: "value",
    points: [
      { at: T0, value: 68 },
      { at: T0 + 5 * 60_000, value: -40 },
    ],
    unit: "°",
  });
});

test("weather with no temperatures has nothing to plot; its conditions are not categories", () => {
  expect(
    seriesFor("weather", [reading(0, { domain: "weather", condition: "clear" })]),
  ).toBeUndefined();
  expect(seriesFor("weather", [])).toEqual({ kind: "value", points: [], unit: "°" });
});

test("in imperial a series with no unit or an unconvertible one is left as reported", () => {
  expect(imperial(() => seriesFor("sensor", [reading(0, { value: 3 })]))).toEqual({
    kind: "value",
    points: [{ at: T0, value: 3 }],
    unit: undefined,
  });
  expect(imperial(() => seriesFor("sensor", [reading(0, { value: 3, unit: "%" })]))).toEqual({
    kind: "value",
    points: [{ at: T0, value: 3 }],
    unit: "%",
  });
});

test("in imperial unavailable and non-numeric readings are still dropped from a value series", () => {
  const series = imperial(() =>
    seriesFor("sensor", [
      reading(0, { value: 10, unit: "°C" }),
      reading(5, { value: 99, unit: "°C" }, { available: false }),
      reading(10, { value: null, unit: "°C" }),
    ]),
  );
  expect(series).toEqual({ kind: "value", points: [{ at: T0, value: 50 }], unit: "°F" });
});

test("an imperial series charts with Fahrenheit on its axis and in its summary", () => {
  const series = imperial(() =>
    seriesFor("sensor", [
      reading(0, { value: 10, unit: "°C" }),
      reading(30, { value: 30, unit: "°C" }),
    ]),
  );
  if (series?.kind !== "value") throw new Error("expected a value series");
  const lines = chart(series.points, {
    from: T0,
    to: T0 + HOUR,
    width: 40,
    height: 2,
    unit: series.unit,
  });
  expect(lines.at(-1)).toBe("min 50 °F · avg 68 °F · max 86 °F · 2 readings");
});

// The whole series is converted by the last record's unit, so the earlier Fahrenheit 72 is
// treated as Celsius. Observed: points 161.6, 71.6 °F; expected: 72, 71.6 °F.
test("a series whose unit changes midway converts each reading by its own unit", () => {
  const series = imperial(() =>
    seriesFor("sensor", [
      reading(0, { value: 72, unit: "°F" }),
      reading(5, { value: 22, unit: "°C" }),
    ]),
  );
  expect(series).toMatchObject({ unit: "°F", points: [{ value: 72 }, { value: 71.6 }] });
});
