// Automations end to end: one is created from the API, fires against the real house as
// itself, can be switched off and deleted, and only an admin may touch it.

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

// Mirrors the lock: whenever the front door unlocks, the desk light turns on.
const welcome = (brightness: string) => `automation Welcome {
  on lock.front_door changed to .Unlocked {
    call light.desk.turn_on { brightness: ${brightness} }
  }
}
`;

const unlock = async () => {
  await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "lock" },
  });
  await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "unlock" },
  });
};

test("an automation is created, listed with its status, and fires as itself", async () => {
  expect(await client.request("get_automations", {})).toEqual([]);
  const saved = (await client.request("save_automation", {
    automationId: "welcome",
    source: welcome("30%"),
  })) as Row;
  expect(saved.ok).toBe(true);
  expect(saved.automation).toMatchObject({ id: "welcome", name: "Welcome", handlers: 1 });
  expect(await client.request("get_automations", {})).toMatchObject([
    { id: "welcome", kind: "automation", name: "Welcome", enabled: true, status: "running" },
  ]);

  const seen = record(client);
  await client.request("subscribe", {
    events: ["state_changed", "command_issued"],
    entityIds: ["light.desk"],
  });
  await seen.until(() => seen.snapshots.length === 1);
  await unlock();
  await seen.until(() =>
    seen.events.some(
      (e) => e.type === "state_changed" && ((e.new as Row).state as Row).brightness === 0.3,
    ),
  );
  expect(seen.events.find((e) => e.type === "command_issued")).toMatchObject({
    source: { kind: "automation", automationId: "automation:welcome" },
    command: { domain: "light", action: "turn_on", brightness: 0.3 },
  });

  const runs = (await client.request("get_automation_runs", { automationId: "welcome" })) as Row[];
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    line: 2,
    trigger: "lock.front_door changed",
    calls: [{ entityId: "light.desk", command: { domain: "light", action: "turn_on" } }],
  });
  expect((await client.request("get_automations", {})) as Row[]).toMatchObject([
    { lastRunAt: runs[0]?.at },
  ]);
});

test("a save that does not compile stores nothing; a save replaces the handlers", async () => {
  const bad = (await client.request("save_automation", {
    automationId: "welcome",
    source: welcome("30%").replace("light.desk", "light.nowhere"),
  })) as Row;
  expect(bad.ok).toBe(false);
  expect((bad.diagnostics as Row[])[0]?.code).toBe("E010");
  expect(await codeOf(client.request("get_automation_source", { automationId: "welcome" }))).toBe(
    "not_found",
  );
  expect(
    await codeOf(client.request("save_automation", { automationId: "Welcome", source: "" })),
  ).toBe("invalid");

  expect(
    (
      (await client.request("save_automation", {
        automationId: "welcome",
        source: welcome("30%"),
      })) as Row
    ).ok,
  ).toBe(true);
  expect(
    (
      (await client.request("save_automation", {
        automationId: "welcome",
        source: welcome("80%"),
      })) as Row
    ).ok,
  ).toBe(true);
  const source = (await client.request("get_automation_source", {
    automationId: "welcome",
  })) as Row;
  expect(source.source).toContain("80%");
  expect((source.versions as Row[]).map((v) => v.version)).toEqual([2, 1]);

  const seen = record(client);
  await client.request("subscribe", {
    events: ["state_changed", "command_issued"],
    entityIds: ["light.desk"],
  });
  await seen.until(() => seen.snapshots.length === 1);
  await unlock();
  await seen.until(() =>
    seen.events.some(
      (e) => e.type === "state_changed" && ((e.new as Row).state as Row).brightness === 0.8,
    ),
  );
  // Only the new handler fired.
  expect(
    seen.events.filter((e) => e.type === "command_issued" && (e.command as Row).domain === "light"),
  ).toHaveLength(1);

  const reverted = (await client.request("revert_automation", {
    automationId: "welcome",
    version: 1,
  })) as Row;
  expect(reverted.ok).toBe(true);
  expect(
    ((await client.request("get_automation_source", { automationId: "welcome" })) as Row).source,
  ).toContain("30%");
});

test("switching an automation off stops it, on arms it again, and delete removes it", async () => {
  await client.request("save_automation", { automationId: "welcome", source: welcome("30%") });
  const seen = record(client);
  await client.request("subscribe", { events: ["command_issued", "automation_status"] });
  await seen.until(() => seen.snapshots.length === 1);

  const off = (await client.request("set_automation_enabled", {
    automationId: "welcome",
    enabled: false,
  })) as Row;
  expect(off).toMatchObject({ id: "welcome", enabled: false, status: "stopped" });
  await unlock();
  await Bun.sleep(50);
  expect(
    seen.events.filter((e) => e.type === "command_issued" && (e.command as Row).domain === "light"),
  ).toEqual([]);

  const on = (await client.request("set_automation_enabled", {
    automationId: "welcome",
    enabled: true,
  })) as Row;
  expect(on).toMatchObject({ enabled: true, status: "running" });
  seen.events.length = 0;
  await unlock();
  await seen.until(() =>
    seen.events.some((e) => e.type === "command_issued" && (e.command as Row).domain === "light"),
  );

  expect(await client.request("delete_automation", { automationId: "welcome" })).toEqual({
    ok: true,
  });
  expect(await client.request("get_automations", {})).toEqual([]);
  expect(await codeOf(client.request("get_automation_runs", { automationId: "welcome" }))).toBe(
    "not_found",
  );
  expect(await codeOf(client.request("delete_automation", { automationId: "welcome" }))).toBe(
    "not_found",
  );
  // A restart finds nothing to arm.
  await h.restart();
  client = await h.connect();
  expect(await client.request("get_automations", {})).toEqual([]);
});

test("an automation survives a restart and a page with handlers is listed beside it", async () => {
  await client.request("save_automation", { automationId: "welcome", source: welcome("30%") });
  await client.request("save_page", {
    pageId: "home",
    source: "page Home {\n  Card { }\n  at 23:00 { call light.desk.turn_off }\n}\n",
  });
  await h.restart();
  client = await h.connect();
  expect(await client.request("get_automations", {})).toMatchObject([
    { id: "welcome", kind: "automation", status: "running" },
    { id: "home", kind: "page", name: "Home", handlers: 1, status: "running" },
  ]);
});

test("a member sees the list without its errors and may change nothing", async () => {
  await client.request("save_automation", { automationId: "welcome", source: welcome("30%") });
  // Creating the first admin retires the bootstrap token, so continue as that admin.
  const root = await addUser(h, client, "root", "admin");
  const admin = await h.connect(root.token);
  const { token } = await addUser(h, admin, "pat", "member");
  const member = await h.connect(token);
  expect(await member.request("get_automations", {})).toMatchObject([{ id: "welcome" }]);
  for (const [type, params] of [
    ["get_automation_source", { automationId: "welcome" }],
    ["save_automation", { automationId: "welcome", source: "" }],
    ["set_automation_enabled", { automationId: "welcome", enabled: false }],
    ["delete_automation", { automationId: "welcome" }],
    ["get_automation_runs", { automationId: "welcome" }],
    ["test_automation", { automationId: "welcome" }],
  ] as const) {
    expect(await codeOf(member.request(type as "ping", params as never)), type).toBe("forbidden");
  }
});

// Lights the desk only while the door is unlocked: a test of it reads the door, or a pretend one.
const guarded = `automation Guarded {
  every 1h {
    if lock.front_door.value == .Unlocked { call light.desk.turn_on }
  }
  on lock.front_door changed { call light.desk.turn_off }
}
`;

test("a test runs one handler now, as the automation, enabled or not, and is audited", async () => {
  await client.request("save_automation", { automationId: "welcome", source: welcome("30%") });
  await client.request("set_automation_enabled", { automationId: "welcome", enabled: false });
  const run = (await client.request("test_automation", { automationId: "welcome" })) as Row;
  expect(run).toMatchObject({
    line: 2,
    trigger: "test",
    calls: [{ entityId: "light.desk", command: { domain: "light", action: "turn_on" } }],
  });
  const runs = (await client.request("get_automation_runs", { automationId: "welcome" })) as Row[];
  expect(runs).toEqual([run]);
  // Still switched off.
  expect(await client.request("get_automations", {})).toMatchObject([
    { id: "welcome", enabled: false, status: "stopped" },
  ]);
  const audit = (await client.request("get_audit", {})) as Row[];
  expect(audit.find((a) => a.action === "automation_tested")).toMatchObject({
    target: "welcome",
  });
});

test("a test reads the house as it is, or as pretended", async () => {
  await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "lock" },
  });
  await client.request("save_automation", { automationId: "guarded", source: guarded });
  const plain = (await client.request("test_automation", {
    automationId: "guarded",
    line: 2,
  })) as Row;
  expect(plain).toMatchObject({ line: 2, trigger: "test", calls: [] });

  const pretended = (await client.request("test_automation", {
    automationId: "guarded",
    line: 2,
    pretend: { "lock.front_door": "Unlocked" },
  })) as Row;
  expect(pretended).toMatchObject({
    trigger: 'test, pretending lock.front_door = "Unlocked"',
    calls: [{ entityId: "light.desk", command: { domain: "light", action: "turn_on" } }],
  });
  // The pretend did not touch the lock.
  const states = (await client.request("get_states", {})) as Row[];
  const lock = states.find((r) => r.entityId === "lock.front_door");
  expect(lock).toMatchObject({ state: { locked: true } });
});

test("a test of an unknown automation is not found; one the runtime refuses is invalid", async () => {
  expect(await codeOf(client.request("test_automation", { automationId: "nope" }))).toBe(
    "not_found",
  );
  await client.request("save_automation", { automationId: "guarded", source: guarded });
  // Two handlers and no line.
  await expect(
    client.request("test_automation", { automationId: "guarded" }),
  ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("line 2, line 5") });
  expect(
    await codeOf(client.request("test_automation", { automationId: "guarded", line: 3 })),
  ).toBe("invalid");
});

test("`automation test` prints the run, and --pretend reaches the handler", async () => {
  await client.request("send_command", {
    entityId: "lock.front_door",
    command: { domain: "lock", action: "lock" },
  });
  await client.request("save_automation", { automationId: "guarded", source: guarded });
  const out = await h.cli([
    "automation",
    "test",
    "guarded",
    "--line",
    "2",
    "--pretend",
    "lock.front_door=Unlocked",
    "--json",
  ]);
  expect(out.stderr).toBe("");
  expect(JSON.parse(out.stdout)).toMatchObject({
    trigger: 'test, pretending lock.front_door = "Unlocked"',
    calls: [{ entityId: "light.desk" }],
  });
  const table = await h.cli(["automation", "test", "guarded", "--line", "2"]);
  expect(table.code).toBe(0);
  expect(table.stdout).toContain("TRIGGER");
  expect(table.stdout).toMatch(/\btest\b/);
});
