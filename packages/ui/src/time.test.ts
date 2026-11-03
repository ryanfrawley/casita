import { describe, expect, test } from "bun:test";
import {
  DAY,
  formatClock,
  formatDuration,
  formatTick,
  formatTime,
  formatWhen,
  HOUR,
  toDate,
} from "./time.ts";

// Clock text depends on the machine's locale and time zone, so every date here is built from
// local-time components and every clock expectation comes from the same Intl call the code
// makes, with "AM"/"PM" lowered.
const lowered = (text: string) =>
  text.replace(/\s?([AP]M)/, (_, half: string) => ` ${half.toLowerCase()}`);
const clock = (d: Date) =>
  lowered(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));

// Wednesday 10 June 2026, noon local time: far from any daylight-saving change in either
// hemisphere.
const NOW = new Date(2026, 5, 10, 12, 0, 0);
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 6e4;

describe("formatTime, relative", () => {
  test("under 45 seconds is 'just now' in the past and 'in a moment' in the future", () => {
    expect(formatTime(NOW, { now: NOW })).toBe("just now");
    expect(formatTime(at(-44_999), { now: NOW })).toBe("just now");
    expect(formatTime(at(30_000), { now: NOW })).toBe("in a moment");
  });

  test("from 45 seconds it counts minutes, never fewer than one", () => {
    expect(formatTime(at(-45_000), { now: NOW })).toBe("1 min ago");
    expect(formatTime(at(45_000), { now: NOW })).toBe("in 1 min");
  });

  test("minutes in the past and future are rounded", () => {
    expect(formatTime(at(-4 * MIN), { now: NOW })).toBe("4 min ago");
    expect(formatTime(at(-4 * MIN - 20_000), { now: NOW })).toBe("4 min ago");
    expect(formatTime(at(-4 * MIN - 40_000), { now: NOW })).toBe("5 min ago");
    expect(formatTime(at(10 * MIN), { now: NOW })).toBe("in 10 min");
    expect(formatTime(at(-59 * MIN), { now: NOW })).toBe("59 min ago");
  });

  test("an hour or more earlier or later on the same day is 'at' the clock time", () => {
    const morning = new Date(2026, 5, 10, 9, 15);
    const evening = new Date(2026, 5, 10, 21, 42);
    expect(formatTime(morning, { now: NOW })).toBe(`at ${clock(morning)}`);
    expect(formatTime(evening, { now: NOW })).toBe(`at ${clock(evening)}`);
    expect(formatTime(at(-HOUR), { now: NOW })).toBe(`at ${clock(at(-HOUR))}`);
  });

  test("less than a day ago but on the day before is 'yesterday at'", () => {
    const now = new Date(2026, 5, 10, 1, 0);
    const late = new Date(2026, 5, 9, 22, 30);
    expect(formatTime(late, { now })).toBe(`yesterday at ${clock(late)}`);
  });

  test("less than a day ahead but on the day after is 'tomorrow at'", () => {
    const now = new Date(2026, 5, 10, 23, 0);
    const early = new Date(2026, 5, 11, 2, 5);
    expect(formatTime(early, { now })).toBe(`tomorrow at ${clock(early)}`);
  });

  test("a day or more away is the date word, without the year when it is this year", () => {
    expect(formatTime(new Date(2026, 5, 1, 8, 0), { now: NOW })).toBe("Mon 1 Jun");
    expect(formatTime(new Date(2026, 5, 20, 8, 0), { now: NOW })).toBe("Sat 20 Jun");
    // Exactly one day earlier is no longer "yesterday".
    expect(formatTime(at(-DAY), { now: NOW })).toBe("Tue 9 Jun");
  });

  test("the date word carries the year when it is not this year", () => {
    expect(formatTime(new Date(2025, 11, 30, 8, 0), { now: NOW })).toBe("Tue 30 Dec 2025");
    expect(formatTime(new Date(2027, 0, 4, 8, 0), { now: NOW })).toBe("Mon 4 Jan 2027");
  });

  test("without `now` it reads the clock", () => {
    expect(formatTime(Date.now())).toBe("just now");
    expect(formatTime(Date.now() - 4 * MIN)).toBe("4 min ago");
  });

  test("accepts numbers, numeric strings and ISO strings for the value and `now`", () => {
    const value = at(-4 * MIN).getTime();
    expect(formatTime(value, { now: NOW.getTime() })).toBe("4 min ago");
    expect(formatTime(String(value), { now: String(NOW.getTime()) })).toBe("4 min ago");
    expect(formatTime(new Date(value).toISOString(), { now: NOW.toISOString() })).toBe("4 min ago");
  });

  test("an invalid date is a dash, in every format", () => {
    expect(formatTime("not a date", { now: NOW })).toBe("—");
    expect(formatTime(Number.NaN, { now: NOW })).toBe("—");
    expect(formatTime(new Date(Number.NaN), { now: NOW })).toBe("—");
    for (const format of ["clock", "date", "datetime", "relative"] as const) {
      expect(formatTime("nope", { format, now: NOW })).toBe("—");
    }
  });
});

describe("formatTime, explicit formats", () => {
  const d = new Date(2026, 5, 9, 21, 42);

  test("clock is the time of day alone, whatever the distance", () => {
    expect(formatTime(d, { format: "clock", now: NOW })).toBe(clock(d));
    expect(formatTime(d, { format: "clock", now: NOW })).toBe(formatClock(d.getTime()));
  });

  test("date is the date word, with the year only when it differs from now's", () => {
    expect(formatTime(d, { format: "date", now: NOW })).toBe("Tue 9 Jun");
    expect(formatTime(d, { format: "date", now: new Date(2027, 0, 1) })).toBe("Tue 9 Jun 2026");
    // Even a moment ago is a date in this format.
    expect(formatTime(at(-1000), { format: "date", now: NOW })).toBe("Wed 10 Jun");
  });

  test("datetime is the short date and the clock", () => {
    const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    expect(formatTime(d, { format: "datetime", now: NOW })).toBe(`${day}, ${clock(d)}`);
    expect(formatWhen(d.getTime())).toBe(`${day}, ${clock(d)}`);
  });

  test("'relative' is the same as no format", () => {
    expect(formatTime(at(-4 * MIN), { format: "relative", now: NOW })).toBe("4 min ago");
  });
});

describe("formatClock", () => {
  test("writes am and pm in lower case, or a 24-hour clock where the locale uses one", () => {
    expect(formatClock(new Date(2026, 5, 10, 21, 42).getTime())).toMatch(/^(9:42 pm|21:42)$/);
    expect(formatClock(new Date(2026, 5, 10, 7, 5).getTime())).toMatch(/^(7:05 am|0?7:05)$/);
    expect(formatClock(NOW.getTime())).not.toMatch(/AM|PM/);
  });
});

describe("formatDuration", () => {
  test("under an hour is whole minutes", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(29_000)).toBe("0 min");
    expect(formatDuration(30_000)).toBe("1 min");
    expect(formatDuration(12 * MIN)).toBe("12 min");
    expect(formatDuration(59 * MIN + 29_000)).toBe("59 min");
  });

  test("under a day is hours and minutes, leaving out zero minutes", () => {
    expect(formatDuration(59 * MIN + 30_000)).toBe("1h");
    expect(formatDuration(HOUR)).toBe("1h");
    expect(formatDuration(66 * MIN)).toBe("1h 6m");
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });

  test("a day or more is days and hours, dropping the minutes", () => {
    expect(formatDuration(DAY)).toBe("1d 0h");
    expect(formatDuration(2 * DAY + 3 * HOUR + 40 * MIN)).toBe("2d 3h");
  });
});

describe("formatTick", () => {
  const dateTick = (d: Date) => d.toLocaleDateString([], { weekday: "short", day: "numeric" });

  test("ticks a day or more apart are dates", () => {
    const d = new Date(2026, 5, 10, 6, 0);
    expect(formatTick(d.getTime(), DAY)).toBe(dateTick(d));
    expect(formatTick(d.getTime(), 7 * DAY)).toBe(dateTick(d));
  });

  test("a tick at midnight is a date even when ticks are hours apart", () => {
    const d = new Date(2026, 5, 10, 0, 0);
    expect(formatTick(d.getTime(), 6 * HOUR)).toBe(dateTick(d));
  });

  test("a tick on the hour is the hour alone", () => {
    const d = new Date(2026, 5, 10, 6, 0);
    expect(formatTick(d.getTime(), HOUR)).toBe(
      lowered(d.toLocaleTimeString([], { hour: "numeric" })),
    );
    expect(formatTick(d.getTime(), HOUR)).not.toContain(":");
  });

  test("a tick between hours keeps its minutes", () => {
    const d = new Date(2026, 5, 10, 12, 30);
    expect(formatTick(d.getTime(), 30 * MIN)).toBe(clock(d));
    expect(formatTick(d.getTime(), 30 * MIN)).toContain("30");
  });
});

describe("toDate", () => {
  test("returns a Date as it is", () => {
    const d = new Date(2026, 5, 10);
    expect(toDate(d)).toBe(d);
  });

  test("reads a string of digits as epoch milliseconds", () => {
    expect(toDate("1700000000000").getTime()).toBe(1_700_000_000_000);
  });

  test("reads numbers and ISO strings", () => {
    expect(toDate(1_700_000_000_000).getTime()).toBe(1_700_000_000_000);
    expect(toDate("2026-06-10T12:00:00Z").getTime()).toBe(Date.UTC(2026, 5, 10, 12));
  });

  test("an unreadable string gives an invalid date", () => {
    expect(Number.isNaN(toDate("soon").getTime())).toBe(true);
  });
});
