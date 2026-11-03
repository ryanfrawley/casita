import { expect, test } from "bun:test";
import {
  linePath,
  niceTicks,
  type Point,
  seriesColor,
  sortedPoints,
  timeInState,
  timeTicks,
  toPoint,
  valueAt,
  valueRange,
} from "./chart-math.ts";
import { DAY, HOUR } from "./time.ts";

test("a point is read from a pair or an object", () => {
  expect(toPoint([10, 2.5])).toEqual({ t: 10, v: 2.5 });
  expect(toPoint({ t: 10, v: null })).toEqual({ t: 10, v: null });
});

test("points come back in time order whatever order they were given in", () => {
  const sorted = sortedPoints({ label: "x", points: [[30, 3], { t: 10, v: 1 }, [20, null]] });
  expect(sorted.map((point) => point.t)).toEqual([10, 20, 30]);
});

test("a series takes its own colour, else the one for its place", () => {
  expect(seriesColor({}, 0)).toBe("var(--series-1)");
  expect(seriesColor({}, 1)).toBe("var(--series-2)");
  expect(seriesColor({ color: "series-3" }, 0)).toBe("var(--series-3)");
});

test.each([
  [0, 100, [0, 20, 40, 60, 80, 100]],
  [17.3, 22.4, [17, 18, 19, 20, 21, 22, 23]],
  [5, 25, [5, 10, 15, 20, 25]],
  [0.12, 0.31, [0.1, 0.15, 0.2, 0.25, 0.3, 0.35]],
  [-4, 4, [-4, -2, 0, 2, 4]],
])("ticks from %p to %p are round and cover the range", (min, max, expected) => {
  expect(niceTicks(min, max, 4)).toEqual(expected);
});

test("a flat line gets room either side; no readings at all is 0 to 1", () => {
  expect(valueRange([21, 21, 21])).toEqual([20, 22]);
  expect(valueRange([18, 21.5, 19])).toEqual([18, 21.5]);
  expect(valueRange([])).toEqual([0, 1]);
  expect(niceTicks(...valueRange([21]), 4)).toEqual([20, 20.5, 21, 21.5, 22]);
});

test("ticks carry no floating-point tails", () => {
  for (const tick of niceTicks(0.1, 0.7, 4)) expect(String(tick).length).toBeLessThan(6);
});

test("a day at 960px gets a tick every three hours, on the local hour", () => {
  // UTC−7: local midnight is 07:00 UTC.
  const t0 = Date.UTC(2026, 9, 4, 7);
  const { ticks, step } = timeTicks(t0, t0 + DAY, 960, 7 * 60);
  expect(step).toBe(3 * HOUR);
  expect(ticks).toHaveLength(9);
  expect(ticks[0]).toBe(t0);
  expect(ticks.at(-1)).toBe(t0 + DAY);
});

test("a narrow plot gets fewer ticks, never fewer than the range allows", () => {
  const t0 = Date.UTC(2026, 9, 4);
  expect(timeTicks(t0, t0 + DAY, 200, 0).step).toBe(12 * HOUR);
  expect(timeTicks(t0, t0 + HOUR, 960, 0).step).toBe(HOUR / 4);
  expect(timeTicks(t0, t0 + 60 * DAY, 300, 0).step).toBe(7 * DAY);
});

test("ticks start at the first round time inside the range, not before it", () => {
  const t0 = Date.UTC(2026, 9, 4, 0, 20);
  const { ticks } = timeTicks(t0, t0 + 4 * HOUR, 480, 0);
  expect(ticks[0]).toBe(Date.UTC(2026, 9, 4, 1));
  for (const tick of ticks) expect(tick).toBeGreaterThanOrEqual(t0);
});

test("a half-hour time zone still lands ticks on its own hours", () => {
  // UTC+5:30: local hours fall on the half hour in UTC.
  const t0 = Date.UTC(2026, 9, 4, 0);
  const { ticks } = timeTicks(t0, t0 + 6 * HOUR, 960, -330);
  for (const tick of ticks) expect(new Date(tick).getUTCMinutes()).toBe(30);
});

const points: Point[] = [
  { t: 0, v: 18 },
  { t: 10, v: 21 },
  { t: 20, v: null },
  { t: 30, v: 19 },
];

test("a measured series answers with its nearest point", () => {
  expect(valueAt(points, 4)).toEqual({ t: 0, v: 18 });
  expect(valueAt(points, 6)).toEqual({ t: 10, v: 21 });
  // The nearest point may be a gap: the chart then says Unavailable, it does not borrow a neighbour.
  expect(valueAt(points, 19)).toEqual({ t: 20, v: null });
  expect(valueAt([], 5)).toBeNull();
});

test("a stepped series answers with the value in force", () => {
  expect(valueAt(points, 9, true)).toEqual({ t: 0, v: 18 });
  expect(valueAt(points, 10, true)).toEqual({ t: 10, v: 21 });
  expect(valueAt(points, 99, true)).toEqual({ t: 30, v: 19 });
  expect(valueAt(points, -1, true)).toBeNull();
});

const x = (t: number) => t;
const y = (v: number) => v * 10;

test("a line is drawn point to point", () => {
  expect(linePath(points.slice(0, 2), x, y)).toBe("M0.0 180.0L10.0 210.0");
});

test("a gap breaks the line and the next point starts a new one", () => {
  expect(linePath(points, x, y)).toBe("M0.0 180.0L10.0 210.0M30.0 190.0");
});

test("a stepped line holds each value until the next and runs on to the right edge", () => {
  expect(linePath(points.slice(0, 2), x, y, true, 50)).toBe("M0.0 180.0H10.0V210.0H50.0");
});

test("a stepped line that ends in a gap is not carried to the edge", () => {
  expect(linePath(points.slice(0, 3), x, y, true, 50)).toBe("M0.0 180.0H10.0V210.0");
});

test("no points, or only gaps, draw nothing", () => {
  expect(linePath([], x, y)).toBe("");
  expect(linePath([{ t: 0, v: null }], x, y, true, 50)).toBe("");
});

test("time in a state adds its segments; an open one runs to the end of the range", () => {
  const segments = [
    { from: 0, to: 10, state: "on" },
    { from: 10, to: 40, state: "off" },
    { from: 40, state: "on" },
  ];
  expect(timeInState(segments, "on", [0, 100])).toBe(70);
  expect(timeInState(segments, "off", [0, 100])).toBe(30);
  expect(timeInState(segments, "jammed", [0, 100])).toBe(0);
});

test("a segment that began before the range counts only from the range's start", () => {
  expect(timeInState([{ from: -50, to: 20, state: "on" }], "on", [0, 100])).toBe(20);
});
