// core/storage.ts
// Private key-value namespace per integration instance (integration_storage table).

import type { Database } from "bun:sqlite";
import type { KeyValueStore } from "./types.ts";

export function createStorage(db: Database, integrationId: string, now = Date.now): KeyValueStore {
  const get = db.query<{ value: string }, [string, string]>(
    "SELECT value FROM integration_storage WHERE integration_id = ? AND key = ?",
  );
  const set = db.query(
    `INSERT INTO integration_storage (integration_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (integration_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = db.query("DELETE FROM integration_storage WHERE integration_id = ? AND key = ?");
  return {
    async get<T>(key: string) {
      const row = get.get(integrationId, key);
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    async set(key, value) {
      // JSON has no undefined; storing it means the key has no value.
      if (value === undefined) del.run(integrationId, key);
      else set.run(integrationId, key, JSON.stringify(value), now());
    },
    async delete(key) {
      del.run(integrationId, key);
    },
  };
}
