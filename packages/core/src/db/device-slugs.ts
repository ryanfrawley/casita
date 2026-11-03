// core/db/device-slugs.ts
// Devices used to get a random `dev_3f9a1c2b7e4d` id; now the id is a slug of the name, so Casa
// can say `device.thermostat`. This moves a database over, once: every random id becomes a
// slug, and every Casa source that named the old id is rewritten, versions included, so nothing
// the admin arranged stops compiling. Pure SQL cannot do it (slugs need `slugify`), so it runs
// in code after the numbered migrations. Idempotent: with no random ids left it does nothing.

import type { Database } from "bun:sqlite";
import { slugify, uniqueSlug } from "../util.ts";

const RANDOM_ID = /^dev_[0-9a-f]{12}$/;

/** The tables whose `source` column may name a device; the `*_versions` ones keep every save. */
const SOURCE_TABLES = [
  ["pages", "id"],
  ["page_versions", "rowid"],
  ["automations", "id"],
  ["automation_versions", "rowid"],
  ["sensors", "id"],
  ["sensor_versions", "rowid"],
] as const;

export type DeviceSlugChange = { from: string; to: string };

/** Returns the ids it changed, oldest device first. */
export function slugDeviceIds(db: Database): DeviceSlugChange[] {
  const rows = db
    .query<{ id: string; name: string }, []>("SELECT id, name FROM devices ORDER BY created_at, id")
    .all();
  const taken = new Set(rows.map((row) => row.id));
  const changes: DeviceSlugChange[] = [];
  for (const row of rows) {
    if (!RANDOM_ID.test(row.id)) continue;
    const to = uniqueSlug(slugify(row.name), (candidate) => taken.has(candidate));
    taken.add(to);
    changes.push({ from: row.id, to });
  }
  if (changes.length === 0) return changes;

  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const { from, to } of changes) {
      db.query("UPDATE devices SET id = ? WHERE id = ?").run(to, from);
      db.query("UPDATE entities SET device_id = ? WHERE device_id = ?").run(to, from);
      db.query("UPDATE devices SET via_device_id = ? WHERE via_device_id = ?").run(to, from);
    }
    for (const [table, key] of SOURCE_TABLES) {
      if (!tables.has(table)) continue;
      const sources = db
        .query<{ key: string | number; source: string }, []>(
          `SELECT ${key} AS key, source FROM ${table} WHERE source LIKE '%device.dev_%'`,
        )
        .all();
      for (const { key: id, source } of sources) {
        const rewritten = rewriteSource(source, changes);
        if (rewritten === source) continue;
        db.query(`UPDATE ${table} SET source = ? WHERE ${key} = ?`).run(rewritten, id);
      }
    }
  })();
  return changes;
}

/** `device.dev_…` references in a Casa source, by their new ids; nothing else is touched. */
export function rewriteSource(source: string, changes: readonly DeviceSlugChange[]): string {
  const to = new Map(changes.map((change) => [change.from, change.to]));
  return source.replace(/\bdevice\.(dev_[0-9a-f]{12})\b/g, (whole, id: string) =>
    to.has(id) ? `device.${to.get(id)}` : whole,
  );
}
