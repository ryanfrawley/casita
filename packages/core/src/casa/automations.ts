// casa/automations.ts
// Automations in SQLite: one `automation` declaration each, compiled on save like a page and
// kept with its versions. The runtime registers the stored handlers; this is the one place an
// automation meets the database.

import type { Database } from "bun:sqlite";
import { CoreError } from "../errors.ts";
import type { EventBus } from "../types.ts";
import type { Registry } from "./check.ts";
import { compile } from "./compile.ts";
import type { CServerHandler } from "./compiled.ts";
import type { Diagnostic } from "./diagnostics.ts";

export interface AutomationStoreDeps {
  db: Database;
  bus: EventBus;
  /** The house as the compiler needs it, read fresh on every compile. */
  registry: () => Registry;
  now?: () => number;
}

export interface AutomationSummary {
  id: string;
  name: string;
  enabled: boolean;
  /** How many handlers it declares. */
  handlers: number;
  /** Entity ids its handlers wait on or command. */
  entities: string[];
  /** Device ids its handlers look up. */
  devices: string[];
  updatedAt: number;
  updatedBy?: string;
}

export interface AutomationRecord extends AutomationSummary {
  handlers: number;
  compiled: CServerHandler[];
}

export interface AutomationVersion {
  version: number;
  savedAt: number;
  savedBy?: string;
}

export interface SaveAutomationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  automation?: AutomationRecord;
}

/** An automation id: lowercase letters, digits and underscores, as a page's is. */
export const AUTOMATION_ID = /^[a-z][a-z0-9_]*$/;

interface AutomationRow {
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
  handlers: CServerHandler[];
  entities: string[];
  /** Absent in rows compiled before devices were tracked; `refresh` fills it in. */
  devices?: string[];
}

export class AutomationStore {
  private readonly now: () => number;

  constructor(private readonly deps: AutomationStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  list(): AutomationSummary[] {
    return this.deps.db
      .query<AutomationRow, []>("SELECT * FROM automations ORDER BY name, id")
      .all()
      .map((row) => this.record(row));
  }

  get(id: string): AutomationRecord | undefined {
    const row = this.deps.db
      .query<AutomationRow, [string]>("SELECT * FROM automations WHERE id = ?")
      .get(id);
    return row ? this.record(row) : undefined;
  }

  /** The source and its versions, newest first. */
  getSource(id: string): { source: string; versions: AutomationVersion[] } {
    const row = this.deps.db
      .query<Pick<AutomationRow, "source">, [string]>("SELECT source FROM automations WHERE id = ?")
      .get(id);
    if (!row) throw new CoreError("not_found", `Unknown automation ${id}`);
    return { source: row.source, versions: this.versions(id) };
  }

  /** The source of one saved version. */
  versionSource(id: string, version: number): string {
    const row = this.deps.db
      .query<{ source: string }, [string, number]>(
        "SELECT source FROM automation_versions WHERE automation_id = ? AND version = ?",
      )
      .get(id, version);
    if (!row) throw new CoreError("not_found", `Automation ${id} has no version ${version}`);
    return row.source;
  }

  /** Compiles without storing: what the editor asks for before a save. */
  check(source: string): Diagnostic[] {
    return this.compileAutomation(source).diagnostics;
  }

  /** Compiles, and when it compiles, stores the automation and a version. A new id is created. */
  save(id: string, source: string, by?: string): SaveAutomationResult {
    if (!AUTOMATION_ID.test(id)) {
      throw new CoreError(
        "invalid",
        "An automation id is lowercase letters, digits and underscores",
      );
    }
    const result = this.compileAutomation(source);
    const { automation } = result;
    if (!result.ok || !automation) return { ok: false, diagnostics: result.diagnostics };
    const at = this.now();
    const stored: Stored = {
      handlers: result.serverHandlers,
      entities: result.entities,
      devices: result.devices,
    };
    const { db } = this.deps;
    db.transaction(() => {
      db.query(
        `INSERT INTO automations (id, name, source, compiled, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source,
           compiled = excluded.compiled, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(id, automation.name, source, JSON.stringify(stored), at, by ?? null);
      const last = db
        .query<{ v: number | null }, [string]>(
          "SELECT MAX(version) AS v FROM automation_versions WHERE automation_id = ?",
        )
        .get(id);
      db.query(
        "INSERT INTO automation_versions (automation_id, version, source, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)",
      ).run(id, (last?.v ?? 0) + 1, source, at, by ?? null);
    })();
    this.deps.bus.emit({ type: "automation_changed", automationId: id });
    return { ok: true, diagnostics: result.diagnostics, automation: this.get(id) };
  }

  /** A save of that version's source, so it passes the same checks. */
  revert(id: string, version: number, by?: string): SaveAutomationResult {
    return this.save(id, this.versionSource(id, version), by);
  }

  /** Removes the automation and its versions; the runtime drops its handlers on the event. */
  delete(id: string): void {
    const { changes } = this.deps.db.query("DELETE FROM automations WHERE id = ?").run(id);
    if (!changes) throw new CoreError("not_found", `Unknown automation ${id}`);
    this.deps.bus.emit({ type: "automation_changed", automationId: id });
  }

  /** Switches the handlers off or on without touching the source; no version is saved. */
  setEnabled(id: string, enabled: boolean): AutomationRecord {
    const { changes } = this.deps.db
      .query("UPDATE automations SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (!changes) throw new CoreError("not_found", `Unknown automation ${id}`);
    this.deps.bus.emit({ type: "automation_changed", automationId: id });
    return this.get(id) as AutomationRecord;
  }

  /**
   * Recompiles every stored automation from its source and stores what changed, for a start
   * after the compiler itself moved on. The source is as the admin left it, so no version is
   * saved; one that no longer compiles is left as it was and named.
   */
  refresh(): { refreshed: string[]; failed: { id: string; message: string }[] } {
    const refreshed: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const rows = this.deps.db
      .query<Pick<AutomationRow, "id" | "source" | "compiled">, []>(
        "SELECT id, source, compiled FROM automations",
      )
      .all();
    for (const row of rows) {
      const result = this.compileAutomation(row.source);
      if (!result.ok) {
        failed.push({ id: row.id, message: result.diagnostics.map((d) => d.message).join("; ") });
        continue;
      }
      const stored: Stored = {
        handlers: result.serverHandlers,
        entities: result.entities,
        devices: result.devices,
      };
      const compiled = JSON.stringify(stored);
      if (compiled === row.compiled) continue;
      this.deps.db.query("UPDATE automations SET compiled = ? WHERE id = ?").run(compiled, row.id);
      refreshed.push(row.id);
    }
    for (const id of refreshed)
      this.deps.bus.emit({ type: "automation_changed", automationId: id });
    return { refreshed, failed };
  }

  private compileAutomation(source: string) {
    return compile({ source, registry: this.deps.registry(), automationOnly: true });
  }

  private versions(id: string): AutomationVersion[] {
    return this.deps.db
      .query<{ version: number; saved_at: number; saved_by: string | null }, [string]>(
        "SELECT version, saved_at, saved_by FROM automation_versions WHERE automation_id = ? ORDER BY version DESC",
      )
      .all(id)
      .map((row) => ({
        version: row.version,
        savedAt: row.saved_at,
        savedBy: row.saved_by ?? undefined,
      }));
  }

  private record(row: AutomationRow): AutomationRecord {
    const stored = JSON.parse(row.compiled) as Stored;
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      handlers: stored.handlers.length,
      entities: stored.entities,
      devices: stored.devices ?? [],
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ?? undefined,
      compiled: stored.handlers,
    };
  }
}
