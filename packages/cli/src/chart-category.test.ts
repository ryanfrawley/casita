import { expect, test } from "bun:test";
import { categoriesFor, categoryTimeline, seriesFor } from "./chart.ts";
import { setColor, width } from "./style.ts";

setColor(false);
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0);
const at = (minutes: number, value: string | undefined) => ({ at: T0 + minutes * 60_000, value });

test("each named state gets its own shape, in order of time spent, with shares in the legend", () => {
  const points = [at(0, "asleep"), at(30, "online"), at(45, "driving")];
  const lines = categoryTimeline(points, { from: T0, to: T0 + HOUR, width: 13 });
  // Twelve 5-minute columns: asleep for six, online for three, driving for three.
  expect(lines[0]).toBe("│██████▓▓▓▒▒▒");
  expect(lines[1]).toBe("└────────────");
  expect(lines.at(-1)).toBe("█ asleep 50% · ▓ online 25% · ▒ driving 25% · 2 changes");
});

test("the state when the range began carries in; shares are measured in time", () => {
  const lines = categoryTimeline([at(-600, "asleep"), at(58, "online")], {
    from: T0,
    to: T0 + HOUR,
    width: 7,
  });
  // Two minutes online does not win its ten-minute column, but it is counted.
  expect(lines[0]).toBe("│██████");
  expect(lines.at(-1)).toBe("█ asleep 97% · ▓ online 3% · 1 change");
  const steady = categoryTimeline([at(-600, "asleep")], { from: T0, to: T0 + HOUR, width: 5 });
  expect(steady[0]).toBe("│████");
  expect(steady.at(-1)).toBe("█ asleep 100% · 0 changes");
});

test("unknown stretches are blank and left out of the shares; repeats are not changes", () => {
  const points = [at(15, "online"), at(30, undefined), at(45, "online"), at(50, "online")];
  const lines = categoryTimeline(points, { from: T0, to: T0 + HOUR, width: 5 });
  expect(lines[0]).toBe("│ █ █");
  expect(lines.at(-1)).toBe("█ online 100% · 0 changes");
});

test("many states share the last shape; nothing in range says so; lines fit their width", () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const lines = categoryTimeline(
    names.map((n, i) => at(i * 10, n)),
    { from: T0, to: T0 + HOUR, width: 61 },
  );
  expect(lines[0]).toMatch(/^│█+▓+▒+░+$/);
  expect(lines.at(-1)).toContain("5 changes");
  for (const size of [1, 2, 10, 80, 200]) {
    const out = categoryTimeline([at(0, "asleep"), at(40, "driving")], {
      from: T0,
      to: T0 + HOUR,
      width: size,
    });
    expect(Math.max(...out.slice(0, 3).map(width))).toBeLessThanOrEqual(size);
  }
  expect(categoryTimeline([], { from: T0, to: T0 + HOUR, width: 20 })).toEqual([
    "No history in this range.",
  ]);
  expect(categoryTimeline([at(10, undefined)], { from: T0, to: T0 + HOUR, width: 20 })).toEqual([
    "No history in this range.",
  ]);
  expect(categoryTimeline([at(0, "x")], { from: T0 + HOUR, to: T0, width: 20 })).toEqual([
    "No history in this range.",
  ]);
});

test("records of a word-valued sensor become named states; blanks and outages are unknown", () => {
  const rec = (value: unknown, available = true) => ({
    state: { domain: "sensor", value },
    available,
    updatedAt: T0,
  });
  expect(
    categoriesFor([rec("asleep"), rec(""), rec(null), rec("online", false), rec("driving")]),
  ).toEqual([
    { at: T0, value: "asleep" },
    { at: T0, value: undefined },
    { at: T0, value: undefined },
    { at: T0, value: undefined },
    { at: T0, value: "driving" },
  ]);
});

const HOUR_RANGE = { from: T0, to: T0 + HOUR };
const ESC = String.fromCharCode(27);
/** The escape code that starts a color, e.g. blue's "\x1b[38;5;110m". */
const sgr = (code: string) => `${ESC}[${code}m`;
const BLUE = sgr("38;5;110");
const DIM = sgr("38;5;245");

test("a column split evenly between two states shows the one that came first", () => {
  // Two 30-minute columns; the first is 15 minutes asleep, then 15 online.
  const lines = categoryTimeline([at(0, "asleep"), at(15, "online"), at(30, "asleep")], {
    ...HOUR_RANGE,
    width: 3,
  });
  expect(lines[0]).toBe("│██");
  expect(lines.at(-1)).toBe("█ asleep 75% · ▓ online 25% · 2 changes");
});

test("states with equal time keep the order they were first seen in, whatever the input order", () => {
  const forward = categoryTimeline([at(0, "online"), at(30, "asleep")], {
    ...HOUR_RANGE,
    width: 5,
  });
  const shuffled = categoryTimeline([at(30, "asleep"), at(0, "online")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(forward[0]).toBe("│██▓▓");
  expect(forward.at(-1)).toBe("█ online 50% · ▓ asleep 50% · 1 change");
  expect(shuffled).toEqual(forward);
});

test("unsorted points are drawn in time order and the caller's array is left alone", () => {
  const points = [at(45, "driving"), at(0, "asleep"), at(30, "online")];
  const copy = points.map((p) => ({ ...p }));
  const lines = categoryTimeline(points, { ...HOUR_RANGE, width: 13 });
  expect(lines[0]).toBe("│██████▓▓▓▒▒▒");
  expect(points).toEqual(copy);
});

test("a state that ended before the range is neither shown nor counted as a change", () => {
  const lines = categoryTimeline([at(-20, "asleep"), at(-10, "online")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines[0]).toBe("│████");
  expect(lines.at(-1)).toBe("█ online 100% · 0 changes");
});

test("a change exactly at the start of the range counts and the new state fills the bar", () => {
  const lines = categoryTimeline([at(-5, "asleep"), at(0, "online")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines[0]).toBe("│████");
  expect(lines.at(-1)).toBe("█ online 100% · 1 change");
});

test("a reading exactly at the end of the range adds no time to its state", () => {
  const lines = categoryTimeline([at(0, "asleep"), at(60, "online")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines[0]).toBe("│████");
  expect(lines.at(-1)).toMatch(/^█ asleep 100% · /);
  expect(lines.at(-1)).not.toContain("online");
});

test("readings after the range are ignored", () => {
  const lines = categoryTimeline([at(0, "asleep"), at(61, "online")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines.at(-1)).toBe("█ asleep 100% · 0 changes");
});

test("of two readings at the same moment the later one in the input wins", () => {
  const lines = categoryTimeline([at(0, "asleep"), at(30, "online"), at(30, "driving")], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines[0]).toBe("│██▓▓");
  expect(lines.at(-1)).toMatch(/^█ asleep 50% · ▓ driving 50% · /);
});

test("an empty range has no history to show", () => {
  expect(categoryTimeline([at(-5, "asleep")], { from: T0, to: T0, width: 10 })).toEqual([
    "No history in this range.",
  ]);
});

test("at width 2 the bar, axis, and labels fit in two columns", () => {
  const lines = categoryTimeline([at(0, "asleep"), at(30, "online")], { ...HOUR_RANGE, width: 2 });
  expect(lines[0]).toBe("│█");
  for (const line of lines.slice(0, 3)) expect(width(line)).toBeLessThanOrEqual(2);
});

test("at width 1 the bar, axis, and labels still fit in one column", () => {
  const lines = categoryTimeline([at(0, "asleep")], { ...HOUR_RANGE, width: 1 });
  for (const line of lines.slice(0, 3)) expect(width(line)).toBeLessThanOrEqual(1);
});

test("a range shorter in milliseconds than the bar has columns is still filled to the end", () => {
  // Ten milliseconds over twenty columns: asleep the whole time, so every column is asleep.
  const lines = categoryTimeline([{ at: T0, value: "asleep" }], {
    from: T0,
    to: T0 + 10,
    width: 21,
  });
  expect(lines[0]).toBe(`│${"█".repeat(20)}`);
});

test("more than four states repeat the last shape but each is still named in the legend", () => {
  const names = ["a", "b", "c", "d", "e"];
  const lines = categoryTimeline(
    names.map((n, i) => at(i * 12, n)),
    { ...HOUR_RANGE, width: 6 },
  );
  expect(lines[0]).toBe("│█▓▒░░");
  expect(lines.at(-1)).toBe("█ a 20% · ▓ b 20% · ▒ c 20% · ░ d 20% · ░ e 20% · 4 changes");
});

test("with colors on, no two states share both a color and a shape", () => {
  setColor(true);
  try {
    // Six states: the fifth and sixth both fall back to the last shape, and asleep and
    // suspended both have the dim color, so they would look the same in bar and legend.
    const names = ["a", "b", "c", "d", "asleep", "suspended"];
    const legend = categoryTimeline(
      names.map((n, i) => at(i * 10, n)),
      { ...HOUR_RANGE, width: 7 },
    ).at(-1);
    const swatches = names.map((n) => {
      const entry = (legend ?? "").split(" · ").find((part) => part.includes(` ${n} `)) ?? "";
      return entry.slice(0, entry.indexOf(` ${n} `));
    });
    expect(new Set(swatches).size).toBe(names.length);
  } finally {
    setColor(false);
  }
});

test("a state's fixed color does not depend on the case of its name", () => {
  setColor(true);
  try {
    const lines = categoryTimeline([at(0, "Driving"), at(30, "ASLEEP")], {
      ...HOUR_RANGE,
      width: 3,
    });
    expect(lines[0]).toBe(`${sgr("38;5;240")}│${sgr("0")}${BLUE}█${sgr("0")}${DIM}▓${sgr("0")}`);
    expect(lines.at(-1)).toContain(`${BLUE}█${sgr("0")} Driving 50%`);
    expect(lines.at(-1)).toContain(`${DIM}▓${sgr("0")} ASLEEP 50%`);
  } finally {
    setColor(false);
  }
});

test("states with no fixed color take the spare colors in turn", () => {
  setColor(true);
  try {
    // driving keeps blue; the two unknown states get the first two spares, amber then blue.
    const legend = categoryTimeline([at(0, "parked"), at(25, "driving"), at(45, "towing")], {
      ...HOUR_RANGE,
      width: 13,
    }).at(-1);
    expect(legend).toContain(`${sgr("38;5;215")}█${sgr("0")} parked`);
    expect(legend).toContain(`${BLUE}▓${sgr("0")} driving`);
    expect(legend).toContain(`${BLUE}▒${sgr("0")} towing`);
  } finally {
    setColor(false);
  }
});

test("a very long state name is kept whole in the legend and does not widen the bar", () => {
  const long = "waiting-for-the-software-update-to-finish-installing";
  const lines = categoryTimeline([at(0, long), at(30, "online")], { ...HOUR_RANGE, width: 11 });
  expect(width(lines[0] ?? "")).toBe(11);
  expect(lines.at(-1)).toBe(`█ ${long} 50% · ▓ online 50% · 1 change`);
});

test("a share under half a percent reads <1% and its complement >99%", () => {
  // Online for the last second of the hour.
  const lines = categoryTimeline([at(0, "asleep"), { at: T0 + HOUR - 1000, value: "online" }], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines.at(-1)).toBe("█ asleep >99% · ▓ online <1% · 1 change");
});

test("shares are of the known time only, and round independently", () => {
  // Three equal thirds round to 33% each; the unknown last 15 minutes are left out.
  const lines = categoryTimeline([at(0, "a"), at(15, "b"), at(30, "c"), at(45, undefined)], {
    ...HOUR_RANGE,
    width: 5,
  });
  expect(lines[0]).toBe("│█▓▒ ");
  expect(lines.at(-1)).toBe("█ a 33% · ▓ b 33% · ▒ c 33% · 2 changes");
});

test("a single state in range has a one-entry legend at 100% with no changes", () => {
  const lines = categoryTimeline([at(10, "charging")], { ...HOUR_RANGE, width: 7 });
  expect(lines[0]).toBe("│ █████");
  expect(lines.at(-1)).toBe("█ charging 100% · 0 changes");
});

// ───────── seriesFor on word-valued sensors ─────────

const sensorRec = (value: unknown, minutes = 0, available = true) => ({
  state: { domain: "sensor", value, unit: "%" },
  available,
  updatedAt: T0 + minutes * 60_000,
});

test("a sensor with any numeric reading is charted as numbers, dropping the words", () => {
  expect(seriesFor("sensor", [sensorRec("asleep", 0), sensorRec(68, 5)])).toEqual({
    kind: "value",
    points: [{ at: T0 + 5 * 60_000, value: 68 }],
    unit: "%",
  });
});

test("a sensor whose readings are all words is a category series in record order", () => {
  expect(seriesFor("sensor", [sensorRec("asleep", 0), sensorRec("online", 5)])).toEqual({
    kind: "category",
    points: [
      { at: T0, value: "asleep" },
      { at: T0 + 5 * 60_000, value: "online" },
    ],
  });
});

test("a sensor with only empty-string readings is a category series of unknowns", () => {
  expect(seriesFor("sensor", [sensorRec(""), sensorRec("", 5)])).toEqual({
    kind: "category",
    points: [
      { at: T0, value: undefined },
      { at: T0 + 5 * 60_000, value: undefined },
    ],
  });
});

test("a sensor with only null readings has nothing to chart", () => {
  expect(seriesFor("sensor", [sensorRec(null), sensorRec(null, 5)])).toBeUndefined();
});

test("a word-valued sensor that was unavailable throughout is a category series of unknowns", () => {
  expect(seriesFor("sensor", [sensorRec("asleep", 0, false)])).toEqual({
    kind: "category",
    points: [{ at: T0, value: undefined }],
  });
});

test("a sensor with no records is an empty numeric series", () => {
  expect(seriesFor("sensor", [])).toEqual({ kind: "value", points: [], unit: undefined });
});

test("a thermostat never becomes a category series, even with word-valued readings", () => {
  expect(seriesFor("climate", [sensorRec("asleep")])).toBeUndefined();
});
