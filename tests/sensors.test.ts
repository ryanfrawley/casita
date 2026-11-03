// Derived sensors end to end: one is saved from the API, is an entity of the real house with
// a state that follows its inputs and a history, feeds an automation, can be switched off and
// deleted, and only an admin may touch it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { addUser, boot, codeOf, type Harness, record } from "./harness.ts";

type Row = Record<string, unknown>;
let h: Harness;
let client: CasitaClient;

beforeEach(async () => {
  h = await boot();
  client = await h.connect();
});
afterEach(() => h.stop());

const DOOR = `sensor FrontDoor {
  input bolt = lock.front_door
  name: "Front door"
  type: String
  value: bolt.value == .Unlocked ? "Unlocked" : "Secured"
}
`;

const WARM = `sensor Warm {
  input porch = sensor.porch_temperature
  name: "Porch warm"
  type: Bool
  value: porch.value > 25
}
`;

const setLock = (action: "lock" | "unlock") =>
  client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action },
  });

test("a saved sensor is an entity whose state follows its inputs, and has a history", async () => {
  expect(await client.request("get_sensors", {})).toEqual([]);
  const saved = (await client.request("save_sensor", {
    sensorId: "front_door",
    source: DOOR,
  })) as Row;
  expect(saved.ok).toBe(true);
  expect(saved.sensor).toMatchObject({
    id: "front_door",
    name: "Front door",
    type: "String",
    entityId: "sensor.front_door",
    entities: ["lock.front_door"],
    enabled: true,
    status: "running",
  });
  const entities = (await client.request("get_entities", {})) as Row[];
  expect(entities.find((e) => e.id === "sensor.front_door")).toMatchObject({
    domain: "sensor",
    name: "Front door",
    integrationId: "casa.sensors",
  });
  const states = (await client.request("get_states", {
    entityIds: ["sensor.front_door"],
  })) as Row[];
  expect(states[0]).toMatchObject({
    state: { domain: "sensor", value: "Secured" },
    available: true,
  });

  const seen = record(client);
  await client.request("subscribe", {
    events: ["state_changed"],
    entityIds: ["sensor.front_door"],
  });
  await seen.until(() => seen.snapshots.length === 1);
  await setLock("unlock");
  await seen.until(() =>
    seen.events.some((e) => ((e.new as Row)?.state as Row)?.value === "Unlocked"),
  );
  const history = (await client.request("get_history", {
    entityId: "sensor.front_door",
    from: 0,
    to: Date.now() + 1000,
  })) as Row;
  const values = ((history.records ?? history) as Row[]).map((r) => (r.state as Row).value);
  expect(values).toEqual(["Secured", "Unlocked"]);
});

test("a Bool sensor is a binary sensor an automation can wait on", async () => {
  await client.request("save_sensor", { sensorId: "warm", source: WARM });
  expect((await client.request("get_sensors", {})) as Row[]).toMatchObject([
    { id: "warm", type: "Bool", entityId: "binary_sensor.warm" },
  ]);
  const saved = (await client.request("save_automation", {
    automationId: "fan",
    source:
      "automation Fan {\n  on binary_sensor.warm changed to .On { call light.desk.turn_on }\n}\n",
  })) as Row;
  expect(saved.ok).toBe(true);
  const seen = record(client);
  await client.request("subscribe", { events: ["command_issued"], entityIds: ["light.desk"] });
  await seen.until(() => seen.snapshots.length === 1);
  await client.request("integration_action", {
    integrationId: "fixture.main",
    action: "set_temperature",
    params: { value: 30 },
  });
  await seen.until(() => seen.events.some((e) => e.type === "command_issued"));
  expect(seen.events[0]).toMatchObject({
    source: { kind: "automation", automationId: "automation:fan" },
  });
});

test("a save that does not compile stores nothing; off is unavailable; delete removes the entity", async () => {
  const bad = (await client.request("save_sensor", {
    sensorId: "front_door",
    source: DOOR.replace("lock.front_door", "lock.back_door"),
  })) as Row;
  expect(bad.ok).toBe(false);
  expect((bad.diagnostics as Row[]).map((d) => d.code)).toEqual(["E010"]);
  expect(await client.request("get_sensors", {})).toEqual([]);
  expect(
    await codeOf(client.request("save_sensor", { sensorId: "Front-Door", source: DOOR })),
  ).toBe("invalid");

  await client.request("save_sensor", { sensorId: "front_door", source: DOOR });
  const off = (await client.request("set_sensor_enabled", {
    sensorId: "front_door",
    enabled: false,
  })) as Row;
  expect(off).toMatchObject({ enabled: false, status: "stopped" });
  const states = (await client.request("get_states", {
    entityIds: ["sensor.front_door"],
  })) as Row[];
  expect(states[0]?.available).toBe(false);

  const source = (await client.request("get_sensor_source", { sensorId: "front_door" })) as Row;
  expect(source.source).toBe(DOOR);
  expect(source.versions).toHaveLength(1);
  const cli = await h.cli(["sensor", "list"]);
  expect(cli.code).toBe(0);
  expect(cli.stdout).toContain("front_door");
  expect(cli.stdout).toContain("sensor.front_door");

  await client.request("delete_sensor", { sensorId: "front_door" });
  expect(await client.request("get_sensors", {})).toEqual([]);
  const entities = (await client.request("get_entities", {})) as Row[];
  expect(entities.find((e) => e.id === "sensor.front_door")).toBeUndefined();
});

test("a member sees the list without its errors and may change nothing", async () => {
  await client.request("save_sensor", { sensorId: "front_door", source: DOOR });
  const root = await addUser(h, client, "root", "admin");
  const admin = await h.connect(root.token);
  const { token } = await addUser(h, admin, "pat", "member");
  const member = await h.connect(token);
  expect(await member.request("get_sensors", {})).toMatchObject([{ id: "front_door" }]);
  for (const [type, params] of [
    ["get_sensor_source", { sensorId: "front_door" }],
    ["check_sensor", { source: DOOR }],
    ["save_sensor", { sensorId: "front_door", source: "" }],
    ["set_sensor_enabled", { sensorId: "front_door", enabled: false }],
    ["delete_sensor", { sensorId: "front_door" }],
  ] as const) {
    expect(await codeOf(member.request(type as "ping", params as never)), type).toBe("forbidden");
  }
});
