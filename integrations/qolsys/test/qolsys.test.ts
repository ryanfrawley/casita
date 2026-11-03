import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import { createQolsysIntegration } from "../src/index.ts";
import { FakePanel, type FakePanelOptions, TOKEN, USER_CODE } from "./fake-panel.ts";

const integration = createQolsysIntegration({
  connectTimeoutMs: 500,
  backoffBaseMs: 20,
  backoffMaxMs: 40,
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

async function setup(options: FakePanelOptions = {}, userCode = USER_CODE) {
  const panel = await FakePanel.start(options);
  const t = createTestContext(
    integration.configSchema.parse({
      host: "127.0.0.1",
      port: panel.port,
      token: TOKEN,
      userCode,
      pollSeconds: 1,
    }),
  );
  cleanups.push(() => {
    t.abort();
    panel.stop();
  });
  await integration.setup(t.ctx);
  await until(() => t.entities.size > 0, "the summary");
  return { panel, t };
}
const stateOf = (t: TestContext<unknown>, uniqueId: string) =>
  t.state(uniqueId)?.state as Record<string, unknown> | undefined;

test("builds the panel, a device per zone and three entities per partition from the summary", async () => {
  const { t } = await setup();
  expect([...t.devices.values()].map((d) => [d.uniqueId, d.name, d.model])).toEqual([
    ["panel", "IQ Panel", "IQ Panel"],
    ["zone-1", "Front Door", "Door_Window"],
    ["zone-2", "Kitchen Window", "Door_Window"],
    ["zone-3", "Hall Motion", "Motion"],
    ["zone-4", "Upstairs Smoke", "SmokeDetector"],
    ["zone-5", "Laundry Leak", "Water"],
    ["zone-6", "Living Room Glass", "GlassBreak"],
    ["zone-7", "Living Room Door", "Door_Window"],
  ]); // zone 0, a takeover module, is the panel's plumbing and gets nothing
  const panel = [...t.devices.values()][0];
  expect([...t.devices.values()].slice(1).every((d) => d.viaDeviceId === panel?.id)).toBe(true);
  expect<string[][]>([...t.entities.values()].map((e) => [e.id, e.uniqueId])).toEqual([
    ["sensor.alarm", "partition-0-status"],
    ["switch.armed_stay", "partition-0-stay"],
    ["switch.armed_away", "partition-0-away"],
    ["binary_sensor.front_door", "zone-1"],
    ["binary_sensor.kitchen_window", "zone-2"],
    ["binary_sensor.hall_motion", "zone-3"],
    ["binary_sensor.upstairs_smoke", "zone-4"],
    ["binary_sensor.laundry_leak", "zone-5"],
    ["binary_sensor.living_room_glass", "zone-6"],
    ["binary_sensor.living_room_door", "zone-7"],
  ]);
});

test("reports each zone's status with its class, and the partition as disarmed", async () => {
  const { t } = await setup();
  expect(stateOf(t, "zone-1")).toEqual({ domain: "binary_sensor", on: false, deviceClass: "door" });
  expect(stateOf(t, "zone-2")).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "window",
  });
  expect(stateOf(t, "zone-3")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "motion",
  });
  expect(stateOf(t, "zone-4")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "smoke",
  });
  expect(stateOf(t, "zone-5")).toEqual({ domain: "binary_sensor", on: false, deviceClass: "leak" });
  expect(stateOf(t, "zone-6")).toEqual({ domain: "binary_sensor", on: false });
  // A perimeter zone the installer named a door is a door.
  expect(stateOf(t, "zone-7")).toEqual({ domain: "binary_sensor", on: false, deviceClass: "door" });
  expect(t.state("zone-2")?.attributes).toEqual({
    zoneId: 2,
    type: "Door_Window",
    group: "instantperimeter_dw",
    status: "Open",
  });
  expect(stateOf(t, "partition-0-status")).toEqual({ domain: "sensor", value: "disarmed" });
  expect(stateOf(t, "partition-0-stay")).toEqual({ domain: "switch", on: false });
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: false });
});

test("zone events become state reports; a partial ZONE_ACTIVE keeps what it does not say", async () => {
  const { panel, t } = await setup();
  panel.zoneActive(1, "Open");
  await until(() => stateOf(t, "zone-1")?.on === true, "the door to open");
  expect(stateOf(t, "zone-1")).toEqual({ domain: "binary_sensor", on: true, deviceClass: "door" });
  expect(t.state("zone-1")?.attributes?.group).toBe("entryexitdelay");

  panel.zoneActive(3, "Active");
  await until(() => stateOf(t, "zone-3")?.on === true, "motion");
  panel.zoneActive(3, "Idle");
  await until(() => stateOf(t, "zone-3")?.on === false, "motion to clear");
});

test("a zone added, renamed or deleted on the panel follows in the registry", async () => {
  const { panel, t } = await setup();
  panel.zoneAdd({
    id: "001-0008",
    type: "Motion",
    name: "Garage Motion",
    group: "awayinstantmotion",
    status: "Idle",
    zone_id: 8,
    partition_id: 0,
  });
  await until(() => t.entities.size === 11, "the new zone");
  expect(t.entity("zone-8").name).toBe("Garage Motion");
  expect(stateOf(t, "zone-8")).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "motion",
  });

  panel.zoneUpdate({ zone_id: 8, name: "Workshop Motion", status: "Idle" });
  await until(() => t.entity("zone-8").name === "Workshop Motion", "the rename");
  expect<string>(t.entity("zone-8").id).toBe("binary_sensor.garage_motion"); // the id is stable
  expect(stateOf(t, "zone-8")?.deviceClass).toBe("motion"); // the type was kept

  panel.zoneDelete(8);
  await until(() => t.entities.size === 10, "the deletion");
  expect([...t.devices.values()].some((d) => d.uniqueId === "zone-8")).toBe(false);
});

test("arming switches send ARMING with the user code and read on from the exit delay", async () => {
  const { panel, t } = await setup();
  await t.command("partition-0-away", { domain: "switch", action: "turn_on" });
  await until(() => panel.actions.length === 1, "the action");
  expect(panel.actions).toEqual([
    {
      nonce: "qolsys",
      source: "C4",
      version: 1,
      action: "ARMING",
      arming_type: "ARM_AWAY",
      partition_id: 0,
      token: TOKEN,
      usercode: USER_CODE,
    },
  ]);
  await until(() => stateOf(t, "partition-0-away")?.on === true, "the exit delay");
  expect(stateOf(t, "partition-0-status")).toEqual({ domain: "sensor", value: "arming" });
  expect(t.state("partition-0-status")?.attributes?.status).toBe("ARM-AWAY-EXIT-DELAY");
  expect(stateOf(t, "partition-0-stay")).toEqual({ domain: "switch", on: false });

  panel.arming("ARM_AWAY");
  await until(() => stateOf(t, "partition-0-status")?.value === "armed_away", "armed");
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: true });

  // Turning the other switch off disarms too: either switch off means "disarm".
  await t.command("partition-0-stay", { domain: "switch", action: "turn_off" });
  await until(() => panel.actions.length === 2, "the disarm");
  expect(panel.actions.at(-1)?.arming_type).toBe("DISARM");
  await until(() => stateOf(t, "partition-0-status")?.value === "disarmed", "disarmed");
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: false });
});

test("toggle arms when the mode is off and disarms when it is on", async () => {
  const { panel, t } = await setup();
  await t.command("partition-0-stay", { domain: "switch", action: "toggle" });
  await until(() => panel.actions.length === 1, "the action");
  expect(panel.actions.at(-1)?.arming_type).toBe("ARM_STAY");
  await until(() => stateOf(t, "partition-0-stay")?.on === true, "arming");
  await t.command("partition-0-stay", { domain: "switch", action: "toggle" });
  await until(() => panel.actions.length === 2, "the disarm");
  expect(panel.actions.at(-1)?.arming_type).toBe("DISARM");
});

test("an unnamed exit delay from old firmware is attributed to the mode asked for", async () => {
  const { t } = await setup({ oldFirmware: true });
  await t.command("partition-0-stay", { domain: "switch", action: "turn_on" });
  await until(() => stateOf(t, "partition-0-stay")?.on === true, "the exit delay");
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: false });
  expect(stateOf(t, "partition-0-status")).toEqual({ domain: "sensor", value: "arming" });
});

test("a wrong user code is refused by the panel and logged; nothing changes", async () => {
  const { panel, t } = await setup({}, "000000");
  await t.command("partition-0-away", { domain: "switch", action: "turn_on" });
  await until(() => t.logs.some((l) => l.msg === "the panel refused a request"), "the warning");
  expect(t.logs.find((l) => l.msg === "the panel refused a request")?.data).toEqual({
    type: "usercode",
    description: "Invalid usercode",
  });
  expect(panel.actions).toHaveLength(1);
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: false });
  expect(stateOf(t, "partition-0-status")).toEqual({ domain: "sensor", value: "disarmed" });
});

test("an alarm and an entry delay show on the status sensor", async () => {
  const { panel, t } = await setup();
  panel.arming("ARM_AWAY");
  await until(() => stateOf(t, "partition-0-status")?.value === "armed_away", "armed");
  panel.arming("ENTRY_DELAY");
  await until(() => stateOf(t, "partition-0-status")?.value === "entry_delay", "entry delay");
  // The switches keep saying armed: the panel is, until it is disarmed or goes off.
  expect(stateOf(t, "partition-0-away")).toEqual({ domain: "switch", on: false });
  panel.alarm("POLICE");
  await until(() => stateOf(t, "partition-0-status")?.value === "alarm", "alarm");
  expect(t.state("partition-0-status")?.attributes).toEqual({
    partitionId: 0,
    status: "ALARM",
    alarmType: "POLICE",
  });
  panel.arming("DISARM");
  await until(() => stateOf(t, "partition-0-status")?.value === "disarmed", "disarmed");
});

test("the summary is polled, so a zone deleted while away disappears", async () => {
  const { panel, t } = await setup();
  const list = (panel as unknown as { summary: { partition_list: { zone_list: unknown[] }[] } })
    .summary.partition_list[0];
  list?.zone_list.pop();
  await until(() => t.entities.size === 9, "the poll to drop zone 7");
});

test("losing the panel marks everything unavailable; it comes back on reconnect", async () => {
  const { panel, t } = await setup();
  panel.stop();
  await until(() => t.state("zone-1")?.available === false, "unavailable");
  expect(t.state("partition-0-status")?.available).toBe(false);
  expect(t.state("partition-0-away")?.available).toBe(false);

  panel.listen();
  await until(() => t.state("zone-1")?.available === true, "reconnect");
  expect(t.logs.some((l) => l.msg === "panel connection restored")).toBe(true);
});

test("setup rejects when the panel cannot be reached", async () => {
  const t = createTestContext(
    integration.configSchema.parse({
      host: "127.0.0.1",
      port: 1,
      token: TOKEN,
      userCode: USER_CODE,
    }),
  );
  cleanups.push(() => t.abort());
  await expect(integration.setup(t.ctx)).rejects.toThrow(/cannot connect|timed out/);
});

test("abort closes the connection and stops reconnecting", async () => {
  const { panel, t } = await setup();
  t.abort();
  await until(() => panel.connections === 0, "the socket to close");
  await Bun.sleep(100);
  expect(panel.connections).toBe(0);
});

test("the config needs a host, a token and a numeric user code", () => {
  const schema = integration.configSchema;
  expect(schema.safeParse({ host: "10.0.0.5", token: "abc", userCode: "1234" }).success).toBe(true);
  expect(schema.safeParse({ host: "10.0.0.5", token: "abc", userCode: "12ab" }).success).toBe(
    false,
  );
  expect(schema.safeParse({ host: "10.0.0.5", userCode: "123456" }).success).toBe(false);
  expect(schema.parse({ host: "h", token: "t", userCode: "123456" }).port).toBe(12345);
});
