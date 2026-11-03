// The generic MQTT integration against a real in-process broker (aedes) and a simulated plug.

import { afterEach, beforeEach, expect, test } from "bun:test";
import mqtt from "mqtt";
import { createMqttIntegration } from "../integrations/mqtt/src/index.ts";
import { connectMqtt } from "../integrations/mqtt-shared/src/index.ts";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { Broker } from "./broker.ts";
import { BOOTSTRAP_TOKEN, boot, codeOf, type Harness, record } from "./harness.ts";

type Row = Record<string, unknown>;

/** A smart plug: announces itself, reports retained state, and obeys its command topic. */
async function simulatePlug(url: string) {
  const client = await mqtt.connectAsync(url, { reconnectPeriod: 100 });
  const commands: string[] = [];
  const report = (relay: string, power: number) =>
    client.publishAsync("plugs/plug_1/state", JSON.stringify({ relay, meter: { power } }), {
      retain: true,
    });
  const fixture = (await Bun.file(
    `${import.meta.dir}/fixtures/mqtt/plug.synthetic.json`,
  ).json()) as Row;
  for (const [topic, config] of Object.entries(fixture)) {
    await client.publishAsync(topic, JSON.stringify(config), { retain: true });
  }
  await client.publishAsync("plugs/plug_1/availability", "online", { retain: true });
  await report("OFF", 0);
  await client.subscribeAsync("plugs/plug_1/set");
  client.on("message", (_topic, payload) => {
    commands.push(payload.toString());
    void report(payload.toString(), payload.toString() === "ON" ? 60 : 0);
  });
  return { commands, report, stop: () => client.endAsync(true) };
}

let broker: Broker;
let plug: Awaited<ReturnType<typeof simulatePlug>>;
let h: Harness;
let client: CasitaClient;

const config = () => `
[server]
apiToken = "${BOOTSTRAP_TOKEN}"

[[integration]]
type = "mqtt"
brokerUrl = "${broker.url}"
`;

const stateOf = async (c: CasitaClient, entityId: string) =>
  ((await c.request("get_states", { entityIds: [entityId] })) as Row[])[0];

/** Polls until the entity's state record satisfies `matches`. */
async function settled(
  entityId: string,
  matches: (record: Row) => boolean,
  timeoutMs = 5000,
): Promise<Row> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await stateOf(client, entityId).catch(() => undefined);
    if (state && matches(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`${entityId} never settled; last: ${JSON.stringify(state)}`);
    await Bun.sleep(20);
  }
}

const value = (expected: unknown) => (r: Row) => (r.state as Row).value === expected;
const available = (expected: boolean) => (r: Row) => r.available === expected;

beforeEach(async () => {
  broker = await Broker.start();
  plug = await simulatePlug(broker.url);
  const integration = createMqttIntegration(
    connectMqtt({ reconnectPeriodMs: 100, connectTimeoutMs: 1000 }),
  );
  h = await boot(config(), new Map([[integration.id, integration]]));
  client = await h.connect();
});
afterEach(async () => {
  await h.stop();
  await plug.stop();
  await broker.stop();
});

test("discover, observe, control with confirmation", async () => {
  await settled("sensor.coffee_plug_power", available(true));
  expect(((await client.request("get_entities", {})) as Row[]).map((e) => e.id).sort()).toEqual([
    "sensor.coffee_plug_power",
    "switch.coffee_plug",
  ]);
  expect(await client.request("get_devices", {})).toMatchObject([
    {
      name: "Plug 1",
      manufacturer: "Acme",
      model: "P110",
      firmware: "1.4.0",
      integrationId: "mqtt.main",
    },
  ]);
  expect(await stateOf(client, "switch.coffee_plug")).toMatchObject({
    available: true,
    state: { on: false },
  });

  // The device reports on its own.
  await plug.report("OFF", 3.5);
  await settled("sensor.coffee_plug_power", value(3.5));

  // A command reaches the device, and the confirmation comes from the device's own report.
  const result = await client.request("send_command", {
    entityId: "switch.coffee_plug",
    command: { domain: "switch", action: "toggle" },
    confirm: true,
  });
  expect(result).toMatchObject({ status: "confirmed", command: { action: "turn_on" } });
  expect(plug.commands).toEqual(["ON"]);
  await settled("sensor.coffee_plug_power", value(60));

  const cli = await h.cli(["cmd", "switch.coffee", "turn_off", "--confirm"]);
  expect(cli).toMatchObject({ code: 0, stderr: "" });
  expect(plug.commands).toEqual(["ON", "OFF"]);
});

test("losing the broker marks entities unavailable; recovery brings fresh state", async () => {
  await settled("switch.coffee_plug", available(true));
  await broker.down();
  await settled("switch.coffee_plug", available(false));
  expect(await stateOf(client, "sensor.coffee_plug_power")).toMatchObject({ available: false });
  const send = client.request("send_command", {
    entityId: "switch.coffee_plug",
    command: { domain: "switch", action: "turn_on" },
  });
  expect(await codeOf(send)).toBe("unavailable");
  expect(await (await fetch(`${h.url}/health`)).json()).toMatchObject({
    integrations: [{ status: "running" }],
  });

  await broker.up();
  await settled("switch.coffee_plug", available(true));
  const result = await client.request("send_command", {
    entityId: "switch.coffee_plug",
    command: { domain: "switch", action: "turn_on" },
    confirm: true,
  });
  expect(result).toMatchObject({ status: "confirmed" });
}, 15_000);

test("an unreachable broker surfaces as an integration error and is retried", async () => {
  await settled("switch.coffee_plug", available(true));
  await broker.down();
  await h.restart();
  const after = await h.connect();
  const [integration] = (await after.request("get_integrations", {})) as Row[];
  expect(integration).toMatchObject({ integrationId: "mqtt.main", status: "error" });
  expect(String(integration?.error)).toContain(`Cannot reach the MQTT broker at ${broker.url}`);
  // Last known state is still served, as unavailable.
  expect(await stateOf(after, "switch.coffee_plug")).toMatchObject({
    available: false,
    state: { on: false },
  });

  await broker.up();
  const events = record(after);
  await after.request("subscribe", { events: ["integration_status"] });
  await events.until(() => events.events.some((e) => e.status === "running"), 5000);
}, 15_000);

test("after a server restart, state is restored and then refreshed by the device", async () => {
  // The plug's retained state has to arrive before it can be commanded.
  await settled("switch.coffee_plug", available(true));
  await client.request("send_command", {
    entityId: "switch.coffee_plug",
    command: { domain: "switch", action: "turn_on" },
    confirm: true,
  });
  await settled("sensor.coffee_plug_power", value(60));
  const before = await stateOf(client, "switch.coffee_plug");

  await h.restart();
  client = await h.connect();
  const after = await settled("switch.coffee_plug", available(true));
  // Same entity id, same state, and changedAt untouched: the retained report was a heartbeat.
  expect(after).toMatchObject({
    available: true,
    state: { on: true },
    changedAt: before?.changedAt,
  });
  expect(((await client.request("get_entities", {})) as Row[]).length).toBe(2);
});
