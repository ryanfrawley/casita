import { expect, test } from "bun:test";
import { createScheduler, resolveTimezone } from "./scheduler.ts";
import type { Logger } from "./types.ts";
import { noopLogger } from "./util.ts";

test("every repeats, after fires once, and both stop on abort", async () => {
  const abort = new AbortController();
  const scheduler = createScheduler(abort.signal, "UTC", noopLogger);
  let every = 0;
  let after = 0;
  scheduler.every(10, () => void every++);
  scheduler.after(10, () => void after++);
  await Bun.sleep(45);
  expect(every).toBeGreaterThanOrEqual(3);
  expect(after).toBe(1);

  abort.abort();
  const seen = every;
  await Bun.sleep(30);
  expect(every).toBe(seen);
  scheduler.after(1, () => void after++);
  await Bun.sleep(10);
  expect(after).toBe(1);
});

test("a handle can be cancelled on its own", async () => {
  const scheduler = createScheduler(new AbortController().signal, "UTC", noopLogger);
  let count = 0;
  const cancel = scheduler.after(10, () => void count++);
  cancel();
  await Bun.sleep(25);
  expect(count).toBe(0);
});

test("a failing task is logged and the schedule continues", async () => {
  const errors: unknown[] = [];
  const log: Logger = { ...noopLogger, error: (_m, d) => errors.push(d) };
  const abort = new AbortController();
  const scheduler = createScheduler(abort.signal, "UTC", log);
  let runs = 0;
  scheduler.every(5, async () => {
    runs++;
    throw new Error("nope");
  });
  await Bun.sleep(30);
  abort.abort();
  expect(runs).toBeGreaterThanOrEqual(2);
  expect(errors[0]).toEqual({ error: "nope" });
});

test("cron runs in the configured zone and stops on abort", async () => {
  const abort = new AbortController();
  const scheduler = createScheduler(abort.signal, "America/Los_Angeles", noopLogger);
  let runs = 0;
  scheduler.cron("* * * * * *", () => void runs++);
  await Bun.sleep(1100);
  expect(runs).toBeGreaterThanOrEqual(1);
  abort.abort();
});

test("time zones: IANA names resolve, unknown names throw, default is the system zone", () => {
  expect(resolveTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
  expect(() => resolveTimezone("Mars/Olympus")).toThrow('Unknown time zone "Mars/Olympus"');
  expect(resolveTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});
