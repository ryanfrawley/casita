// core/db
// One SQLite file in WAL mode; migrations are numbered SQL files applied in order.

import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export async function openDatabase(path: string): Promise<Database> {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  await migrate(db);
  return db;
}

/** Applies every migration numbered above the database's `user_version`. */
export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<void> {
  const files = [...new Bun.Glob("*.sql").scanSync({ cwd: dir })].map((file) => {
    const version = Number.parseInt(file, 10);
    if (!Number.isInteger(version)) throw new Error(`Migration ${file} has no numeric prefix`);
    return { file, version };
  });
  // By number, not by name: "10_" comes after "2_".
  files.sort((a, b) => a.version - b.version);
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  for (const { file, version } of files) {
    if (version <= current) continue;
    const sql = await Bun.file(join(dir, file)).text();
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    })();
  }
}

const BACKUPS_KEPT = 7;

/**
 * Writes a consistent copy of the live database to `<dir>/backup-<date>.db` with VACUUM INTO,
 * then removes all but the newest seven backups. Returns the new file's path.
 */
export async function backupDatabase(db: Database, dir: string, now = Date.now): Promise<string> {
  const path = join(dir, `backup-${new Date(now()).toISOString().slice(0, 10)}.db`);
  await rm(path, { force: true }); // VACUUM INTO refuses to overwrite
  db.query("VACUUM INTO ?").run(path);
  const backups = [...new Bun.Glob("backup-????-??-??.db").scanSync({ cwd: dir })].sort();
  for (const old of backups.slice(0, -BACKUPS_KEPT)) await rm(join(dir, old), { force: true });
  return path;
}

export type { Database };
