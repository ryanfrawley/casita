import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function migrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "casita-migrate-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const userVersion = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;

const tables = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);

test("applies migrations in numeric order and records the last version", async () => {
  // 002 depends on 001, so a wrong order fails.
  const dir = migrations({
    "002_add.sql": "INSERT INTO log (step) VALUES ('second');",
    "001_init.sql": "CREATE TABLE log (step TEXT); INSERT INTO log (step) VALUES ('first');",
    "003_more.sql": "INSERT INTO log (step) VALUES ('third');",
  });
  const db = new Database(":memory:");
  await migrate(db, dir);
  expect(userVersion(db)).toBe(3);
  expect(
    db
      .query<{ step: string }, []>("SELECT step FROM log ORDER BY rowid")
      .all()
      .map((r) => r.step),
  ).toEqual(["first", "second", "third"]);
});

test("a second call is a no-op", async () => {
  const dir = migrations({ "001_init.sql": "CREATE TABLE t (x);" });
  const db = new Database(":memory:");
  await migrate(db, dir);
  await migrate(db, dir); // would fail with "table t already exists" if reapplied
  expect(userVersion(db)).toBe(1);
  expect(tables(db)).toEqual(["t"]);
});

test("only versions above user_version are applied", async () => {
  const dir = migrations({
    "001_a.sql": "CREATE TABLE a (x);",
    "002_b.sql": "CREATE TABLE b (x);",
    "003_c.sql": "CREATE TABLE c (x);",
  });
  const db = new Database(":memory:");
  db.exec("PRAGMA user_version = 2");
  await migrate(db, dir);
  expect(tables(db)).toEqual(["c"]);
  expect(userVersion(db)).toBe(3);
});

test("newly added migrations are applied on a later call", async () => {
  const dir = migrations({ "001_a.sql": "CREATE TABLE a (x);" });
  const db = new Database(":memory:");
  await migrate(db, dir);
  writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (x);");
  await migrate(db, dir);
  expect(tables(db)).toEqual(["a", "b"]);
  expect(userVersion(db)).toBe(2);
});

test("non-.sql files are ignored", async () => {
  const dir = migrations({ "001_a.sql": "CREATE TABLE a (x);", "README.md": "not sql" });
  const db = new Database(":memory:");
  await migrate(db, dir);
  expect(userVersion(db)).toBe(1);
});

test("a migration without a numeric prefix is rejected", async () => {
  const dir = migrations({ "001_a.sql": "CREATE TABLE a (x);", "init.sql": "CREATE TABLE b (x);" });
  const db = new Database(":memory:");
  await expect(migrate(db, dir)).rejects.toThrow("Migration init.sql has no numeric prefix");
});

test("a failing migration is rolled back and leaves user_version at the last good one", async () => {
  const dir = migrations({
    "001_a.sql": "CREATE TABLE a (x);",
    "002_bad.sql": "CREATE TABLE b (x); INSERT INTO missing VALUES (1);",
    "003_c.sql": "CREATE TABLE c (x);",
  });
  const db = new Database(":memory:");
  await expect(migrate(db, dir)).rejects.toThrow("no such table: missing");
  expect(userVersion(db)).toBe(1);
  // The partial CREATE TABLE b inside the failed migration is rolled back too, and 003 never runs.
  expect(tables(db)).toEqual(["a"]);
});

test("a failing first migration leaves user_version at 0", async () => {
  const dir = migrations({ "001_bad.sql": "NOT VALID SQL;" });
  const db = new Database(":memory:");
  await expect(migrate(db, dir)).rejects.toThrow();
  expect(userVersion(db)).toBe(0);
});

test("openDatabase applies the bundled migrations", async () => {
  const db = await openDatabase(":memory:");
  expect(userVersion(db)).toBeGreaterThanOrEqual(2);
  expect(tables(db)).toEqual(
    expect.arrayContaining(["integration_storage", "users", "sessions", "grants", "audit"]),
  );
});

// Files are sorted as strings and user_version is read once, so "10_" runs before "2_" and the
// database ends at version 2 with 10 already applied; the next call reapplies 10 and fails.
// Latent today (bundled files are zero-padded 001_, 002_) but breaks at 1000_ or for unpadded names.
test("migrations are ordered numerically, not lexically (2_ before 10_)", async () => {
  const dir = migrations({ "2_a.sql": "CREATE TABLE a (x);", "10_b.sql": "CREATE TABLE b (x);" });
  const db = new Database(":memory:");
  await migrate(db, dir);
  expect(userVersion(db)).toBe(10);
  await migrate(db, dir);
  expect(tables(db)).toEqual(["a", "b"]);
});
