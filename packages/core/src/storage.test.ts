import { expect, test } from "bun:test";
import { openDatabase } from "./db/index.ts";
import { createStorage } from "./storage.ts";

test("JSON values round-trip", async () => {
  const db = await openDatabase(":memory:");
  const storage = createStorage(db, "demo.main");
  const values: Record<string, unknown> = {
    string: "hello",
    number: 42.5,
    zero: 0,
    boolean: false,
    null: null,
    array: [1, "two", { three: 3 }],
    object: { nested: { list: [true, null] } },
  };
  for (const [key, value] of Object.entries(values)) await storage.set(key, value);
  for (const [key, value] of Object.entries(values)) {
    expect(await storage.get<unknown>(key)).toEqual(value);
  }
});

test("a missing key is undefined", async () => {
  const storage = createStorage(await openDatabase(":memory:"), "demo.main");
  expect(await storage.get<unknown>("nope")).toBeUndefined();
});

test("setting a key again overwrites it", async () => {
  const storage = createStorage(await openDatabase(":memory:"), "demo.main");
  await storage.set("k", { v: 1 });
  await storage.set("k", [2]);
  expect(await storage.get<unknown>("k")).toEqual([2]);
});

test("delete removes the key, and deleting a missing key is a no-op", async () => {
  const storage = createStorage(await openDatabase(":memory:"), "demo.main");
  await storage.set("k", 1);
  await storage.delete("k");
  expect(await storage.get<unknown>("k")).toBeUndefined();
  await storage.delete("never-set");
  expect(await storage.get<unknown>("never-set")).toBeUndefined();
});

test("two integration ids sharing a database do not see each other's keys", async () => {
  const db = await openDatabase(":memory:");
  const a = createStorage(db, "mqtt.one");
  const b = createStorage(db, "mqtt.two");
  await a.set("token", "a-value");
  expect(await b.get<unknown>("token")).toBeUndefined();

  await b.set("token", "b-value");
  expect(await a.get<unknown>("token")).toBe("a-value");
  expect(await b.get<unknown>("token")).toBe("b-value");

  await a.delete("token");
  expect(await a.get<unknown>("token")).toBeUndefined();
  expect(await b.get<unknown>("token")).toBe("b-value");
});

test("values persist for a new store over the same database and id", async () => {
  const db = await openDatabase(":memory:");
  await createStorage(db, "demo.main").set("k", { kept: true });
  expect(await createStorage(db, "demo.main").get<unknown>("k")).toEqual({ kept: true });
});

test("updated_at comes from the injected clock", async () => {
  const db = await openDatabase(":memory:");
  let now = 1000;
  const storage = createStorage(db, "demo.main", () => now);
  await storage.set("k", 1);
  now = 2000;
  await storage.set("k", 2);
  const row = db
    .query<{ updated_at: number }, []>("SELECT updated_at FROM integration_storage")
    .get();
  expect(row?.updated_at).toBe(2000);
});

test("setting undefined removes the key", async () => {
  const storage = createStorage(await openDatabase(":memory:"), "mqtt.main");
  await storage.set("k", 1);
  await storage.set("k", undefined);
  expect(await storage.get<unknown>("k")).toBeUndefined();
});
