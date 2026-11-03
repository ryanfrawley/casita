import { expect, test } from "bun:test";
import { Bus } from "./bus.ts";
import type { CoreEvent, Logger } from "./types.ts";

const event: CoreEvent = { type: "config_changed", path: "server.port" };

function recordingLogger() {
  const errors: unknown[] = [];
  const log: Logger = { debug() {}, info() {}, warn() {}, error: (_m, d) => errors.push(d) };
  return { log, errors };
}

test("a throwing listener does not stop the others and is logged", () => {
  const { log, errors } = recordingLogger();
  const bus = new Bus(log);
  const seen: string[] = [];
  bus.on("config_changed", () => seen.push("first"));
  bus.on("config_changed", () => {
    throw new Error("boom");
  });
  bus.on("config_changed", () => seen.push("third"));
  expect(() => bus.emit(event)).not.toThrow();
  expect(seen).toEqual(["first", "third"]);
  expect(errors).toEqual([{ event: "config_changed", error: "boom" }]);
});

test("a rejecting async listener is logged, not awaited", async () => {
  const { log, errors } = recordingLogger();
  const bus = new Bus(log);
  bus.on("config_changed", async () => {
    throw new Error("later");
  });
  bus.emit(event);
  expect(errors).toEqual([]);
  await Bun.sleep(0);
  expect(errors).toEqual([{ event: "config_changed", error: "later" }]);
});

test("unsubscribe stops delivery", () => {
  const bus = new Bus();
  let count = 0;
  const off = bus.on("config_changed", () => count++);
  bus.emit(event);
  off();
  bus.emit(event);
  expect(count).toBe(1);
});

test("listeners only receive their own event type; onAny receives all", () => {
  const bus = new Bus();
  const typed: string[] = [];
  const all: string[] = [];
  bus.on("config_changed", (e) => typed.push(e.type));
  bus.onAny((e) => all.push(e.type));
  bus.emit(event);
  bus.emit({ type: "integration_status", integrationId: "demo.main", status: "running" });
  expect(typed).toEqual(["config_changed"]);
  expect(all).toEqual(["config_changed", "integration_status"]);
});

test("once resolves with the first event passing the filter", async () => {
  const bus = new Bus();
  const next = bus.once("config_changed", (e) => e.path === "b");
  bus.emit({ type: "config_changed", path: "a" });
  bus.emit({ type: "config_changed", path: "b" });
  expect((await next).path).toBe("b");
});
