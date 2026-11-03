// core/recorder.ts
// Writes state changes and commands to SQLite in batches, serves history, computes rollups,
// and applies retention.

import type { Database } from "bun:sqlite";
import type { HistoryConfig } from "./config.ts";
import type {
  Attributes,
  Entity,
  EntityId,
  EntityState,
  EventBus,
  Logger,
  RetentionPolicy,
  Scheduler,
  StateRecord,
} from "./types.ts";
import { deepEqual, errorMessage } from "./util.ts";

export const PERIODS = ["minute", "hour", "day"] as const;
export type Period = (typeof PERIODS)[number];
export type Resolution = "raw" | Period;
const RESOLUTIONS: readonly Resolution[] = ["raw", ...PERIODS];

const DAY_MS = 86_400_000;
const PERIOD_MS: Record<Period, number> = { minute: 60_000, hour: 3_600_000, day: DAY_MS };
/** How far back one rollup run will reach when it has fallen behind. */
const CATCH_UP_MS: Record<Period, number> = {
  minute: 2 * DAY_MS,
  hour: 30 * DAY_MS,
  day: 400 * DAY_MS,
};
export const MAX_HISTORY_ROWS = 10_000;
const COMMAND_RETENTION_DAYS = 90;
const AUDIT_RETENTION_DAYS = 365;

export interface RollupRecord {
  entityId: EntityId;
  bucketStart: number;
  samples: number;
  /** Numeric states. */
  min?: number;
  max?: number;
  mean?: number;
  /** The last state in the bucket. */
  last: EntityState;
  /** Boolean states (on, locked). */
  changes?: number;
  onSeconds?: number;
}

/** `resolution` names the tier actually returned, which may be coarser than the one requested. */
export type HistoryResult =
  | { resolution: "raw"; records: StateRecord[] }
  | { resolution: Period; records: RollupRecord[] };

export interface RecorderDeps {
  db: Database;
  bus: EventBus;
  registry: {
    getEntity(id: EntityId): Entity | undefined;
    listEntities(): Entity[];
    purgeExpiredAliases(): void;
  };
  /** Read on every use, so config changes apply without a restart. */
  history: () => HistoryConfig;
  log: Logger;
  now?: () => number;
  flushIntervalMs?: number;
  maxBatch?: number;
}

/** The entity's own setting, else its config entry, else its domain's, else the default. */
export function resolvePolicy(
  entity: Pick<Entity, "id" | "domain" | "retention">,
  history: HistoryConfig,
): RetentionPolicy {
  return (
    entity.retention ??
    history.entities[entity.id] ??
    history.domains[entity.domain] ?? { raw: history.defaultDays }
  );
}

type StateRow = {
  entity_id: string;
  state: string;
  attributes: string | null;
  available: number;
  changed_at: number;
  updated_at: number;
};

type RollupRow = {
  entity_id: string;
  bucket_start: number;
  samples: number;
  /** Samples that carried a number; null on rows from before the column existed. */
  numeric_samples: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  last: string;
  changes: number | null;
  on_seconds: number | null;
};

type Bucket = Omit<RollupRow, "entity_id">;

type PendingCommand = {
  entityId: string;
  command: string;
  source: string;
  status: string;
  error: string | null;
  at: number;
};

/** What a state contributes to a rollup: a number, a boolean, or nothing but "last". */
function measure(state: EntityState): number | boolean | undefined {
  if (state.domain === "sensor") return typeof state.value === "number" ? state.value : undefined;
  if ("on" in state) return state.on;
  if (state.domain === "lock") return state.locked;
  if (state.domain === "weather") return state.temperature;
  return undefined;
}

export class Recorder {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly maxBatch: number;
  private states: StateRow[] = [];
  private commands: PendingCommand[] = [];
  /** When each entity's attribute-only change was last written, for `attributesMinIntervalMs`. */
  private readonly lastAttributes = new Map<string, number>();
  /** When each sensor was last written, for `minIntervalMs`. */
  private readonly lastWritten = new Map<string, number>();
  private readonly offs: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RecorderDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.maxBatch = deps.maxBatch ?? 200;
  }

  /** Starts recording. With a scheduler, also runs the rollup and retention jobs. */
  start(scheduler?: Scheduler): void {
    const { bus } = this.deps;
    this.offs.push(
      bus.on("state_changed", (e) => this.recordState(e.new, e.old)),
      bus.on("command_issued", (e) =>
        this.recordCommand(e.entityId, e.command, e.source, "issued", null),
      ),
      bus.on("command_failed", (e) =>
        this.recordCommand(e.entityId, e.command, e.source, "failed", `${e.code}: ${e.error}`),
      ),
    );
    this.timer = setInterval(() => this.flush(), this.deps.flushIntervalMs ?? 1000);
    if (!scheduler) return;
    scheduler.every(5 * 60_000, () => this.rollup("minute"));
    scheduler.cron("1 * * * *", () => this.rollup("hour"));
    scheduler.cron("2 0 * * *", () => this.rollup("day"));
    scheduler.cron("0 3 * * *", () => this.applyRetention());
  }

  /** Stops recording and writes whatever is pending. */
  stop(): void {
    for (const off of this.offs.splice(0)) off();
    clearInterval(this.timer);
    this.flush();
  }

  policyFor(entity: Pick<Entity, "id" | "domain" | "retention">): RetentionPolicy {
    return resolvePolicy(entity, this.deps.history());
  }

  // ───────── writing ─────────

  private recordState(record: StateRecord, old?: StateRecord): void {
    // A change in attributes alone (link quality, a moving car's coordinates) is kept, but
    // thinned out so chatty attributes do not flood the history.
    const attributesOnly =
      old !== undefined && old.available === record.available && deepEqual(old.state, record.state);
    if (attributesOnly) {
      const interval = this.deps.history().attributesMinIntervalMs;
      const last = this.lastAttributes.get(record.entityId);
      if (last !== undefined && record.updatedAt - last < interval) return;
      this.lastAttributes.set(record.entityId, record.updatedAt);
    }
    const minInterval = this.deps.history().minIntervalMs;
    if (minInterval > 0 && record.state.domain === "sensor") {
      const last = this.lastWritten.get(record.entityId);
      if (last !== undefined && record.updatedAt - last < minInterval) return;
      this.lastWritten.set(record.entityId, record.updatedAt);
    }
    this.states.push({
      entity_id: record.entityId,
      state: JSON.stringify(record.state),
      attributes: record.attributes ? JSON.stringify(record.attributes) : null,
      available: record.available ? 1 : 0,
      changed_at: record.changedAt,
      updated_at: record.updatedAt,
    });
    if (this.states.length + this.commands.length >= this.maxBatch) this.flush();
  }

  private recordCommand(
    entityId: string,
    command: unknown,
    source: unknown,
    status: string,
    error: string | null,
  ): void {
    this.commands.push({
      entityId,
      command: JSON.stringify(command),
      source: JSON.stringify(source),
      status,
      error,
      at: this.now(),
    });
    if (this.states.length + this.commands.length >= this.maxBatch) this.flush();
  }

  /** Writes everything pending in one transaction. */
  flush(): void {
    if (this.states.length === 0 && this.commands.length === 0) return;
    const states = this.states;
    const commands = this.commands;
    this.states = [];
    this.commands = [];
    try {
      const insertState = this.db.query(
        `INSERT INTO states (entity_id, state, attributes, available, changed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertCommand = this.db.query(
        `INSERT INTO commands (entity_id, command, source, status, error, issued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        for (const s of states) {
          insertState.run(
            s.entity_id,
            s.state,
            s.attributes,
            s.available,
            s.changed_at,
            s.updated_at,
          );
        }
        for (const c of commands) {
          insertCommand.run(c.entityId, c.command, c.source, c.status, c.error, c.at);
        }
      })();
    } catch (err) {
      this.deps.log.error("history write failed", {
        error: errorMessage(err),
        dropped: states.length + commands.length,
      });
    }
  }

  // ───────── reading ─────────

  /**
   * History for one entity, oldest first. If the requested resolution no longer covers the
   * start of the range, the finest coarser tier that does is returned instead, never a mix.
   */
  history(
    entityId: EntityId,
    from: number,
    to: number,
    opts: { limit?: number; resolution?: Resolution; includePrevious?: boolean } = {},
  ): HistoryResult {
    this.flush();
    const limit = Math.min(opts.limit ?? MAX_HISTORY_ROWS, MAX_HISTORY_ROWS);
    const entity = this.deps.registry.getEntity(entityId);
    const resolution = this.availableResolution(entity, opts.resolution ?? "raw", from);

    if (resolution === "raw") {
      const rows = this.db
        .query<StateRow, [string, number, number, number]>(
          `SELECT * FROM states WHERE entity_id = ? AND updated_at >= ? AND updated_at <= ?
           ORDER BY id LIMIT ?`,
        )
        .all(entityId, from, to, limit);
      // What the entity was already doing when the range began: a light switched on
      // yesterday and never touched since has no row inside today's range.
      const previous = opts.includePrevious
        ? this.db
            .query<StateRow, [string, number]>(
              "SELECT * FROM states WHERE entity_id = ? AND updated_at < ? ORDER BY id DESC LIMIT 1",
            )
            .get(entityId, from)
        : null;
      if (previous) rows.unshift(previous);
      return {
        resolution,
        records: rows.map((r) => ({
          entityId,
          state: JSON.parse(r.state) as EntityState,
          attributes: r.attributes ? (JSON.parse(r.attributes) as Attributes) : undefined,
          available: r.available === 1,
          changedAt: r.changed_at,
          updatedAt: r.updated_at,
        })),
      };
    }

    const rows = this.db
      .query<RollupRow, [string, string, number, number, number]>(
        `SELECT * FROM state_rollups WHERE entity_id = ? AND period = ? AND bucket_start >= ?
           AND bucket_start <= ? ORDER BY bucket_start LIMIT ?`,
      )
      .all(entityId, resolution, from - (from % PERIOD_MS[resolution]), to, limit);
    return {
      resolution,
      records: rows.map((r) => ({
        entityId,
        bucketStart: r.bucket_start,
        samples: r.samples,
        min: r.min ?? undefined,
        max: r.max ?? undefined,
        mean: r.mean ?? undefined,
        last: JSON.parse(r.last) as EntityState,
        changes: r.changes ?? undefined,
        onSeconds: r.on_seconds ?? undefined,
      })),
    };
  }

  private availableResolution(
    entity: Entity | undefined,
    requested: Resolution,
    from: number,
  ): Resolution {
    if (!entity) return requested;
    const policy = this.policyFor(entity);
    const age = this.now() - from;
    const tiers = RESOLUTIONS.filter((r) => policy[r] !== undefined);
    const covers = (r: Resolution) => age <= (policy[r] ?? 0) * DAY_MS;
    const candidates = tiers.filter(
      (r) => RESOLUTIONS.indexOf(r) >= RESOLUTIONS.indexOf(requested),
    );
    return (
      candidates.find(covers) ??
      // Nothing reaches back that far; the tier kept longest has the most to offer.
      [...tiers].sort((a, b) => (policy[b] ?? 0) - (policy[a] ?? 0))[0] ??
      "raw"
    );
  }

  // ───────── rollups ─────────

  /**
   * Computes every complete bucket of `period` not yet computed, from the tier below
   * (or raw). Buckets are upserted, so a rerun is harmless.
   */
  rollup(period: Period): void {
    // A tier is built from the one below, so that one has to be current first; otherwise
    // the end of each bucket would be missed for good.
    const below = PERIODS[PERIODS.indexOf(period) - 1];
    if (below) this.rollup(below);
    this.flush();
    const size = PERIOD_MS[period];
    const end = Math.floor(this.now() / size) * size;
    const progress = this.db
      .query<{ through: number }, [string]>("SELECT through FROM rollup_progress WHERE period = ?")
      .get(period);
    const start = Math.max(progress?.through ?? 0, end - CATCH_UP_MS[period]);
    if (start >= end) return;

    const upsert = this.db.query(
      `INSERT INTO state_rollups
         (entity_id, period, bucket_start, samples, numeric_samples, min, max, mean, last, changes,
          on_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_id, period, bucket_start) DO UPDATE SET samples = excluded.samples,
         numeric_samples = excluded.numeric_samples, min = excluded.min, max = excluded.max, mean = excluded.mean, last = excluded.last,
         changes = excluded.changes, on_seconds = excluded.on_seconds`,
    );
    this.db.transaction(() => {
      for (const entity of this.deps.registry.listEntities()) {
        const policy = this.policyFor(entity);
        if (policy[period] === undefined) continue;
        const below = PERIODS.slice(0, PERIODS.indexOf(period))
          .reverse()
          .find((p) => policy[p] !== undefined);
        const buckets = below
          ? this.bucketsFromTier(entity.id, below, size, start, end)
          : this.bucketsFromRaw(entity.id, size, start, end);
        for (const b of buckets) {
          upsert.run(
            entity.id,
            period,
            b.bucket_start,
            b.samples,
            b.numeric_samples,
            b.min,
            b.max,
            b.mean,
            b.last,
            b.changes,
            b.on_seconds,
          );
        }
      }
      this.db
        .query(
          `INSERT INTO rollup_progress (period, through) VALUES (?, ?)
           ON CONFLICT (period) DO UPDATE SET through = excluded.through`,
        )
        .run(period, end);
    })();
  }

  private bucketsFromRaw(entityId: EntityId, size: number, start: number, end: number): Bucket[] {
    type Row = { state: string; updated_at: number };
    const before = this.db
      .query<Row, [string, number]>(
        "SELECT state, updated_at FROM states WHERE entity_id = ? AND updated_at < ? ORDER BY id DESC LIMIT 1",
      )
      .get(entityId, start);
    const rows = this.db
      .query<Row, [string, number, number]>(
        `SELECT state, updated_at FROM states WHERE entity_id = ? AND updated_at >= ? AND updated_at < ?
         ORDER BY id`,
      )
      .all(entityId, start, end);

    const buckets: Bucket[] = [];
    let lastState = before?.state;
    let current = before ? measure(JSON.parse(before.state) as EntityState) : undefined;
    let index = 0;
    for (let bucketStart = start; bucketStart < end; bucketStart += size) {
      const bucketEnd = bucketStart + size;
      const numbers: number[] = [];
      let samples = 0;
      let changes = 0;
      let onMs = 0;
      let cursor = bucketStart;
      let boolean = typeof current === "boolean";
      for (let row = rows[index]; row && row.updated_at < bucketEnd; row = rows[++index]) {
        const value = measure(JSON.parse(row.state) as EntityState);
        samples++;
        lastState = row.state;
        if (typeof value === "number") numbers.push(value);
        if (typeof value === "boolean") {
          boolean = true;
          if (current === true) onMs += row.updated_at - cursor;
          if (current !== undefined && value !== current) changes++;
          cursor = row.updated_at;
        }
        current = value;
      }
      if (current === true) onMs += bucketEnd - cursor;
      // A quiet bucket is still written while something is on, so on-time adds up.
      if (lastState === undefined || (samples === 0 && onMs === 0)) continue;
      buckets.push({
        bucket_start: bucketStart,
        samples,
        numeric_samples: numbers.length,
        min: numbers.length ? Math.min(...numbers) : null,
        max: numbers.length ? Math.max(...numbers) : null,
        mean: numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null,
        last: lastState,
        changes: boolean ? changes : null,
        on_seconds: boolean ? onMs / 1000 : null,
      });
    }
    return buckets;
  }

  private bucketsFromTier(
    entityId: EntityId,
    source: Period,
    size: number,
    start: number,
    end: number,
  ): Bucket[] {
    const rows = this.db
      .query<RollupRow, [string, string, number, number]>(
        `SELECT * FROM state_rollups WHERE entity_id = ? AND period = ? AND bucket_start >= ?
           AND bucket_start < ? ORDER BY bucket_start`,
      )
      .all(entityId, source, start, end);
    const buckets = new Map<number, Bucket & { weighted: number; weight: number }>();
    for (const row of rows) {
      const bucketStart = row.bucket_start - (row.bucket_start % size);
      let b = buckets.get(bucketStart);
      if (!b) {
        b = {
          bucket_start: bucketStart,
          samples: 0,
          numeric_samples: 0,
          min: null,
          max: null,
          mean: null,
          last: row.last,
          changes: null,
          on_seconds: null,
          weighted: 0,
          weight: 0,
        };
        buckets.set(bucketStart, b);
      }
      b.samples += row.samples;
      b.last = row.last;
      if (row.min !== null) b.min = b.min === null ? row.min : Math.min(b.min, row.min);
      if (row.max !== null) b.max = b.max === null ? row.max : Math.max(b.max, row.max);
      // A mean counts for as many readings as it was taken over, not for every sample: a
      // bucket's samples include states with no number in them.
      const weight = row.numeric_samples ?? row.samples;
      b.numeric_samples = (b.numeric_samples ?? 0) + (row.mean === null ? 0 : weight);
      if (row.mean !== null && weight > 0) {
        b.weighted += row.mean * weight;
        b.weight += weight;
        b.mean = b.weighted / b.weight;
      }
      if (row.changes !== null) b.changes = (b.changes ?? 0) + row.changes;
      if (row.on_seconds !== null) b.on_seconds = (b.on_seconds ?? 0) + row.on_seconds;
    }
    return [...buckets.values()].map(({ weighted: _w, weight: _n, ...bucket }) => bucket);
  }

  // ───────── retention ─────────

  /**
   * Deletes raw rows past each entity's raw window and rollups past their tier window,
   * old commands and audit rows, and expired rename aliases; then truncates the WAL.
   */
  applyRetention(): void {
    this.flush();
    const at = this.now();
    const history = this.deps.history();
    const entities = this.deps.registry.listEntities();
    const policies = entities.map((e) => ({ id: e.id, policy: this.policyFor(e) }));

    this.db.transaction(() => {
      // Entities no longer in the registry fall under the default window.
      this.db
        .query(
          `DELETE FROM states WHERE updated_at < ?
             AND entity_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .run(at - history.defaultDays * DAY_MS, JSON.stringify(entities.map((e) => e.id)));
      const deleteRaw = this.db.query("DELETE FROM states WHERE entity_id = ? AND updated_at < ?");
      for (const { id, policy } of policies) deleteRaw.run(id, at - policy.raw * DAY_MS);

      const deleteTier = this.db.query(
        "DELETE FROM state_rollups WHERE entity_id = ? AND period = ? AND bucket_start < ?",
      );
      for (const period of PERIODS) {
        const kept = policies.filter((p) => p.policy[period] !== undefined);
        for (const { id, policy } of kept) {
          deleteTier.run(id, period, at - (policy[period] ?? 0) * DAY_MS);
        }
        // A tier dropped from an entity's policy, or an entity that is gone, keeps nothing.
        this.db
          .query(
            `DELETE FROM state_rollups WHERE period = ?
               AND entity_id NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(period, JSON.stringify(kept.map((p) => p.id)));
      }

      this.db
        .query("DELETE FROM commands WHERE issued_at < ?")
        .run(at - COMMAND_RETENTION_DAYS * DAY_MS);
      this.db.query("DELETE FROM audit WHERE at < ?").run(at - AUDIT_RETENTION_DAYS * DAY_MS);
    })();
    this.deps.registry.purgeExpiredAliases();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}
