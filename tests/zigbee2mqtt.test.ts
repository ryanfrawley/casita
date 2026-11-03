// The zigbee2mqtt integration against a real in-process broker and a simulated bridge.

import { afterEach, beforeEach, expect, test } from "bun:test";
import mqtt from "mqtt";
import { connectMqtt } from "../integrations/mqtt-shared/src/index.ts";
import { createZigbee2MqttIntegration } from "../integrations/zigbee2mqtt/src/index.ts";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { Broker } from "./broker.ts";
import { BOOTSTRAP_TOKEN, boot, type Harness } from "./harness.ts";

type Row = Record<string, unknown>;

/** zigbee2mqtt with one bulb: publishes the device list, answers /get and /set with state. */
async function simulateBridge(url: string) {
  const client = await mqtt.connectAsync(url);
  const devices = (await Bun.file(
    `${import.meta.dir}/fixtures/zigbee2mqtt/bridge-devices.synthetic.json`,
  ).json()) as Row[];
  const requests: { topic: string; payload: Row }[] = [];
  let bulb: Row = { state: "OFF", brightness: 254, color_temp: 370, linkquality: 80 };
  const publishBulb = () => client.publishAsync("zigbee2mqtt/Hall bulb", JSON.stringify(bulb));

  await client.subscribeAsync([
    "zigbee2mqtt/+/set",
    "zigbee2mqtt/+/get",
    "zigbee2mqtt/bridge/request/#",
  ]);
  client.on("message", (topic, raw) => {
    const payload = JSON.parse(raw.toString()) as Row;
    requests.push({ topic, payload });
    if (topic === "zigbee2mqtt/Hall bulb/set") {
      const { transition: _transition, ...changes } = payload;
      bulb = { ...bulb, ...changes };
    }
    if (topic.startsWith("zigbee2mqtt/Hall bulb/")) void publishBulb();
  });
  await client.publishAsync("zigbee2mqtt/bridge/state", JSON.stringify({ state: "online" }), {
    retain: true,
  });
  await client.publishAsync("zigbee2mqtt/bridge/devices", JSON.stringify(devices), {
    retain: true,
  });
  return { requests, stop: () => client.endAsync(true) };
}

let broker: Broker;
let bridge: Awaited<ReturnType<typeof simulateBridge>>;
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
    await Bun.sleep(20);
  }
}

beforeEach(async () => {
  broker = await Broker.start();
  bridge = await simulateBridge(broker.url);
  const integration = createZigbee2MqttIntegration(
    connectMqtt({ reconnectPeriodMs: 100, connectTimeoutMs: 1000 }),
  );
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "zigbee2mqtt"\nbrokerUrl = "${broker.url}"\n`,
    new Map([[integration.id, integration]]),
  );
  client = await h.connect();
});
afterEach(async () => {
  await h.stop();
  await bridge.stop();
  await broker.stop();
});

test("discovers the bridge's devices and learns state by asking for it", async () => {
  const state = await settled("light.hall_bulb", (r) => r.available === true);
  expect(state).toMatchObject({
    state: { domain: "light", on: false, brightness: 1 },
    attributes: { linkquality: 80 },
  });
  expect(((await client.request("get_devices", {})) as Row[]).map((d) => d.name)).toContain(
    "Front door lock",
  );
  expect(((await client.request("get_entities", {})) as Row[]).length).toBe(13);
});

test("a command reaches the device and is confirmed by its report", async () => {
  await settled("light.hall_bulb", (r) => r.available === true);
  const result = await client.request("send_command", {
    entityId: "light.hall_bulb",
    command: { domain: "light", action: "turn_on", brightness: 0.5, transitionMs: 2000 },
    confirm: true,
  });
  expect(result).toMatchObject({ status: "confirmed" });
  expect(bridge.requests.at(-1)).toEqual({
    topic: "zigbee2mqtt/Hall bulb/set",
    payload: { state: "ON", brightness: 127, transition: 2 },
  });
  expect(await settled("light.hall_bulb", (r) => (r.state as Row).on === true)).toMatchObject({
    state: { brightness: 0.5, colorTempK: 2703 },
  });
});

test("permit_join runs through the integration_action API and the CLI", async () => {
  const [integration] = (await client.request("get_integrations", {})) as { actions: Row[] }[];
  expect(integration?.actions).toMatchObject([
    {
      name: "permit_join",
      schema: { type: "object", properties: { seconds: { type: "integer" } } },
    },
  ]);

  const result = await client.request("integration_action", {
    integrationId: "zigbee2mqtt.main",
    action: "permit_join",
    params: { seconds: 30 },
  });
  expect(result).toEqual({ permitJoin: true, seconds: 30 });

  const cli = await h.cli([
    "integration",
    "action",
    "zigbee2mqtt.main",
    "permit_join",
    "--seconds",
    "0",
  ]);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual({ permitJoin: false, seconds: 0 });

  const deadline = Date.now() + 2000;
  const joins = () =>
    bridge.requests.filter((r) => r.topic === "zigbee2mqtt/bridge/request/permit_join");
  while (joins().length < 2 && Date.now() < deadline) await Bun.sleep(10);
  expect(joins().map((r) => r.payload)).toEqual([
    { value: true, time: 30 },
    { value: false, time: 0 },
  ]);
});
