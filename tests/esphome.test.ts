// The ESPHome integration against a fake device speaking the native API over local TCP.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createEsphomeIntegration } from "../integrations/esphome/src/index.ts";
import { FakeDevice } from "../integrations/esphome/test/fake-device.ts";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { BOOTSTRAP_TOKEN, boot, type Harness } from "./harness.ts";

type Row = Record<string, unknown>;
const KEY = Buffer.alloc(32, 3).toString("base64");
const integration = createEsphomeIntegration({
  timing: { timeoutMs: 500, keepaliveMs: 200, backoffBaseMs: 30, backoffMaxMs: 60 },
});

let device: FakeDevice;
let h: Harness;
let client: CasitaClient;

async function settled(entityId: string, matches: (record: Row) => boolean): Promise<Row> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [state] = (await client
      .request("get_states", { entityIds: [entityId] })
      .catch(() => [])) as Row[];
    if (state && matches(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`${entityId} never settled; last: ${JSON.stringify(state)}`);
    await Bun.sleep(10);
  }
}
const available = (expected: boolean) => (r: Row) => r.available === expected;

beforeEach(async () => {
  device = await FakeDevice.start({ encryptionKey: KEY });
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "esphome"\n\n` +
      `[[integration.devices]]\nhost = "127.0.0.1"\nport = ${device.port}\nencryptionKey = "${KEY}"\n`,
    new Map([[integration.id, integration]]),
  );
  client = await h.connect();
});
afterEach(async () => {
  await h.stop();
  device.stop();
});

test("discover, observe, and control an encrypted device with confirmation", async () => {
  expect(await settled("sensor.garage_temperature", available(true))).toMatchObject({
    state: { domain: "sensor", value: 21.5, unit: "°C" },
  });
  expect(await client.request("get_devices", {})).toMatchObject([
    { name: "Garage", model: "esp32dev", firmware: "2026.8.0", integrationId: "esphome.main" },
  ]);
  expect(((await client.request("get_entities", {})) as Row[]).length).toBe(7);

  device.report({ type: "Sensor", key: 104, state: 30.02 });
  await settled("sensor.garage_temperature", (r) => (r.state as Row).value === 30);

  const light = await client.request("send_command", {
    entityId: "light.garage_strip",
    command: { domain: "light", action: "turn_on", brightness: 0.8 },
    confirm: true,
  });
  expect(light).toMatchObject({ status: "confirmed" });
  const cli = await h.cli(["cmd", "switch.garage_relay", "toggle", "--confirm"]);
  expect(cli).toMatchObject({ code: 0, stderr: "" });
  const press = await client.request("send_command", {
    entityId: "button.garage_restart",
    command: { domain: "button", action: "press" },
    confirm: true,
  });
  expect(press).toMatchObject({ status: "confirmed" });
  expect(device.commands().map((c) => c.name)).toEqual([
    "LightCommandRequest",
    "SwitchCommandRequest",
    "ButtonCommandRequest",
  ]);
});

test("losing the device marks its entities unavailable; it recovers when the device returns", async () => {
  await settled("switch.garage_relay", available(true));
  device.stop();
  await settled("switch.garage_relay", available(false));
  await settled("button.garage_restart", available(false));
  device.listen();
  await settled("switch.garage_relay", available(true));
  await settled("button.garage_restart", available(true));
});

test("after a server restart the same entities come back with their state", async () => {
  await client.request("send_command", {
    entityId: "switch.garage_relay",
    command: { domain: "switch", action: "turn_on" },
    confirm: true,
  });
  await h.restart();
  client = await h.connect();
  expect(await settled("switch.garage_relay", available(true))).toMatchObject({
    state: { on: true },
  });
  expect(((await client.request("get_entities", {})) as Row[]).length).toBe(7);
});
