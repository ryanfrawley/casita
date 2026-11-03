import { afterEach, beforeEach, expect, test } from "bun:test";
import { CasitaClient, endpoints } from "../packages/client/src/client.ts";
import { BOOTSTRAP_TOKEN, boot, codeOf, type Harness, record } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await boot();
});
afterEach(() => h.stop());

type Row = Record<string, unknown>;

test("the socket requires auth as its first message", async () => {
  const closed = (first: unknown) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(endpoints(h.url).ws);
      ws.addEventListener("open", () => ws.send(JSON.stringify(first)));
      ws.addEventListener("close", (e) => resolve(e.code));
    });
  expect(await closed({ id: 1, type: "ping" })).toBe(4401);
  expect(await closed({ type: "auth", token: "wrong" })).toBe(4401);
  expect(await codeOf(CasitaClient.connect(h.url, "wrong"))).toBe("auth");
});

test("HTTP: /health is public, everything else needs a bearer token", async () => {
  const health = await fetch(`${h.url}/health`);
  expect(await health.json()).toEqual({
    status: "ok",
    integrations: [{ integrationId: "fixture.main", status: "running" }],
  });
  expect((await fetch(`${h.url}/api/schema`)).status).toBe(401);
  const schema = await fetch(`${h.url}/api/schema`, {
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  expect(Object.keys((await schema.json()) as Row)).toEqual([
    "version",
    "auth",
    "requests",
    "messages",
  ]);
  expect(
    (await fetch(`${h.url}/nope`, { headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` } }))
      .status,
  ).toBe(404);
});

test("requests are validated and answered in the envelope", async () => {
  const client = await h.connect();
  expect(await client.request("ping", {})).toEqual({ time: expect.any(Number) });
  expect(await codeOf(client.request("nope" as "ping", {}))).toBe("bad_request");
  expect(await codeOf(client.request("get_states", { entityIds: "x" as never }))).toBe(
    "bad_request",
  );
  expect(await codeOf(client.request("get_states", { entityIds: ["light.nope"] }))).toBe(
    "not_found",
  );
  expect(await client.request("get_status", {})).toMatchObject({
    protocol: 1,
    entities: 4,
    devices: 1,
  });
});

test("subscribe sends a snapshot, then streams events in order", async () => {
  const client = await h.connect();
  const seen = record(client);
  const reply = client.request("subscribe", {}) as Promise<{ subscriptionId: number }>;
  // The reply arrives before the snapshot.
  const { subscriptionId } = await reply.then((r) => {
    expect(seen.snapshots).toHaveLength(0);
    return r;
  });
  await seen.until(() => seen.snapshots.length === 1);
  expect(seen.snapshots[0]?.subscriptionId).toBe(subscriptionId);
  expect(seen.snapshots[0]?.states.map((s) => s.entityId).sort()).toEqual([
    "light.desk",
    "lock.front_door",
    "sensor.porch_temperature",
    "switch.mute",
  ]);

  const result = await client.request("send_command", {
    entityId: "light.desk",
    command: { domain: "light", action: "turn_on", brightness: 0.4 },
    confirm: true,
  });
  expect(result).toMatchObject({ status: "confirmed", command: { brightness: 0.4 } });
  await seen.until(() => seen.events.some((e) => e.type === "state_changed"));
  expect(seen.events.map((e) => e.type)).toEqual(["command_issued", "state_changed"]);
  expect(seen.events[1]).toMatchObject({
    entityId: "light.desk",
    new: { state: { on: true, brightness: 0.4 } },
  });

  await client.request("unsubscribe", { subscriptionId });
  await client.request("send_command", {
    entityId: "light.desk",
    command: { domain: "light", action: "turn_off" },
  });
  await client.request("ping", {});
  expect(seen.events).toHaveLength(2);
});

test("subscriptions filter by event type and entity", async () => {
  const client = await h.connect();
  const seen = record(client);
  await client.request("subscribe", { events: ["state_changed"], entityIds: ["lock.front_door"] });
  await seen.until(() => seen.snapshots.length === 1);
  expect(seen.snapshots[0]?.states.map((s) => s.entityId)).toEqual(["lock.front_door"]);

  await client.request("send_command", {
    entityId: "light.desk",
    command: { domain: "light", action: "turn_on" },
  });
  await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "unlock" },
  });
  await seen.until(() => seen.events.length > 0);
  await client.request("ping", {});
  expect(seen.events).toMatchObject([{ type: "state_changed", entityId: "lock.front_door" }]);
});

test("commands report router and validation errors by code", async () => {
  const client = await h.connect();
  const send = (entityId: string, command: Row, confirm = false) =>
    client.request("send_command", { entityId, command: command as never, confirm });
  expect(await codeOf(send("light.desk", { domain: "switch", action: "turn_on" }))).toBe(
    "domain_mismatch",
  );
  expect(
    await codeOf(send("light.desk", { domain: "light", action: "turn_on", colorTempK: 3000 })),
  ).toBe("unsupported");
  expect(await codeOf(send("light.desk", { domain: "light", action: "explode" }))).toBe(
    "bad_request",
  );
  expect(
    await codeOf(send("sensor.porch_temperature", { domain: "switch", action: "turn_on" })),
  ).toBe("domain_mismatch");
});

test("areas, metadata, rename with alias, and area commands", async () => {
  const client = await h.connect();
  const area = (await client.request("create_area", { name: "Front Hall" })) as { id: string };
  expect(area.id).toBe("front_hall");
  const [device] = (await client.request("get_devices", {})) as { id: string }[];
  await client.request("update_device", { deviceId: device?.id ?? "", areaId: area.id });
  expect(
    ((await client.request("get_entities", { areaId: area.id })) as Row[]).map((e) => e.id).sort(),
  ).toEqual(["light.desk", "lock.front_door"]);

  const outcomes = await client.request("send_area_command", {
    areaId: area.id,
    command: { domain: "light", action: "turn_on" },
    confirm: true,
  });
  expect(outcomes).toMatchObject([{ entityId: "light.desk", result: { status: "confirmed" } }]);

  const renamed = await client.request("update_entity", {
    entityId: "light.desk",
    newId: "light.office",
    name: "Office",
  });
  expect(renamed).toMatchObject({ id: "light.office", name: "Office" });
  const stale = client.request("get_states", { entityIds: ["light.desk"] });
  await expect(stale).rejects.toThrow("light.desk was renamed to light.office");
  const [state] = (await client.request("get_states", { entityIds: ["light.office"] })) as Row[];
  expect(state).toMatchObject({ entityId: "light.office", state: { on: true } });
  expect(await codeOf(client.request("delete_entity", { entityId: "light.office" }))).toBe(
    "invalid",
  );
});

test("update_entity sets a sensor's class, the state reads it, and null takes it back", async () => {
  const client = await h.connect();
  const seen = record(client);
  await client.request("subscribe", {
    events: ["state_changed"],
    entityIds: ["sensor.porch_temperature"],
  });
  await seen.until(() => seen.snapshots.length === 1);
  const set = await client.request("update_entity", {
    entityId: "sensor.porch_temperature",
    deviceClass: "humidity",
  });
  expect(set).toMatchObject({ id: "sensor.porch_temperature", deviceClass: "humidity" });
  const entities = (await client.request("get_entities", {})) as Row[];
  expect(entities.find((e) => e.id === "sensor.porch_temperature")).toMatchObject({
    deviceClass: "humidity",
  });
  const [state] = (await client.request("get_states", {
    entityIds: ["sensor.porch_temperature"],
  })) as Row[];
  expect(state).toMatchObject({ state: { value: 20, deviceClass: "humidity" } });

  const cleared = (await client.request("update_entity", {
    entityId: "sensor.porch_temperature",
    deviceClass: null,
  })) as Row;
  expect(cleared.deviceClass).toBeUndefined();
  const [after] = (await client.request("get_states", {
    entityIds: ["sensor.porch_temperature"],
  })) as Row[];
  expect(after).toMatchObject({ state: { deviceClass: "temperature" } });
  await seen.until(() => seen.events.length === 2);
  expect(seen.events).toMatchObject([
    { type: "state_changed", new: { state: { deviceClass: "humidity" } } },
    { type: "state_changed", new: { state: { deviceClass: "temperature" } } },
  ]);
});

test("update_entity refuses a class the entity cannot have", async () => {
  const client = await h.connect();
  const update = (entityId: string, deviceClass: unknown) =>
    client.request("update_entity", { entityId, deviceClass: deviceClass as string });
  expect(await codeOf(update("light.desk", "window"))).toBe("invalid");
  expect(await codeOf(update("sensor.porch_temperature", "window"))).toBe("invalid");
  expect(await codeOf(update("sensor.porch_temperature", "nonsense"))).toBe("invalid");
  expect(await codeOf(update("sensor.porch_temperature", 7))).toBe("bad_request");
  const entities = (await client.request("get_entities", {})) as Row[];
  expect(entities.find((e) => e.id === "sensor.porch_temperature")?.deviceClass).toBeUndefined();
});

test("update_device with newId renames the device and streams device_renamed", async () => {
  const admin = await h.connect();
  const seen = record(admin);
  await admin.request("subscribe", { events: ["device_renamed"] });
  await seen.until(() => seen.snapshots.length === 1);
  const [hub] = (await admin.request("get_devices", {})) as Row[];
  expect(hub).toMatchObject({ id: "fixture_hub", name: "Fixture hub" });

  const renamed = await admin.request("update_device", {
    deviceId: "fixture_hub",
    newId: "hub",
    name: "Hub",
  });
  expect(renamed).toMatchObject({ id: "hub", name: "Hub" });
  await seen.until(() => seen.events.length === 1);
  expect(seen.events).toMatchObject([
    { type: "device_renamed", oldId: "fixture_hub", device: { id: "hub", name: "Hub" } },
  ]);
  // Its entities follow it; the old id is simply gone, with no alias.
  const desk = ((await admin.request("get_entities", {})) as Row[]).find(
    (e) => e.id === "light.desk",
  );
  expect(desk?.deviceId).toBe("hub");
  expect(await codeOf(admin.request("update_device", { deviceId: "fixture_hub", name: "x" }))).toBe(
    "not_found",
  );
  // A malformed id is refused by the registry.
  expect(await codeOf(admin.request("update_device", { deviceId: "hub", newId: "Hub!" }))).toBe(
    "invalid",
  );
});

test("integrations: listing with schemas, actions, config set triggering a reload", async () => {
  const client = await h.connect();
  const seen = record(client);
  await client.request("subscribe", {
    events: ["integration_status", "state_changed", "config_changed"],
  });
  const [integration] = (await client.request("get_integrations", {})) as Row[];
  expect(integration).toMatchObject({
    integrationId: "fixture.main",
    status: "running",
    configSchema: { type: "object", properties: { label: { type: "string" } } },
    actions: [{ name: "set_temperature", schema: { type: "object" } }],
  });

  expect(
    await client.request("integration_action", {
      integrationId: "fixture.main",
      action: "set_temperature",
      params: { value: 25 },
    }),
  ).toEqual({ value: 25 });
  const bad = client.request("integration_action", {
    integrationId: "fixture.main",
    action: "set_temperature",
    params: {},
  });
  expect(await codeOf(bad)).toBe("invalid");

  expect(
    await codeOf(
      client.request("set_config", { path: "integration.fixture.main.label", value: 5 }),
    ),
  ).toBe("invalid");
  await client.request("set_config", { path: "integration.fixture.main.label", value: "v2" });
  await seen.until(
    () =>
      seen.events.filter((e) => e.type === "integration_status" && e.status === "running").length >
      0,
  );
  expect(seen.events.filter((e) => e.type === "integration_status").map((e) => e.status)).toEqual([
    "stopped",
    "starting",
    "running",
  ]);
  expect(
    await client.request("get_config", { path: "integration.fixture.main.label" }),
  ).toMatchObject({ value: "v2" });
  expect(await Bun.file(h.configPath).text()).toContain('label = "v2"');
});

test("after a restart, state is restored as unavailable until the integration reports", async () => {
  const client = await h.connect();
  await client.request("send_command", {
    entityId: "light.desk",
    command: { domain: "light", action: "turn_on" },
  });

  // Restart without the integration: its entities are orphaned and keep their last state.
  await h.restart(`[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n`);
  const after = await h.connect();
  const [state] = (await after.request("get_states", { entityIds: ["light.desk"] })) as Row[];
  expect(state).toMatchObject({ available: false, state: { domain: "light", on: true } });
  const [entity] = (await after.request("get_entities", { domain: "light" })) as Row[];
  expect(entity).toMatchObject({ id: "light.desk", orphaned: true });
  expect(
    await codeOf(
      after.request("send_command", {
        entityId: "light.desk",
        command: { domain: "light", action: "turn_off" },
      }),
    ),
  ).toBe("unavailable");
  await after.request("delete_entity", { entityId: "light.desk" });
  expect(await after.request("get_entities", { domain: "light" })).toEqual([]);
});

// ───────── CLI ─────────

test("cli: status, entities, state with a unique prefix", async () => {
  const status = await h.cli(["status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toMatch(/fixture\.main +running/);
  expect(status.stdout).toContain("entities  4");

  const entities = await h.cli(["entities", "--domain", "light", "--json"]);
  expect(JSON.parse(entities.stdout)).toMatchObject([
    { id: "light.desk", name: "Desk", state: "off" },
  ]);
  expect((await h.cli(["entities"])).stdout).toContain(
    "lock.front_door           Front door         locked",
  );

  const state = await h.cli(["state", "light.d"]);
  expect(state.stdout).toContain("light.desk  off");
  const ambiguous = await h.cli(["state", "l"]);
  expect(ambiguous.code).toBe(2);
  expect(ambiguous.stderr).toContain('"l" is ambiguous: light.desk, lock.front_door');
});

test("cli: cmd maps flags to command fields; exit codes distinguish failures", async () => {
  const ok = await h.cli(["cmd", "light.desk", "turn_on", "--brightness", "0.5", "--confirm"]);
  expect(ok).toMatchObject({ code: 0, stderr: "" });
  expect(ok.stdout).toContain("light.desk  confirmed");
  expect(ok.stdout).toContain('"brightness":0.5');

  const serverError = await h.cli(["cmd", "light.desk", "turn_on", "--colorTempK", "3000"]);
  expect(serverError.code).toBe(1);
  expect(serverError.stderr).toContain("error [unsupported]");

  const noToken = await h.cli(["status"], { CASITA_TOKEN: "" });
  expect(noToken.code).toBe(2);
  expect(noToken.stderr.trim()).toBe(
    "No token: run `casita login`, or set CASITA_TOKEN or --token.",
  );
  expect((await h.cli(["status"], { CASITA_TOKEN: "wrong" })).code).toBe(2);
  expect((await h.cli(["status"], { CASITA_URL: "http://127.0.0.1:1" })).code).toBe(2);
});

test('cli: entity set --class chooses a sensor\'s class; "default" takes it back', async () => {
  const set = await h.cli(["entity", "set", "sensor.porch_temperature", "--class", "humidity"]);
  expect(set).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(set.stdout)).toMatchObject({ deviceClass: "humidity" });

  // Another option leaves the class alone.
  expect((await h.cli(["entity", "set", "sensor.porch_temperature", "--name", "Porch"])).code).toBe(
    0,
  );
  const client = await h.connect();
  const porch = async () =>
    ((await client.request("get_entities", {})) as Row[]).find(
      (e) => e.id === "sensor.porch_temperature",
    );
  expect(await porch()).toMatchObject({ name: "Porch", deviceClass: "humidity" });

  const cleared = await h.cli(["entity", "set", "sensor.porch_temperature", "--class", "default"]);
  expect(cleared.code).toBe(0);
  expect(JSON.parse(cleared.stdout).deviceClass).toBeUndefined();
  expect((await porch())?.deviceClass).toBeUndefined();

  const bad = await h.cli(["entity", "set", "light.desk", "--class", "window"]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("error [invalid]");
});

test("cli: watch streams state changes one line each", async () => {
  const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", "watch", "light.desk"], {
    env: {
      PATH: Bun.env.PATH,
      CASITA_URL: h.url,
      CASITA_TOKEN: BOOTSTRAP_TOKEN,
      CASITA_CREDENTIALS: `${h.dir}/none`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = await h.connect();
  let output = "";
  const reading = (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
  })();
  // The watcher needs a moment to subscribe; keep toggling until it prints.
  for (let i = 0; i < 100 && !output.includes("\n"); i++) {
    await client.request("send_command", {
      entityId: "light.desk",
      command: { domain: "light", action: i % 2 ? "turn_off" : "turn_on" },
    });
    await Bun.sleep(50);
  }
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(0);
  await reading;
  expect(output).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z {2}light\.desk {2}(on 100%|off)\n/);
}, 15_000);

test("cli: repl runs commands on one connection and survives bad ones", async () => {
  const script = [
    "state light.desk",
    "cmd light.desk turn_on --brightness 0.5 --confirm",
    "entities --domain light --json",
    "entities --domain lock", // --json from the line before must not stick
    "bogus-command",
    "state light.nope",
    'area add "Front Hall"',
    "area list",
    "exit",
    "status", // after exit: never runs
  ].join("\n");
  const repl = await h.cli(["repl"], {}, `${script}\n`);
  expect(repl.code).toBe(0);
  expect(repl.stdout).toContain("light.desk  off");
  expect(repl.stdout).toContain("light.desk  confirmed");
  expect(repl.stdout).toContain('"state": "on 50%"');
  expect(repl.stdout).toMatch(/lock\.front_door +Front door +locked/);
  expect(repl.stdout).toMatch(/front_hall +Front Hall/);
  expect(repl.stdout).not.toContain("version");
  expect(repl.stderr).toContain("unknown command 'bogus-command'");
  expect(repl.stderr).toContain("error [not_found]: Unknown entity light.nope");
});
