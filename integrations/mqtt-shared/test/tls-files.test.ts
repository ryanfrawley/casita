import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@casita/core/types";
import mqtt from "mqtt";
import { connectMqtt, type MqttConfig } from "../src/index.ts";

// Nothing listens on port 1, and every test here is expected to fail before connecting anyway.
const BROKER = "mqtt://127.0.0.1:1";
const MISSING = join(tmpdir(), `casita-missing-${crypto.randomUUID()}`, "nope.pem");

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Spies on mqtt.connect so a test can tell whether a connection attempt was started. */
function watchConnect() {
  const spy = spyOn(mqtt, "connect");
  cleanups.push(() => spy.mockRestore());
  return spy;
}

async function attempt(config: Partial<MqttConfig>) {
  const controller = new AbortController();
  try {
    await connectMqtt({ connectTimeoutMs: 200, reconnectPeriodMs: 0 })(
      { brokerUrl: BROKER, ...config },
      controller.signal,
      silent,
    );
  } finally {
    controller.abort();
  }
}

test.each([
  ["caFile", "CA certificate"],
  ["certFile", "client certificate"],
  ["keyFile", "client key"],
] as const)("a missing %s is reported by name and path", async (field, what) => {
  await expect(attempt({ [field]: MISSING })).rejects.toThrow(
    `Cannot read the MQTT ${what} at ${MISSING}`,
  );
});

test("a missing file fails before any connection attempt is made", async () => {
  const connect = watchConnect();
  await expect(attempt({ caFile: MISSING })).rejects.toThrow("Cannot read the MQTT");
  expect(connect).not.toHaveBeenCalled();
});

test("without TLS files a connection is attempted (so the spy above can see one)", async () => {
  const connect = watchConnect();
  await expect(attempt({})).rejects.toThrow(`Cannot reach the MQTT broker at ${BROKER}`);
  expect(connect).toHaveBeenCalledTimes(1);
});

test("one missing file among present ones still fails, naming the missing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casita-tls-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const ca = join(dir, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\n");
  const connect = watchConnect();
  await expect(attempt({ caFile: ca, keyFile: MISSING })).rejects.toThrow(
    `Cannot read the MQTT client key at ${MISSING}`,
  );
  expect(connect).not.toHaveBeenCalled();
});

test("a directory given as a certificate path is reported as unreadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casita-tls-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const connect = watchConnect();
  await expect(attempt({ certFile: dir })).rejects.toThrow(
    `Cannot read the MQTT client certificate at ${dir}`,
  );
  expect(connect).not.toHaveBeenCalled();
});

test("an empty-string path is treated as configured, not as absent", async () => {
  // "" is not undefined, so it is checked; it must fail rather than silently skip TLS material.
  const connect = watchConnect();
  await expect(attempt({ caFile: "" })).rejects.toThrow("Cannot read the MQTT CA certificate at ");
  expect(connect).not.toHaveBeenCalled();
});

// Bug: only existence is checked, so a file that exists but cannot be read escapes the
// user-readable message and surfaces as a raw "EACCES: permission denied, open '...'".
test("a file that exists but is not readable is reported like a missing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casita-tls-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, "key.pem");
  await writeFile(key, "secret");
  await chmod(key, 0o000);
  await expect(attempt({ keyFile: key })).rejects.toThrow(
    `Cannot read the MQTT client key at ${key}`,
  );
});
