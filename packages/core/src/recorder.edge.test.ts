// Edge cases of rollups, history and retention not covered by recorder.test.ts.

import { expect, test } from "bun:test";
import type { HistoryConfig } from "./config.ts";
import { Recorder, type RollupRecord } from "./recorder.ts";
import { createCore } from "./testing.ts";
import type { EntityId, RetentionPolicy } from "./types.ts";
import { noopLogger } from "./util.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 10); // midnight, so buckets line up

async function setup(history: Partial<HistoryConfig> = {}) {
  const core = await createCore();
  core.clock.now = T0;
  const config: HistoryConfig = {
    defaultDays: 30,
    minIntervalMs: 0,
    attributesMinIntervalMs: 60_000,
    domains: {},
    entities: {},
    ...history,
  };
  const recorder = new Recorder({
    ...core,
    history: () => config,
    log: noopLogger,
    flushIntervalMs: 1_000_000,
  });
  recorder.start();
  const add = (domain: "sensor" | "light", name: string, retention?: RetentionPolicy) => {
    const id = core.registry.registerEntity("demo.main", { uniqueId: name, domain, name }).id;
    if (retention) core.registry.updateEntity(id, { retention });
    return id;
  };
  const sensor = (id: EntityId, value: number | string) =>
    core.states.report("demo.main", id, { domain: "sensor", value });
  const light = (id: EntityId, on: boolean) =>
    core.states.report("demo.main", id, { domain: "light", on });
  const at = (ms: number) => {
    core.clock.now = T0 + ms;
  };
  const rollups = (id: EntityId, period: "minute" | "hour", from = T0 - DAY, to = T0 + DAY) => {
    const result = recorder.history(id, from, to, { resolution: period });
    expect(result.resolution).toBe(period);
    return result.records as RollupRecord[];
  };
  return { ...core, recorder, add, sensor, light, at, rollups };
}

test("a state recorded exactly on a bucket boundary belongs to the bucket that starts there", async () => {
  const { recorder, add, sensor, at, rollups } = await setup();
  const id = add("sensor", "t", { raw: 7, minute: 30 });
  at(MINUTE - 1);
  sensor(id, 1);
  at(MINUTE);
  sensor(id, 2);
  at(2 * MINUTE);
  sensor(id, 3); // exactly at the rollup's end: the bucket it opens is not complete yet
  recorder.rollup("minute");
  expect(rollups(id, "minute").map((r) => [r.bucketStart - T0, r.samples, r.min, r.max])).toEqual([
    [0, 1, 1, 1],
    [MINUTE, 1, 2, 2],
  ]);

  at(3 * MINUTE);
  recorder.rollup("minute");
  expect(rollups(id, "minute").map((r) => [r.bucketStart - T0, r.samples, r.min])).toEqual([
    [0, 1, 1],
    [MINUTE, 1, 2],
    [2 * MINUTE, 1, 3],
  ]);
});

test("on-time is carried through quiet buckets, and quiet buckets after it turns off are not written", async () => {
  const { recorder, add, light, at, rollups } = await setup();
  const id = add("light", "l", { raw: 7, minute: 30 });
  at(-10_000);
  light(id, false);
  at(30_000);
  light(id, true);
  at(4 * MINUTE + 15_000);
  light(id, false);
  at(10 * MINUTE);
  recorder.rollup("minute");
  expect(
    rollups(id, "minute").map((r) => [
      (r.bucketStart - T0) / MINUTE,
      r.samples,
      r.changes,
      r.onSeconds,
    ]),
  ).toEqual([
    [-1, 1, 0, 0], // the first state ever seen: no earlier state to count a change from
    [0, 1, 1, 30],
    [1, 0, 0, 60],
    [2, 0, 0, 60],
    [3, 0, 0, 60],
    [4, 1, 1, 15],
  ]);
});

test("a light already on before the rollup window is on from the window's first bucket", async () => {
  const { recorder, add, light, at, rollups, db } = await setup();
  const id = add("light", "l", { raw: 7, minute: 30 });
  at(-30_000);
  light(id, true);
  at(MINUTE);
  recorder.rollup("minute"); // through minute 0; the next run starts with the light on
  at(MINUTE + 30_000);
  light(id, false);
  at(3 * MINUTE);
  recorder.rollup("minute");
  expect(
    rollups(id, "minute").map((r) => [
      (r.bucketStart - T0) / MINUTE,
      r.samples,
      r.changes,
      r.onSeconds,
    ]),
  ).toEqual([
    [-1, 1, 0, 30],
    [0, 0, 0, 60],
    [1, 1, 1, 30],
  ]);
  expect(db.query("SELECT through FROM rollup_progress WHERE period = 'minute'").get()).toEqual({
    through: T0 + 3 * MINUTE,
  });
});

test("a sensor with string values rolls up to sample counts and its last value only", async () => {
  const { recorder, add, sensor, at, rollups } = await setup();
  const id = add("sensor", "weather", { raw: 7, minute: 30 });
  at(5_000);
  sensor(id, "cloudy");
  at(10_000);
  sensor(id, "sunny");
  at(MINUTE);
  recorder.rollup("minute");
  expect(rollups(id, "minute")).toEqual([
    {
      entityId: id,
      bucketStart: T0,
      samples: 2,
      min: undefined,
      max: undefined,
      mean: undefined,
      last: { domain: "sensor", value: "sunny" },
      changes: undefined,
      onSeconds: undefined,
    },
  ]);
});

test("a rollup before any data writes nothing and later data is still rolled up", async () => {
  const { recorder, add, sensor, at, rollups, db } = await setup();
  const id = add("sensor", "t", { raw: 7, minute: 30 });
  recorder.rollup("minute");
  expect(db.query("SELECT COUNT(*) AS n FROM state_rollups").get()).toEqual({ n: 0 });
  expect(db.query("SELECT through FROM rollup_progress").all()).toEqual([{ through: T0 }]);

  at(20_000);
  sensor(id, 4);
  at(MINUTE);
  recorder.rollup("minute");
  expect(rollups(id, "minute").map((r) => [r.bucketStart, r.mean])).toEqual([[T0, 4]]);
});

test("one rollup run reaches back at most its catch-up window", async () => {
  const { recorder, add, sensor, at, rollups } = await setup();
  const id = add("sensor", "t", { raw: 7, minute: 30 });
  at(-3 * DAY);
  sensor(id, 1); // older than the minute tier's 2-day catch-up
  at(-DAY);
  sensor(id, 2);
  at(0);
  recorder.rollup("minute");
  expect(rollups(id, "minute", T0 - 4 * DAY, T0).map((r) => [r.bucketStart, r.max])).toEqual([
    [T0 - DAY, 2],
  ]);
});

test("history with from after to returns nothing at any resolution", async () => {
  const { recorder, add, sensor, at } = await setup();
  const id = add("sensor", "t", { raw: 7, minute: 30 });
  at(10_000);
  sensor(id, 1);
  at(2 * MINUTE);
  recorder.rollup("minute");
  expect(recorder.history(id, T0 + MINUTE, T0)).toEqual({ resolution: "raw", records: [] });
  expect(recorder.history(id, T0 + MINUTE, T0, { resolution: "minute" })).toEqual({
    resolution: "minute",
    records: [],
  });
  expect(recorder.history(id, T0, T0 + MINUTE, { resolution: "minute" }).records).toHaveLength(1);
});

test("history for an unknown entity keeps the requested resolution, however old the range", async () => {
  const { recorder } = await setup();
  const unknown = "sensor.gone" as EntityId;
  expect(recorder.history(unknown, T0 - 1000 * DAY, T0, { resolution: "hour" })).toEqual({
    resolution: "hour",
    records: [],
  });
  expect(recorder.history(unknown, T0 - 1000 * DAY, T0).resolution).toBe("raw");
});

test("retention deletes nothing while the default window covers every row", async () => {
  const { recorder, add, sensor, at, db } = await setup({ defaultDays: 3650 });
  const id = add("sensor", "t");
  for (const days of [1000, 100, 1]) {
    at(-days * DAY);
    sensor(id, days);
  }
  db.query(
    "INSERT INTO states (entity_id, state, available, changed_at, updated_at) VALUES (?, '{}', 1, ?, ?)",
  ).run("sensor.deleted", T0 - 3000 * DAY, T0 - 3000 * DAY);
  at(0);
  recorder.applyRetention();
  expect(db.query("SELECT COUNT(*) AS n FROM states").get()).toEqual({ n: 4 });
});

// rollup("hour") reads the minute tier, but nothing makes sure the minute tier is complete
// through the hour's end first. The minute job runs every 5 minutes from startup (not aligned to
// the clock), so when the hour job fires at HH:01 the last few minutes of the previous hour are
// often not rolled up yet; the hour is then marked done and never revisited.
test("an hour rollup includes minutes the minute tier had not reached when it ran", async () => {
  const { recorder, add, sensor, at, rollups } = await setup();
  const id = add("sensor", "t", { raw: 7, minute: 30, hour: 365 });
  at(30_000);
  sensor(id, 1);
  at(58 * MINUTE + 10_000);
  sensor(id, 2);
  at(58 * MINUTE + 30_000);
  recorder.rollup("minute"); // through minute 58: the value 2 is not in it yet
  at(HOUR + MINUTE);
  recorder.rollup("hour");
  at(HOUR + 3 * MINUTE);
  recorder.rollup("minute");
  recorder.rollup("hour");
  expect(rollups(id, "hour").map((r) => [r.bucketStart, r.samples, r.max])).toEqual([[T0, 2, 2]]);
});
