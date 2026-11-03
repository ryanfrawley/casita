import { expect, test } from "bun:test";
import { createTestContext } from "@casita/integration-testing";
import { FakeBroker } from "@casita/mqtt-shared/testing";
import { createMqttIntegration } from "../src/index.ts";

async function setup(fixtures: string[] = [], discoveryPrefix = "casita") {
  const broker = new FakeBroker();
  for (const fixture of fixtures) {
    await broker.load(new URL(`../../../tests/fixtures/mqtt/${fixture}`, import.meta.url));
  }
  const integration = createMqttIntegration(broker.connect);
  const t = createTestContext(
    integration.configSchema.parse({ brokerUrl: "mqtt://broker:1883", discoveryPrefix }),
  );
  await integration.setup(t.ctx);
  return { broker, t };
}

const warnings = (t: Awaited<ReturnType<typeof setup>>["t"]) =>
  t.logs.filter((l) => l.level === "warn").map((l) => (l.data as { reason: string }).reason);

test("discovers a device and its entities from a fixture, expanding abbreviations and ~", async () => {
  const { t } = await setup(["plug.synthetic.json"]);
  expect([...t.devices.values()]).toMatchObject([
    { uniqueId: "plug_1", name: "Plug 1", manufacturer: "Acme", model: "P110", firmware: "1.4.0" },
  ]);
  expect([...t.entities.values()]).toMatchObject([
    { id: "switch.coffee_plug", uniqueId: "plug_1_relay", domain: "switch", name: "Coffee plug" },
    { id: "sensor.coffee_plug_power", uniqueId: "plug_1_power", domain: "sensor" },
  ]);
  expect(new Set([...t.entities.values()].map((e) => e.deviceId)).size).toBe(1);
  expect(t.states.size).toBe(0); // nothing is known until the device reports
});

test("reports state on a transport message, through value_json templates", async () => {
  const { broker, t } = await setup(["plug.synthetic.json"]);
  broker.publish("plugs/plug_1/state", { relay: "ON", meter: { power: 61.5 } });
  expect(t.state("plug_1_relay")).toEqual({
    state: { domain: "switch", on: true },
    attributes: undefined,
    available: true,
  });
  expect(t.state("plug_1_power")?.state).toEqual({
    domain: "sensor",
    value: 61.5,
    unit: "W",
    deviceClass: "power",
  });

  broker.publish("plugs/plug_1/state", { relay: "OFF", meter: {} });
  expect(t.state("plug_1_relay")?.state).toEqual({ domain: "switch", on: false });
  expect(t.state("plug_1_power")?.state).toMatchObject({ value: 61.5 }); // a missing value is not a report
  broker.publish("plugs/plug_1/state", "not json");
  broker.publish("plugs/plug_1/state", { relay: "MAYBE" });
  expect(t.reports).toHaveLength(3);
});

test("delivers commands to the transport and never reports state itself", async () => {
  const { broker, t } = await setup(["plug.synthetic.json", "dimmer.synthetic.json"]);
  await t.command("plug_1_relay", { domain: "switch", action: "turn_on" });
  await t.command("dimmer_7", { domain: "light", action: "turn_on", brightness: 0.25 });
  await t.command("dimmer_7", { domain: "light", action: "turn_on", brightness: 0.001 });
  await t.command("dimmer_7", { domain: "light", action: "turn_off" });
  expect(broker.published).toEqual([
    { topic: "plugs/plug_1/set", payload: "ON" },
    { topic: "dimmer_7/level/set", payload: "25" },
    { topic: "dimmer_7/power/set", payload: "on" },
    { topic: "dimmer_7/level/set", payload: "1" },
    { topic: "dimmer_7/power/set", payload: "on" },
    { topic: "dimmer_7/power/set", payload: "off" },
  ]);
  expect(t.reports).toEqual([]);
  await expect(t.command("plug_1_power", { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "read-only",
  );
});

test("a failed publish rejects with a user-readable message", async () => {
  const { broker, t } = await setup(["plug.synthetic.json"]);
  broker.drop();
  await expect(t.command("plug_1_relay", { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "The MQTT broker is not connected",
  );
});

test("a light combines its power and brightness topics", async () => {
  const { broker, t } = await setup(["dimmer.synthetic.json"]);
  expect(t.entity("dimmer_7").capabilities).toEqual({ brightness: true });
  broker.publish("dimmer_7/level", "40");
  expect(t.state("dimmer_7")).toBeUndefined(); // brightness alone does not say whether it is on
  broker.publish("dimmer_7/power", "on");
  expect(t.state("dimmer_7")?.state).toEqual({ domain: "light", on: true, brightness: 0.4 });
  broker.publish("dimmer_7/level", "100");
  expect(t.state("dimmer_7")?.state).toEqual({ domain: "light", on: true, brightness: 1 });
});

test("marks entities unavailable on disconnect and recovers from fresh reports", async () => {
  const { broker, t } = await setup(["plug.synthetic.json", "dimmer.synthetic.json"]);
  broker.publish("plugs/plug_1/availability", "online");
  broker.publish("plugs/plug_1/state", { relay: "ON", meter: { power: 5 } });
  broker.publish("dimmer_7/power", "off");
  expect([...t.states.values()].map((s) => s.available)).toEqual([true, true, true]);

  broker.drop();
  expect([...t.states.values()].map((s) => s.available)).toEqual([false, false, false]);
  broker.restore();
  expect([...t.states.values()].map((s) => s.available)).toEqual([true, true, true]);
  expect(t.entities.size).toBe(3);
});

test("a device's availability topic controls its entities", async () => {
  const { broker, t } = await setup(["plug.synthetic.json"]);
  broker.publish("plugs/plug_1/state", { relay: "ON", meter: { power: 5 } });
  broker.publish("plugs/plug_1/availability", "offline");
  expect(t.state("plug_1_relay")).toMatchObject({ available: false, state: { on: true } });
  broker.publish("plugs/plug_1/availability", "garbage");
  expect(t.state("plug_1_relay")?.available).toBe(false);
  broker.publish("plugs/plug_1/availability", "online");
  expect(t.state("plug_1_relay")?.available).toBe(true);
});

test("cleans up on abort", async () => {
  const { broker, t } = await setup(["plug.synthetic.json"]);
  expect(broker.subscriptionCount).toBeGreaterThan(2);
  t.abort();
  expect(broker.subscriptionCount).toBe(0);
  broker.publish("plugs/plug_1/state", { relay: "ON" });
  expect(t.reports).toEqual([]);
});

test("an unreachable broker rejects setup", async () => {
  const broker = new FakeBroker();
  broker.unreachable = true;
  const integration = createMqttIntegration(broker.connect);
  const t = createTestContext(integration.configSchema.parse({ brokerUrl: "mqtt://broker:1883" }));
  await expect(integration.setup(t.ctx)).rejects.toThrow(
    "Cannot reach the MQTT broker at mqtt://broker:1883",
  );
});

test("binary sensors, covers, and buttons", async () => {
  const { broker, t } = await setup();
  broker.publish("casita/binary_sensor/door/config", {
    name: "Back door",
    unique_id: "door",
    state_topic: "door/state",
    payload_on: "open",
    payload_off: "closed",
    device_class: "door",
  });
  broker.publish("door/state", "open");
  expect(t.state("door")?.state).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "door",
  });

  broker.publish("casita/cover/blind/config", {
    name: "Blind",
    unique_id: "blind",
    state_topic: "blind/state",
    position_topic: "blind/position",
    command_topic: "blind/set",
    set_position_topic: "blind/position/set",
  });
  expect(t.entity("blind").capabilities).toEqual({ position: true });
  broker.publish("blind/position", "30");
  broker.publish("blind/state", "opening");
  expect(t.state("blind")?.state).toEqual({ domain: "cover", motion: "opening", position: 0.3 });
  broker.publish("blind/state", "open");
  broker.publish("blind/position", "100");
  expect(t.state("blind")?.state).toEqual({ domain: "cover", motion: "stopped", position: 1 });
  for (const action of ["open", "close", "stop"] as const)
    await t.command("blind", { domain: "cover", action });
  await t.command("blind", { domain: "cover", action: "set_position", position: 0.42 });
  expect(broker.published.map((p) => `${p.topic}=${p.payload}`)).toEqual([
    "blind/set=OPEN",
    "blind/set=CLOSE",
    "blind/set=STOP",
    "blind/position/set=42",
  ]);

  broker.publish("casita/button/node_1/restart/config", {
    name: "Restart",
    command_topic: "node_1/restart",
  });
  expect(t.entity("button/node_1/restart")).toMatchObject({ id: "button.restart" }); // no unique_id: keyed by topic
  expect(t.state("button/node_1/restart")).toEqual({
    state: { domain: "button" },
    attributes: undefined,
    available: true,
  });
  await t.command("button/node_1/restart", { domain: "button", action: "press" });
  expect(broker.published.at(-1)).toEqual({ topic: "node_1/restart", payload: "PRESS" });
  expect(t.state("button/node_1/restart")?.state).toMatchObject({ pressedAt: expect.any(Number) });
});

test("unusable configs are logged and skipped without stopping discovery", async () => {
  const { broker, t } = await setup();
  const config = (extra: object) => ({ name: "x", state_topic: "x/state", ...extra });
  broker.publish("casita/sensor/a/config", config({ value_template: "{{ value | float * 2 }}" }));
  broker.publish("casita/sensor/b/config", "{not json");
  broker.publish("casita/switch/c/config", { name: "no state", command_topic: "c/set" });
  broker.publish("casita/light/d/config", config({ schema: "json" }));
  broker.publish("casita/sensor/e/config", config({ state_topic: 5 }));
  broker.publish("casita/climate/f/config", config({}));
  broker.publish("casita/sensor/too/many/levels/config", config({}));
  broker.publish(
    "casita/sensor/ok/config",
    config({ value_template: "{{ value_json['a b'][0].c }}" }),
  );

  expect(warnings(t)).toEqual([
    'unsupported template "{{ value | float * 2 }}"',
    "payload is not JSON",
    "no state_topic",
    'light schema "json" is not supported',
    expect.stringContaining("state_topic"),
  ]);
  expect<string[]>([...t.entities.keys()]).toEqual(["sensor.x"]);
  broker.publish("x/state", { "a b": [{ c: "7" }] });
  expect(t.state("sensor/ok")?.state).toMatchObject({ value: 7 });
});

test("an updated config re-registers the same entity; an empty payload removes it", async () => {
  const { broker, t } = await setup(["dimmer.synthetic.json"]);
  const id = t.entity("dimmer_7").id;
  const before = broker.subscriptionCount;
  broker.publish("casita/light/dimmer_7/config", {
    name: "Hall dimmer",
    unique_id: "dimmer_7",
    state_topic: "dimmer_7/power2",
    command_topic: "dimmer_7/power/set",
  });
  expect(t.entity("dimmer_7")).toMatchObject({ id, capabilities: {} });
  expect(broker.subscriptionCount).toBe(before - 1);
  broker.publish("dimmer_7/power", "ON");
  expect(t.reports).toEqual([]);
  broker.publish("dimmer_7/power2", "ON");
  expect(t.state("dimmer_7")?.state).toEqual({ domain: "light", on: true });

  broker.publish("casita/light/dimmer_7/config", "");
  expect(t.entities.size).toBe(0);
});

test("only the configured discovery prefix is honored", async () => {
  const { broker, t } = await setup([], "homeassistant");
  broker.publish("casita/sensor/a/config", { name: "a", state_topic: "a" });
  expect(t.entities.size).toBe(0);
  broker.publish("homeassistant/sensor/a/config", { name: "a", state_topic: "a" });
  expect(t.entities.size).toBe(1);
});
