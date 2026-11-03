// The Z-Wave JS integration against a fake zwave-js-server speaking the WebSocket protocol.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createZwaveIntegration } from "../integrations/zwave-js/src/index.ts";
import { FakeZwaveServer } from "../integrations/zwave-js/test/fake-server.ts";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { BOOTSTRAP_TOKEN, boot, codeOf, type Harness } from "./harness.ts";

type Row = Record<string, unknown>;
const integration = createZwaveIntegration({
  connectTimeoutMs: 500,
  backoffBaseMs: 30,
  backoffMaxMs: 60,
});

let server: FakeZwaveServer;
let h: Harness;
let client: CasitaClient;

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await Bun.sleep(10);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

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

beforeEach(async () => {
  server = await FakeZwaveServer.start();
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "zwave-js"\nserverUrl = "${server.url}"\n`,
    new Map([[integration.id, integration]]),
  );
  client = await h.connect();
});
afterEach(async () => {
  await h.stop();
  server.stop();
});

test("discover from the node dump, observe a value update, control with confirmation", async () => {
  expect(((await client.request("get_entities", {})) as Row[]).length).toBe(18);
  expect(await settled("lock.front_door", (r) => r.available === true)).toMatchObject({
    state: { locked: true },
  });
  expect(await settled("switch.dead_plug", () => true)).toMatchObject({ available: false });

  server.valueUpdated(6, { commandClass: 49, property: "Air temperature" }, 21);
  await settled("climate.hallway_thermostat", (r) => (r.state as Row).currentTemp === 21);

  const unlock = await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "unlock" },
    confirm: true,
  });
  expect(unlock).toMatchObject({ status: "confirmed" });
  const dim = await h.cli([
    "cmd",
    "light.inovelli_lzw31",
    "turn_on",
    "--brightness",
    "0.5",
    "--confirm",
  ]);
  expect(dim).toMatchObject({ code: 0, stderr: "" });
  // The thermostat clamps and snaps the target to its range before it is sent.
  const target = await client.request("send_command", {
    entityId: "climate.hallway_thermostat",
    command: { domain: "climate", action: "set_target", temp: 99.2 },
    confirm: true,
  });
  expect(target).toMatchObject({ status: "confirmed", command: { temp: 30 } });
  expect(server.commands.map((c) => c.value)).toEqual([0, 50, 30]);

  const dead = client.request("send_command", {
    entityId: "switch.dead_plug",
    command: { domain: "switch", action: "turn_off" },
  });
  expect(await codeOf(dead)).toBe("unavailable");
});

test("inclusion runs as an integration action; losing the server marks entities unavailable", async () => {
  const [info] = (await client.request("get_integrations", {})) as { actions: Row[] }[];
  expect(info?.actions.map((a) => a.name)).toEqual([
    "start_inclusion",
    "stop_inclusion",
    "start_exclusion",
    "stop_exclusion",
    "heal_network",
    "stop_heal_network",
    "provision_qr",
    "list_provisioned",
    "unprovision",
    "remove_failed_node",
    "get_config_parameter",
    "set_config_parameter",
    "led_effects",
    "led_notify",
  ]);
  // The action answers the S2 prompts itself and returns once the node is added.
  const cli = h.cli([
    "integration",
    "action",
    "zwave-js.main",
    "start_inclusion",
    "--pin",
    "12345",
  ]);
  await until(() => server.commands.length === 1, "begin_inclusion");
  expect(server.commands).toEqual([
    { command: "controller.begin_inclusion", options: { strategy: 0 } },
  ]);
  server.askSecurityClasses([0, 1, 2]);
  server.askPin();
  await until(() => server.commands.length === 3, "the S2 answers");
  expect(server.commands.slice(1)).toEqual([
    {
      command: "controller.grant_security_classes",
      inclusionGrant: { securityClasses: [0, 1, 2], clientSideAuth: false },
    },
    { command: "controller.validate_dsk_and_enter_pin", pin: "12345" },
  ]);
  server.nodeAdded(11, 2);
  const result = await cli;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ nodeId: 11, securityClass: "S2 Access Control" });

  server.stop();
  await settled("lock.front_door", (r) => r.available === false);
  server.listen();
  await settled("lock.front_door", (r) => r.available === true);
});
