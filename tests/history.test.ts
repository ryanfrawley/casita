import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, codeOf, type Harness } from "./harness.ts";

type Row = Record<string, unknown>;
let h: Harness;
let admin: CasitaClient;
beforeEach(async () => {
  h = await boot();
  admin = await h.connect();
});
afterEach(() => h.stop());

const toggle = async (times: number) => {
  for (let i = 0; i < times; i++) {
    await admin.request("send_command", {
      entityId: "light.desk",
      command: { domain: "light", action: i % 2 ? "turn_off" : "turn_on" },
      confirm: true,
    });
  }
};
const history = (client: CasitaClient, entityId = "light.desk", extra: Row = {}) =>
  client.request("get_history", {
    entityId,
    from: Date.now() - 60_000,
    to: Date.now() + 1000,
    ...extra,
  }) as Promise<{
    resolution: string;
    records: Row[];
  }>;

test("get_history returns recorded states oldest first, including ones not yet flushed", async () => {
  await toggle(3);
  const result = await history(admin);
  expect(result.resolution).toBe("raw");
  // The initial report, then three changes.
  expect(result.records.map((r) => (r.state as Row).on)).toEqual([false, true, false, true]);
  expect(result.records[0]).toMatchObject({
    entityId: "light.desk",
    available: true,
    attributes: { label: "" },
  });
  expect((await history(admin, "light.desk", { limit: 2 })).records).toHaveLength(2);
  expect(await codeOf(history(admin, "light.nope"))).toBe("not_found");
  expect(await codeOf(history(admin, "light.desk", { limit: 10_001 }))).toBe("bad_request");
});

test("history survives a restart", async () => {
  await toggle(1);
  await h.restart();
  admin = await h.connect();
  const result = await history(admin);
  // Shutdown marked it unavailable; startup reported it again.
  expect(result.records.map((r) => [(r.state as Row).on, r.available])).toEqual([
    [false, true],
    [true, true],
    [true, false],
    [false, true],
  ]);
});

test("a guest cannot read history of an entity they cannot see, over WebSocket or CSV", async () => {
  await toggle(1);
  const root = await addUser(h, admin, "root", "admin");
  admin = await h.connect(root.token);
  const gus = await addUser(h, admin, "gus", "guest");
  const guest = await h.connect(gus.token);
  expect(await codeOf(history(guest))).toBe("not_found");
  const csv = (token: string) =>
    fetch(`${h.url}/api/history.csv?entityId=light.desk`, {
      headers: { authorization: `Bearer ${token}` },
    });
  expect((await csv(gus.token)).status).toBe(404);

  await admin.request("set_grant", {
    subjectKind: "user",
    subjectId: gus.id,
    scopeKind: "entity",
    scopeId: "light.desk",
    level: "read",
  });
  expect((await history(guest)).records.length).toBeGreaterThan(0);
  expect((await csv(gus.token)).status).toBe(200);
  expect((await fetch(`${h.url}/api/history.csv?entityId=light.desk`)).status).toBe(401);
});

test("history.csv streams one line per record", async () => {
  await toggle(2);
  const response = await fetch(`${h.url}/api/history.csv?entityId=light.desk&from=0`, {
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  const lines = (await response.text()).trim().split("\n");
  expect(lines[0]).toBe("time,entity_id,available,state,attributes");
  expect(lines).toHaveLength(4);
  expect(lines[2]).toMatch(
    /^\d{4}-.+Z,light\.desk,true,"\{""domain"":""light"",""on"":true,""brightness"":1\}","\{""label"":""""\}"$/,
  );
});

test("an entity's retention is settable, and get_entities reports the effective policy", async () => {
  const policyOf = async (id: string) =>
    ((await admin.request("get_entities", {})) as Row[]).find((e) => e.id === id)
      ?.effectiveRetention;
  expect(await policyOf("light.desk")).toEqual({ raw: 30 });
  await admin.request("set_config", { path: "server.history.domains.light", value: { raw: 14 } });
  expect(await policyOf("light.desk")).toEqual({ raw: 14 });
  await admin.request("update_entity", {
    entityId: "light.desk",
    retention: { raw: 7, minute: 90, hour: 730 },
  });
  expect(await policyOf("light.desk")).toEqual({ raw: 7, minute: 90, hour: 730 });
  expect(await policyOf("lock.front_door")).toEqual({ raw: 30 });

  // Beyond the raw window the finest remaining tier answers, and says which it is.
  const old = await admin.request("get_history", {
    entityId: "light.desk",
    from: Date.now() - 30 * 86_400_000,
    to: Date.now(),
  });
  expect(old).toEqual({ resolution: "minute", records: [] });

  await admin.request("update_entity", { entityId: "light.desk", retention: null });
  expect(await policyOf("light.desk")).toEqual({ raw: 14 });
  const bad = admin.request("update_entity", {
    entityId: "light.desk",
    retention: { raw: 0 } as never,
  });
  expect(await codeOf(bad)).toBe("bad_request");
});

test("cli: history as a table, as CSV, and at a resolution that falls back; backup", async () => {
  await toggle(1);
  const table = await h.cli(["history", "light.de"]);
  expect(table.code).toBe(0);
  expect(table.stdout.split("\n")[0]).toMatch(/^TIME +STATE +DETAIL$/);
  expect(table.stdout).toContain("on 100%");

  const csv = await h.cli(["history", "light.desk", "--csv", "--from", "1h"]);
  expect(csv.stdout.split("\n")[0]).toBe("time,state,detail");
  expect(csv.stdout.split("\n")[2]).toMatch(/^"\d{4}-.+Z","on 100%","\{""domain""/);

  const hourly = await h.cli(["history", "light.desk", "--resolution", "hour"]);
  expect(hourly.stderr).toContain("Showing raw history: hour is no longer kept that far back.");

  const backup = await h.cli(["backup"]);
  expect(backup.stdout).toMatch(/^Backup written to .+backup-\d{4}-\d\d-\d\d\.db\n$/);
  expect((await readdir(h.dir)).filter((f) => f.startsWith("backup-"))).toHaveLength(1);
});
