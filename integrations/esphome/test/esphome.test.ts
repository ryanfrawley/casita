import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import { createEsphomeIntegration } from "../src/index.ts";
import { FakeDevice, type FakeDeviceOptions } from "./fake-device.ts";

const MAC = "AC:BC:32:89:0E:A9";
const KEY = Buffer.alloc(32, 7).toString("base64");
const timing = { timeoutMs: 300, keepaliveMs: 40, backoffBaseMs: 20, backoffMaxMs: 40 };
const integration = createEsphomeIntegration({ timing });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(deviceOptions: FakeDeviceOptions = {}, config: Record<string, unknown> = {}) {
  const device = await FakeDevice.start(deviceOptions);
  const t = createTestContext(
    integration.configSchema.parse({
      devices: [{ host: "127.0.0.1", port: device.port, ...config }],
    }),
  );
  cleanups.push(() => {
    t.abort();
    device.stop();
  });
  await integration.setup(t.ctx);
  return { device, t };
}

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}
/** One field of an entity's current state. */
const field = (t: TestContext<unknown>, uniqueId: string, name: string): unknown =>
  (t.state(uniqueId)?.state as Record<string, unknown> | undefined)?.[name];
const fields = (m: { message: object } | undefined) =>
  (m?.message ?? {}) as Record<string, unknown>;
const settled = (t: TestContext<unknown>) => until(() => t.states.size === 7, "initial states");
const warnings = (t: TestContext<unknown>) =>
  t.logs.filter((l) => l.level === "warn").map((l) => (l.data as { error?: string }).error);

test("discovers the device and its entities from the fixture", async () => {
  const { t } = await setup();
  expect([...t.devices.values()]).toMatchObject([
    {
      uniqueId: MAC,
      name: "Garage",
      manufacturer: "Espressif",
      model: "esp32dev",
      firmware: "2026.8.0",
    },
  ]);
  expect([...t.entities.values()].map((e) => [e.id, e.uniqueId, e.capabilities])).toEqual([
    ["switch.garage_relay", `${MAC}-101`, {}],
    [
      "light.garage_strip",
      `${MAC}-102`,
      { brightness: true, colorTemp: { minK: 2000, maxK: 6536 }, rgb: true, transition: true },
    ],
    ["light.garage_work_lamp", `${MAC}-103`, { transition: true }],
    ["sensor.garage_temperature", `${MAC}-104`, {}],
    ["binary_sensor.garage_door", `${MAC}-105`, {}],
    ["cover.garage_shutter", `${MAC}-106`, { position: true }],
    ["button.garage_restart", `${MAC}-107`, {}],
  ]);
});

test("reports the state the device streams, converting units", async () => {
  const { device, t } = await setup();
  await settled(t);
  expect(t.state(`${MAC}-101`)?.state).toEqual({ domain: "switch", on: false });
  expect(t.state(`${MAC}-102`)?.state).toEqual({
    domain: "light",
    on: true,
    brightness: 0.5,
    colorTempK: 4000,
  });
  expect(t.state(`${MAC}-103`)?.state).toEqual({ domain: "light", on: false }); // on/off only: no brightness
  expect(t.state(`${MAC}-104`)?.state).toEqual({
    domain: "sensor",
    value: 21.5,
    unit: "°C",
    deviceClass: "temperature",
  });
  expect(t.state(`${MAC}-105`)?.state).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "door",
  });
  expect(t.state(`${MAC}-106`)?.state).toEqual({
    domain: "cover",
    position: 0.25,
    motion: "stopped",
  });
  expect(t.state(`${MAC}-107`)?.state).toEqual({ domain: "button" });

  device.report({ type: "Sensor", key: 104, state: 19.04 });
  device.report({ type: "Cover", key: 106, position: 0.6, currentOperation: 1 });
  device.report({
    type: "Light",
    key: 102,
    state: true,
    brightness: 1,
    colorMode: 35,
    red: 1,
    green: 0.5,
    blue: 0,
  });
  await until(() => field(t, `${MAC}-102`, "rgb") !== undefined);
  expect(t.state(`${MAC}-104`)?.state).toMatchObject({ value: 19 });
  expect(t.state(`${MAC}-106`)?.state).toEqual({
    domain: "cover",
    position: 0.6,
    motion: "opening",
  });
  expect(t.state(`${MAC}-102`)?.state).toEqual({
    domain: "light",
    on: true,
    brightness: 1,
    rgb: [255, 128, 0],
  });

  const reports = t.reports.length;
  device.report({ type: "Sensor", key: 104, state: 0, missingState: true });
  await Bun.sleep(20);
  expect(t.reports).toHaveLength(reports); // "no valid state yet" is not a report
});

test("delivers commands to the device", async () => {
  const { device, t } = await setup();
  await settled(t);
  await t.command(`${MAC}-101`, { domain: "switch", action: "turn_on" });
  await t.command(`${MAC}-102`, {
    domain: "light",
    action: "turn_on",
    brightness: 0.25,
    colorTempK: 2700,
    transitionMs: 800,
  });
  await t.command(`${MAC}-102`, { domain: "light", action: "turn_on", rgb: [255, 0, 51] });
  await t.command(`${MAC}-102`, { domain: "light", action: "turn_off" });
  await t.command(`${MAC}-106`, { domain: "cover", action: "open" });
  await t.command(`${MAC}-106`, { domain: "cover", action: "set_position", position: 0.4 });
  await t.command(`${MAC}-106`, { domain: "cover", action: "stop" });
  await t.command(`${MAC}-107`, { domain: "button", action: "press" });
  await until(() => device.commands().length === 8, "commands");

  const commands = device.commands();
  expect(commands[0]).toMatchObject({
    name: "SwitchCommandRequest",
    message: { key: 101, state: true },
  });
  expect(commands[1]).toMatchObject({
    name: "LightCommandRequest",
    message: {
      key: 102,
      hasState: true,
      state: true,
      hasBrightness: true,
      brightness: 0.25,
      hasColorMode: true,
      colorMode: 47,
      hasColorTemperature: true,
      hasRgb: false,
      hasTransitionLength: true,
      transitionLength: 800,
    },
  });
  expect(Number(fields(commands[1]).colorTemperature)).toBeCloseTo(370.37, 1);
  expect(commands[2]).toMatchObject({
    message: { hasRgb: true, red: 1, green: 0, hasBrightness: false },
  });
  expect(Number(fields(commands[2]).blue)).toBeCloseTo(0.2, 5);
  expect(commands[3]).toMatchObject({
    message: { key: 102, hasState: true, state: false, hasTransitionLength: false },
  });
  expect(commands[4]).toMatchObject({
    name: "CoverCommandRequest",
    message: { key: 106, hasPosition: true, position: 1 },
  });
  expect(Number(fields(commands[5]).position)).toBeCloseTo(0.4, 5);
  expect(commands[6]).toMatchObject({ message: { key: 106, stop: true, hasPosition: false } });
  expect(commands[7]).toMatchObject({ name: "ButtonCommandRequest", message: { key: 107 } });

  // State changes come back from the device, not from the command.
  await until(() => field(t, `${MAC}-101`, "on") === true);
  expect(t.state(`${MAC}-107`)?.state).toMatchObject({ pressedAt: expect.any(Number) });
  await expect(t.command(`${MAC}-104`, { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "read-only",
  );
});

test("marks entities unavailable when the connection drops, then reconnects with backoff", async () => {
  const { device, t } = await setup();
  await settled(t);
  device.stop(); // gone entirely, so the reconnect attempts fail for a while
  await until(() => [...t.states.values()].every((s) => !s.available), "unavailable");
  expect(new Set(t.availability.filter((a) => !a.available).map((a) => a.entityId)).size).toBe(7);
  await expect(t.command(`${MAC}-101`, { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "Garage is not connected",
  );
  await until(() => warnings(t).length >= 3, "retries");
  device.listen();

  await until(() => [...t.states.values()].every((s) => s.available), "recovery");
  expect(t.entities.size).toBe(7);
  await t.command(`${MAC}-101`, { domain: "switch", action: "turn_on" });
  await until(() => field(t, `${MAC}-101`, "on") === true);
});

test("a device that announces a disconnect is reconnected", async () => {
  const { device, t } = await setup();
  await settled(t);
  device.broadcast("DisconnectRequest");
  await until(
    () => device.received.filter((m) => m.name === "HelloRequest").length === 2,
    "second hello",
  );
  await until(() => [...t.states.values()].every((s) => s.available), "recovery");
});

test("a device that stops answering is dropped by the keepalive", async () => {
  const { device, t } = await setup();
  await settled(t);
  expect(device.received.some((m) => m.name === "PingRequest")).toBe(false);
  await until(() => device.received.some((m) => m.name === "PingRequest"), "ping");
  expect([...t.states.values()].every((s) => s.available)).toBe(true); // pongs keep it alive
});

test("an unreachable device does not fail setup; it is retried until it appears", async () => {
  const device = await FakeDevice.start();
  const port = device.port;
  device.stop();
  const t = createTestContext(
    integration.configSchema.parse({ devices: [{ host: "127.0.0.1", port }] }),
  );
  cleanups.push(() => {
    t.abort();
    device.stop();
  });
  await integration.setup(t.ctx);
  expect(t.entities.size).toBe(0);
  expect(warnings(t)[0]).toContain(`cannot connect to 127.0.0.1:${port}`);

  device.listen(port);
  await settled(t);
});

test("cleans up on abort: says goodbye, closes, and stops retrying", async () => {
  const { device, t } = await setup();
  await settled(t);
  t.abort();
  await until(() => device.connections === 0, "disconnect");
  expect(device.received.at(-1)?.name).toBe("DisconnectRequest");
  await Bun.sleep(100);
  expect(device.received.filter((m) => m.name === "HelloRequest")).toHaveLength(1);
});

test("noise encryption: connects with the right key, and names the problem otherwise", async () => {
  const { device, t } = await setup({ encryptionKey: KEY }, { encryptionKey: KEY });
  await settled(t);
  await t.command(`${MAC}-101`, { domain: "switch", action: "turn_on" });
  await until(() => field(t, `${MAC}-101`, "on") === true);
  expect(device.commands()).toHaveLength(1);

  const wrong = await setup(
    { encryptionKey: KEY },
    { encryptionKey: Buffer.alloc(32, 9).toString("base64") },
  );
  expect(warnings(wrong.t)[0]).toBe("the encryption key is wrong");
  const missing = await setup({ encryptionKey: KEY });
  expect(warnings(missing.t)[0]).toBe("the device requires encryption; set its encryptionKey");
  const unneeded = await setup({}, { encryptionKey: KEY });
  expect(warnings(unneeded.t)[0]).toBe(
    "127.0.0.1 closed the connection during the encryption handshake; it may not use encryption",
  );
  expect(() =>
    integration.configSchema.parse({ devices: [{ host: "x", encryptionKey: "short" }] }),
  ).toThrow("32 bytes");
});

test("a legacy password is checked", async () => {
  const ok = await setup({ password: "hunter2" }, { password: "hunter2" });
  await settled(ok.t);
  const bad = await setup({ password: "hunter2" }, { password: "nope" });
  expect(warnings(bad.t)[0]).toBe("the device rejected the password");
  expect(bad.t.entities.size).toBe(0);
});

test("mDNS discovery connects to announced devices once each", async () => {
  const device = await FakeDevice.start();
  let announce: (found: { name: string; host: string; port: number }) => void = () => {};
  const discovering = createEsphomeIntegration({
    timing,
    browse: (_signal, onFound) => {
      announce = onFound;
    },
  });
  const t = createTestContext(discovering.configSchema.parse({ discover: true }));
  cleanups.push(() => {
    t.abort();
    device.stop();
  });
  await discovering.setup(t.ctx);
  expect(t.entities.size).toBe(0);
  announce({ name: "garage-node", host: "127.0.0.1", port: device.port });
  announce({ name: "garage-node", host: "127.0.0.1", port: device.port });
  await settled(t);
  expect(device.received.filter((m) => m.name === "HelloRequest")).toHaveLength(1);
});
