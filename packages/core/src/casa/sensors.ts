// casa/sensors.ts
// Derived sensors in SQLite: one `sensor` declaration each, compiled on save like an
// automation and kept with its versions. The runtime computes the stored value and reports it
// as an entity; this is the one place a sensor meets the database.

import type { Database } from "bun:sqlite";
import { CoreError } from "../errors.ts";
import type { EventBus } from "../types.ts";
import type { Registry } from "./check.ts";
import { compile } from "./compile.ts";
import type { CSensor } from "./compiled.ts";
import type { Diagnostic } from "./diagnostics.ts";

export interface SensorStoreDeps {
  db: Database;
  bus: EventBus;
  /** The house as the compiler needs it, read fresh on every compile. */
  registry: () => Registry;
  now?: () => number;
}

export interface SensorSummary {
  id: string;
  name: string;
  enabled: boolean;
  type: CSensor["type"];
  /** Entity ids its inputs name. */
  entities: string[];
  updatedAt: number;
  updatedBy?: string;
}

export interface SensorRecord extends SensorSummary {
  compiled: CSensor;
}

export interface SensorVersion {
  version: number;
  savedAt: number;
  savedBy?: string;
}

export interface SaveSensorResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  sensor?: SensorRecord;
}

/** A sensor id: lowercase letters, digits and underscores; it is also the entity's slug. */
export const SENSOR_ID = /^[a-z][a-z0-9_]*$/;

interface SensorRow {
  id: string;
  name: string;
  source: string;
  compiled: string;
  enabled: number;
  updated_at: number;
  updated_by: string | null;
}

/** What the `compiled` column holds. */
interface Stored {
  sensor: CSensor;
  entities: string[];
}

export class SensorStore {
  private readonly now: () => number;

  constructor(private readonly deps: SensorStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  list(): SensorSummary[] {
    return this.deps.db
      .query<SensorRow, []>("SELECT * FROM sensors ORDER BY name, id")
      .all()
      .map((row) => this.record(row));
  }

  get(id: string): SensorRecord | undefined {
    const row = this.deps.db
      .query<SensorRow, [string]>("SELECT * FROM sensors WHERE id = ?")
      .get(id);
    return row ? this.record(row) : undefined;
  }

  /** The source and its versions, newest first. */
  getSource(id: string): { source: string; versions: SensorVersion[] } {
    const row = this.deps.db
      .query<Pick<SensorRow, "source">, [string]>("SELECT source FROM sensors WHERE id = ?")
      .get(id);
    if (!row) throw new CoreError("not_found", `Unknown sensor ${id}`);
    return { source: row.source, versions: this.versions(id) };
  }

  /** The source of one saved version. */
  versionSource(id: string, version: number): string {
    const row = this.deps.db
      .query<{ source: string }, [string, number]>(
        "SELECT source FROM sensor_versions WHERE sensor_id = ? AND version = ?",
      )
      .get(id, version);
    if (!row) throw new CoreError("not_found", `Sensor ${id} has no version ${version}`);
    return row.source;
  }

  /** Compiles without storing: what the editor asks for before a save. */
  check(source: string): Diagnostic[] {
    return this.compileSensor(source).diagnostics;
  }

  /** Compiles, and when it compiles, stores the sensor and a version. A new id is created. */
  save(id: string, source: string, by?: string): SaveSensorResult {
    if (!SENSOR_ID.test(id)) {
      throw new CoreError("invalid", "A sensor id is lowercase letters, digits and underscores");
    }
    const result = this.compileSensor(source);
    const { sensor } = result;
    if (!result.ok || !sensor) return { ok: false, diagnostics: result.diagnostics };
    const at = this.now();
    const stored: Stored = { sensor, entities: result.entities };
    const { db } = this.deps;
    db.transaction(() => {
      db.query(
        `INSERT INTO sensors (id, name, source, compiled, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source,
           compiled = excluded.compiled, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(id, sensor.name, source, JSON.stringify(stored), at, by ?? null);
      const last = db
        .query<{ v: number | null }, [string]>(
          "SELECT MAX(version) AS v FROM sensor_versions WHERE sensor_id = ?",
        )
        .get(id);
      db.query(
        "INSERT INTO sensor_versions (sensor_id, version, source, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)",
      ).run(id, (last?.v ?? 0) + 1, source, at, by ?? null);
    })();
    this.deps.bus.emit({ type: "sensor_changed", sensorId: id });
    return { ok: true, diagnostics: result.diagnostics, sensor: this.get(id) };
  }

  /** A save of that version's source, so it passes the same checks. */
  revert(id: string, version: number, by?: string): SaveSensorResult {
    return this.save(id, this.versionSource(id, version), by);
  }

  /** Removes the sensor and its versions; the runtime drops its entity on the event. */
  delete(id: string): void {
    const { changes } = this.deps.db.query("DELETE FROM sensors WHERE id = ?").run(id);
    if (!changes) throw new CoreError("not_found", `Unknown sensor ${id}`);
    this.deps.bus.emit({ type: "sensor_changed", sensorId: id });
  }

  /** Switches the sensor off or on without touching the source; no version is saved. */
  setEnabled(id: string, enabled: boolean): SensorRecord {
    const { changes } = this.deps.db
      .query("UPDATE sensors SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (!changes) throw new CoreError("not_found", `Unknown sensor ${id}`);
    this.deps.bus.emit({ type: "sensor_changed", sensorId: id });
    return this.get(id) as SensorRecord;
  }

  /**
   * Recompiles every stored sensor from its source and stores what changed, for a start
   * after the compiler itself moved on. The source is as the admin left it, so no version is
   * saved; one that no longer compiles is left as it was and named.
   */
  refresh(): { refreshed: string[]; failed: { id: string; message: string }[] } {
    const refreshed: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const rows = this.deps.db
      .query<Pick<SensorRow, "id" | "source" | "compiled">, []>(
        "SELECT id, source, compiled FROM sensors",
      )
      .all();
    for (const row of rows) {
      const result = this.compileSensor(row.source);
      if (!result.ok || !result.sensor) {
        failed.push({ id: row.id, message: result.diagnostics.map((d) => d.message).join("; ") });
        continue;
      }
      const stored: Stored = { sensor: result.sensor, entities: result.entities };
      const compiled = JSON.stringify(stored);
      if (compiled === row.compiled) continue;
      this.deps.db.query("UPDATE sensors SET compiled = ? WHERE id = ?").run(compiled, row.id);
      refreshed.push(row.id);
    }
    for (const id of refreshed) this.deps.bus.emit({ type: "sensor_changed", sensorId: id });
    return { refreshed, failed };
  }

  private compileSensor(source: string) {
    return compile({ source, registry: this.deps.registry(), sensorOnly: true });
  }

  private versions(id: string): SensorVersion[] {
    return this.deps.db
      .query<{ version: number; saved_at: number; saved_by: string | null }, [string]>(
        "SELECT version, saved_at, saved_by FROM sensor_versions WHERE sensor_id = ? ORDER BY version DESC",
      )
      .all(id)
      .map((row) => ({
        version: row.version,
        savedAt: row.saved_at,
        savedBy: row.saved_by ?? undefined,
      }));
  }

  private record(row: SensorRow): SensorRecord {
    const stored = JSON.parse(row.compiled) as Stored;
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      type: stored.sensor.type,
      entities: stored.entities,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ?? undefined,
      compiled: stored.sensor,
    };
  }
}
