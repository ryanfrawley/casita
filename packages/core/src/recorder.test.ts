import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryConfig } from "./config.ts";
import { backupDatabase } from "./db/index.ts";
import { Recorder, resolvePolicy } from "./recorder.ts";
import { createCore } from "./testing.ts";
import type { EntityId } from "./types.ts";
import { noopLogger } from "./util.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 10); // midnight, so buckets line up

async function setup(history: Partial<HistoryConfig> = {}, maxBatch?: number) {
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
    maxBatch,
  });
  recorder.start();
  const add = <D extends "sensor" | "light" | "lock" | "cover">(domain: D, name: string) =>
    core.registry.registerEntity("demo.main", { uniqueId: name, domain, name }).id;
  const count = (table: string) =>
    (core.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const temp = (id: EntityId, value: number) =>
    core.states.report("demo.main", id, { domain: "sensor", value });
  const light = (id: EntityId, on: boolean) =>
    core.states.report("demo.main", id, { domain: "light", on });
  const at = (ms: number) => {
    core.clock.now = T0 + ms;
  };
  return { ...core, config, recorder, add, count, temp, light, at };
}

test("writes are batched: nothing until a flush, then one row per state_changed", async () => {
  const { recorder, add, temp, count, states } = await setup();
  const id = add("sensor", "t");
  temp(id, 1);
  temp(id, 1); // heartbeat: no event, no row
  temp(id, 2);
  states.setAvailable("demo.main", id, false);
  expect(count("states")).toBe(0);
  recorder.flush();
  expect(count("states")).toBe(3);
});

test("a full batch flushes on its own; stop flushes the rest", async () => {
  const { recorder, add, temp, count } = await setup({}, 3);
  const id = add("sensor", "t");
  temp(id, 1);
  temp(id, 2);
  expect(count("states")).toBe(0);
  temp(id, 3);
  expect(count("states")).toBe(3);
  temp(id, 4);
  recorder.stop();
  expect(count("states")).toBe(4);
  temp(id, 5); // no longer subscribed
  recorder.flush();
  expect(count("states")).toBe(4);
});

test("minIntervalMs skips sensor writes that come too close together, and only sensors", async () => {
  const { recorder, add, temp, light, at, count } = await setup({ minIntervalMs: 1000 });
  const sensor = add("sensor", "t");
  const lamp = add("light", "l");
  for (const [ms, value] of [
    [0, 1],
    [400, 2],
    [999, 3],
    [1000, 4],
    [1500, 5],
  ] as const) {
    at(ms);
    temp(sensor, value);
    light(lamp, value % 2 === 0);
  }
  recorder.flush();
  const rows = (id: string) =>
    (recorder.history(id as EntityId, 0, T0 + DAY).records as { state: { value?: number } }[]).map(
      (r) => r.state.value,
    );
  expect(rows(sensor)).toEqual([1, 4]);
  expect(count("states")).toBe(2 + 5);
});

test("commands are recorded with their source, including failures", async () => {
  const { recorder, bus, db } = await setup();
  const entityId = "light.x" as EntityId;
  const command = { domain: "light", action: "turn_on" } as const;
  const source = { kind: "user", userId: "u1", sessionId: "s1" } as const;
  bus.emit({ type: "command_issued", entityId, command, source });
  bus.emit({
    type: "command_failed",
    entityId,
    command,
    source,
    code: "timeout",
    error: "No response",
  });
  recorder.flush();
  expect(
    db.query("SELECT entity_id, source, status, error FROM commands ORDER BY id").all(),
  ).toEqual([
    { entity_id: "light.x", source: JSON.stringify(source), status: "issued", error: null },
    {
      entity_id: "light.x",
      source: JSON.stringify(source),
      status: "failed",
      error: "timeout: No response",
    },
  ]);
});

test("history returns records oldest first within the range, honoring the limit", async () => {
  const { recorder, add, temp, at } = await setup();
  const id = add("sensor", "t");
  for (let i = 0; i < 5; i++) {
    at(i * 1000);
    temp(id, i);
  }
  const values = (from: number, to: number, limit?: number) => {
    const result = recorder.history(id, T0 + from, T0 + to, { limit });
    expect(result.resolution).toBe("raw");
    return (result.records as { state: { value?: number } }[]).map((r) => r.state.value);
  };
  expect(values(0, 10_000)).toEqual([0, 1, 2, 3, 4]); // includes rows not yet flushed
  expect(values(1000, 3000)).toEqual([1, 2, 3]);
  expect(values(0, 10_000, 2)).toEqual([0, 1]);
  expect(recorder.history("sensor.nope" as EntityId, 0, T0 + DAY).records).toEqual([]);
});

test("policy resolution: entity setting, then config entity, then domain, then default", () => {
  const history: HistoryConfig = {
    defaultDays: 30,
    minIntervalMs: 0,
    attributesMinIntervalMs: 60_000,
    domains: { lock: { raw: 90 } },
    entities: { "lock.side": { raw: 7, hour: 365 } },
  };
  const of = (id: string, domain: "lock" | "light", retention?: { raw: number }) =>
    resolvePolicy({ id: id as EntityId, domain, retention }, history);
  expect(of("light.a", "light")).toEqual({ raw: 30 });
  expect(of("lock.front", "lock")).toEqual({ raw: 90 });
  expect(of("lock.side", "lock")).toEqual({ raw: 7, hour: 365 });
  expect(of("lock.side", "lock", { raw: 1 })).toEqual({ raw: 1 });
});

test("retention deletes exactly the rows past each entity's window", async () => {
  const { recorder, add, temp, at, registry, db, bus } = await setup({
    defaultDays: 30,
    domains: { lock: { raw: 90 } },
  });
  const sensor = add("sensor", "t");
  const short = add("sensor", "short");
  const lock = add("lock", "front");
  registry.updateEntity(short, { retention: { raw: 7 } });
  const ages = [100, 60, 20, 5];
  for (const days of ages) {
    at(-days * DAY);
    temp(sensor, days);
    temp(short, days);
    recorder.flush();
    db.query(
      "INSERT INTO states (entity_id, state, available, changed_at, updated_at) VALUES (?, '{}', 1, ?, ?)",
    ).run("sensor.deleted", T0 - days * DAY, T0 - days * DAY);
    db.query(
      "INSERT INTO states (entity_id, state, available, changed_at, updated_at) VALUES (?, '{}', 1, ?, ?)",
    ).run(lock, T0 - days * DAY, T0 - days * DAY);
    bus.emit({
      type: "command_issued",
      entityId: lock,
      command: { domain: "lock", action: "lock" },
      source: { kind: "system" },
    });
    db.query("INSERT INTO audit (at, action) VALUES (?, 'login')").run(T0 - days * 4 * DAY);
  }
  at(0);
  recorder.applyRetention();

  const kept = (id: string) =>
    (
      db.query("SELECT updated_at FROM states WHERE entity_id = ? ORDER BY id").all(id) as {
        updated_at: number;
      }[]
    ).map((r) => (T0 - r.updated_at) / DAY);
  expect(kept(sensor)).toEqual([20, 5]);
  expect(kept(short)).toEqual([5]);
  expect(kept(lock)).toEqual([60, 20, 5]);
  expect(kept("sensor.deleted")).toEqual([20, 5]);
  expect(
    (db.query("SELECT issued_at FROM commands ORDER BY id").all() as { issued_at: number }[]).map(
      (r) => (T0 - r.issued_at) / DAY,
    ),
  ).toEqual([60, 20, 5]);
  expect(
    (db.query("SELECT at FROM audit ORDER BY id").all() as { at: number }[]).map(
      (r) => (T0 - r.at) / DAY,
    ),
  ).toEqual([240, 80, 20]);
});

test("minute rollups of a numeric sensor: min, max, mean, last, and idempotent reruns", async () => {
  const { recorder, add, temp, at, registry, db } = await setup();
  const id = add("sensor", "t");
  registry.updateEntity(id, { retention: { raw: 7, minute: 90, hour: 730 } });
  for (const [ms, value] of [
    [5_000, 10],
    [20_000, 20],
    [50_000, 30],
    [70_000, 40],
    [3 * MINUTE + 1, 50],
  ] as const) {
    at(ms);
    temp(id, value);
  }
  at(3 * MINUTE + 30_000); // the fourth minute is still open
  recorder.rollup("minute");
  recorder.rollup("minute");
  const result = recorder.history(id, T0, T0 + HOUR, { resolution: "minute" });
  expect(result).toEqual({
    resolution: "minute",
    records: [
      {
        entityId: id,
        bucketStart: T0,
        samples: 3,
        min: 10,
        max: 30,
        mean: 20,
        last: { domain: "sensor", value: 30 },
      },
      {
        entityId: id,
        bucketStart: T0 + MINUTE,
        samples: 1,
        min: 40,
        max: 40,
        mean: 40,
        last: { domain: "sensor", value: 40 },
      },
    ],
  });

  // The hour tier is computed from the minute tier, weighting means by samples.
  at(HOUR + MINUTE);
  recorder.rollup("minute");
  recorder.rollup("hour");
  expect(recorder.history(id, T0, T0 + HOUR, { resolution: "hour" }).records).toEqual([
    {
      entityId: id,
      bucketStart: T0,
      samples: 5,
      min: 10,
      max: 50,
      mean: 30,
      last: { domain: "sensor", value: 50 },
    },
  ]);
  expect(db.query("SELECT period, through FROM rollup_progress ORDER BY period").all()).toEqual([
    { period: "hour", through: T0 + HOUR },
    { period: "minute", through: T0 + HOUR + MINUTE },
  ]);
});

test("rollups of a boolean state: changes and on-time, carried across quiet buckets", async () => {
  const { recorder, add, light, at, registry } = await setup({
    domains: { light: { raw: 7, minute: 30 } },
  });
  const id = add("light", "l");
  const other = add("cover", "c"); // no tier in its policy: never rolled up
  registry.updateEntity(other, { retention: { raw: 7 } });
  at(-30_000);
  light(id, false);
  at(15_000);
  light(id, true); // on for 45s of minute 0
  at(2 * MINUTE + 30_000);
  light(id, false); // on all of minute 1, 30s of minute 2
  at(4 * MINUTE);
  recorder.rollup("minute");
  const records = recorder.history(id, T0, T0 + HOUR, { resolution: "minute" }).records;
  expect(records).toMatchObject([
    { bucketStart: T0, samples: 1, changes: 1, onSeconds: 45, last: { on: true } },
    { bucketStart: T0 + MINUTE, samples: 0, changes: 0, onSeconds: 60, last: { on: true } },
    { bucketStart: T0 + 2 * MINUTE, samples: 1, changes: 1, onSeconds: 30, last: { on: false } },
  ]);
  expect(recorder.history(other, T0, T0 + HOUR, { resolution: "minute" })).toEqual({
    resolution: "raw",
    records: [],
  });
});

test("rollups of the weather: its temperature, with the last state whole", async () => {
  const { recorder, registry, states, at } = await setup();
  const id = registry.registerEntity("demo.main", {
    uniqueId: "w",
    domain: "weather",
    name: "Weather",
  }).id;
  registry.updateEntity(id, { retention: { raw: 7, minute: 90 } });
  const weather = (ms: number, condition: "clear" | "rain", temperature?: number) => {
    at(ms);
    states.report("demo.main", id, { domain: "weather", condition, temperature, humidity: 80 });
  };
  weather(5_000, "clear", 12);
  weather(20_000, "rain", 10);
  weather(40_000, "rain"); // no temperature: a sample, but no number
  weather(MINUTE + 1, "clear"); // a minute with no temperature at all
  at(3 * MINUTE);
  recorder.rollup("minute");
  expect(recorder.history(id, T0, T0 + HOUR, { resolution: "minute" }).records).toEqual([
    {
      entityId: id,
      bucketStart: T0,
      samples: 3,
      min: 10,
      max: 12,
      mean: 11,
      last: { domain: "weather", condition: "rain", humidity: 80 },
    },
    {
      entityId: id,
      bucketStart: T0 + MINUTE,
      samples: 1,
      last: { domain: "weather", condition: "clear", humidity: 80 },
    },
  ]);
});

test("an hour's mean weighs each minute by its readings, not by samples with no number", async () => {
  const { recorder, registry, states, at, db } = await setup();
  const id = registry.registerEntity("demo.main", {
    uniqueId: "w",
    domain: "weather",
    name: "Weather",
  }).id;
  registry.updateEntity(id, { retention: { raw: 7, minute: 90, hour: 365 } });
  const weather = (ms: number, condition: "clear" | "rain", temperature?: number) => {
    at(ms);
    states.report("demo.main", id, { domain: "weather", condition, temperature });
  };
  weather(5_000, "clear", 20); // minute 0: three samples, one reading
  weather(20_000, "rain");
  weather(40_000, "clear");
  weather(MINUTE + 1, "rain", 10); // minute 1: one sample, one reading
  weather(2 * MINUTE + 1, "clear"); // minute 2: no reading at all
  at(HOUR + 5 * MINUTE);
  recorder.rollup("hour");
  expect(recorder.history(id, T0, T0 + HOUR - 1, { resolution: "hour" }).records).toMatchObject([
    { bucketStart: T0, samples: 5, min: 10, max: 20, mean: 15 },
  ]);

  // A minute row from before the count was kept weighs by its samples, as it always did.
  db.query("UPDATE state_rollups SET numeric_samples = NULL WHERE period = 'minute'").run();
  db.query("DELETE FROM rollup_progress WHERE period = 'hour'").run();
  recorder.rollup("hour");
  expect(recorder.history(id, T0, T0 + HOUR - 1, { resolution: "hour" }).records).toMatchObject([
    { bucketStart: T0, mean: 17.5 },
  ]);
});

test("history falls back to the finest tier that still covers the range, and says so", async () => {
  const { recorder, add, registry } = await setup();
  const id = add("sensor", "t");
  registry.updateEntity(id, { retention: { raw: 7, minute: 90, hour: 730 } });
  const resolution = (daysAgo: number, requested: "raw" | "minute" | "hour" | "day") =>
    recorder.history(id, T0 - daysAgo * DAY, T0, { resolution: requested }).resolution;
  expect(resolution(1, "raw")).toBe("raw");
  expect(resolution(30, "raw")).toBe("minute");
  expect(resolution(200, "raw")).toBe("hour");
  expect(resolution(200, "minute")).toBe("hour");
  expect(resolution(1, "hour")).toBe("hour");
  expect(resolution(1, "day")).toBe("hour"); // no day tier; hour is kept longest
  expect(resolution(5000, "raw")).toBe("hour");
});

test("retention trims rollup tiers to their own windows and drops tiers no longer in the policy", async () => {
  const { recorder, add, registry, db } = await setup();
  const id = add("sensor", "t");
  registry.updateEntity(id, { retention: { raw: 7, minute: 30 } });
  const insert = db.query(
    "INSERT INTO state_rollups (entity_id, period, bucket_start, samples, last) VALUES (?, ?, ?, 1, '{}')",
  );
  for (const days of [40, 10]) {
    insert.run(id, "minute", T0 - days * DAY);
    insert.run(id, "hour", T0 - days * DAY);
    insert.run("sensor.deleted", "minute", T0 - days * DAY);
  }
  recorder.applyRetention();
  expect(db.query("SELECT entity_id, period, bucket_start FROM state_rollups").all()).toEqual([
    { entity_id: id, period: "minute", bucket_start: T0 - 10 * DAY },
  ]);
});

test("backup writes a dated copy and keeps the newest seven", async () => {
  const { db, add } = await setup();
  add("sensor", "t");
  const dir = await mkdtemp(join(tmpdir(), "casita-backup-"));
  try {
    for (let day = 1; day <= 9; day++) await backupDatabase(db, dir, () => Date.UTC(2026, 0, day));
    const again = await backupDatabase(db, dir, () => Date.UTC(2026, 0, 9));
    expect(again).toBe(join(dir, "backup-2026-01-09.db"));
    expect((await readdir(dir)).sort()).toEqual(
      [3, 4, 5, 6, 7, 8, 9].map((d) => `backup-2026-01-0${d}.db`),
    );
    const { Database } = await import("bun:sqlite");
    const copy = new Database(again, { readonly: true });
    expect(copy.query("SELECT id FROM entities").all()).toEqual([{ id: "sensor.t" }]);
    copy.close();
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("attribute-only changes are recorded at most once per interval; state changes always are", async () => {
  const { recorder, add, states, at } = await setup({ attributesMinIntervalMs: 1000 });
  const id = add("sensor", "car");
  const move = (ms: number, latitude: number, value = "away") => {
    at(ms);
    states.report("demo.main", id, { domain: "sensor", value }, { latitude });
  };
  move(0, 1);
  move(100, 2); // first attribute-only change: recorded
  move(200, 3); // too soon
  move(900, 4); // too soon
  move(1100, 5); // a second has passed
  move(1150, 6, "Home"); // a state change is never thinned
  const rows = recorder.history(id, 0, T0 + DAY).records as { attributes?: { latitude: number } }[];
  expect(rows.map((r) => r.attributes?.latitude)).toEqual([1, 2, 5, 6]);
});

test("includePrevious adds the last record before the range, so it starts from a known state", async () => {
  const { recorder, add, light, at } = await setup();
  const id = add("light", "l");
  at(-2 * HOUR);
  light(id, false);
  at(-HOUR);
  light(id, true);
  at(30 * MINUTE);
  light(id, false);
  const on = (records: unknown[]) =>
    (records as { state: { on: boolean } }[]).map((r) => r.state.on);
  expect(on(recorder.history(id, T0, T0 + HOUR).records)).toEqual([false]);
  expect(on(recorder.history(id, T0, T0 + HOUR, { includePrevious: true }).records)).toEqual([
    true,
    false,
  ]);
  // Nothing before the range: nothing added.
  expect(
    on(recorder.history(id, T0 - 3 * HOUR, T0 + HOUR, { includePrevious: true }).records),
  ).toEqual([false, true, false]);
});
