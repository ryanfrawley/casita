// The system-wide unit setting: stored and raw readings stay as reported; people see them in
// metric or imperial.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { addUser, boot, codeOf, type Harness, record } from "./harness.ts";

type Row = Record<string, unknown>;

let h: Harness;
let admin: CasitaClient;
let porch: string;
beforeEach(async () => {
  h = await boot();
  admin = await h.connect();
  const entities = (await admin.request("get_entities", { domain: "sensor" })) as Row[];
  porch = String(entities.find((e) => e.name === "Porch temperature")?.id);
});
afterEach(() => h.stop());

const toImperial = () => admin.request("set_config", { path: "server.units", value: "imperial" });

/** A member, plus an admin to act as: creating the first admin retires the bootstrap token. */
async function withMember() {
  const root = await addUser(h, admin, "root", "admin");
  admin = await h.connect(root.token);
  return h.connect((await addUser(h, admin, "mel", "member")).token);
}

test("the unit system is metric unless set", async () => {
  expect(admin.units).toBe("metric");
  expect(await admin.request("get_status", {})).toMatchObject({ units: "metric" });
  const status = await h.cli(["status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toMatch(/^units {5}metric$/m);
  expect((await h.cli(["sensors"])).stdout).toContain("20 °C");
});

test("set to imperial, it is reported on connect, in get_status, and written to the config file", async () => {
  await toImperial();
  expect(await admin.request("get_status", {})).toMatchObject({ units: "imperial" });
  expect((await h.connect()).units).toBe("imperial");
  expect(await Bun.file(h.configPath).text()).toContain('units = "imperial"');
});

test("config set through the CLI switches what status, sensors, ls, and state show", async () => {
  const set = await h.cli(["config", "set", "server.units", "imperial"]);
  expect(set.code).toBe(0);
  expect((await h.cli(["status"])).stdout).toMatch(/^units {5}imperial$/m);

  const sensors = await h.cli(["sensors"]);
  expect(sensors.stdout).toContain("68 °F");
  expect(sensors.stdout).not.toContain("°C");

  const ls = await h.cli(["ls"]);
  expect(ls.stdout).toMatch(/Porch temperature +\S+ +68 °F/);

  const state = await h.cli(["state", porch]);
  expect(state.stdout.split("\n")[0]).toBe(`${porch}  68 °F`);
  // The raw state line is the record as stored.
  expect(state.stdout).toContain('"value":20,"unit":"°C"');
});

test("--json output stays raw in imperial", async () => {
  await toImperial();
  const status = JSON.parse((await h.cli(["status", "--json"])).stdout) as Row;
  expect(status.units).toBe("imperial");

  const fromState = JSON.parse((await h.cli(["state", porch, "--json"])).stdout) as Row;
  expect(fromState.state).toMatchObject({ value: 20, unit: "°C" });

  for (const command of ["sensors", "ls"]) {
    const rows = JSON.parse((await h.cli([command, "--json"])).stdout) as Row[];
    expect(rows.find((r) => r.id === porch)).toMatchObject({
      state: { state: { value: 20, unit: "°C" } },
    });
  }
});

test("stored state and history are not converted", async () => {
  await toImperial();
  await admin.request("integration_action", {
    integrationId: "fixture.main",
    action: "set_temperature",
    params: { value: 25 },
  });
  const [stored] = (await admin.request("get_states", { entityIds: [porch] })) as Row[];
  expect(stored?.state).toMatchObject({ value: 25, unit: "°C" });
  const history = JSON.parse((await h.cli(["history", porch, "--json"])).stdout) as unknown;
  expect(JSON.stringify(history)).toContain('"value":25');
  expect(JSON.stringify(history)).not.toContain("°F");
});

test("anything but metric or imperial is refused, and the setting is left as it was", async () => {
  for (const value of ["Imperial", "us", "", 1, true, ["imperial"]]) {
    expect(await codeOf(admin.request("set_config", { path: "server.units", value }))).toBe(
      "invalid",
    );
  }
  expect(await admin.request("get_status", {})).toMatchObject({ units: "metric" });

  const cli = await h.cli(["config", "set", "server.units", "kelvin"]);
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain("error [invalid]");
});

test("removing the setting returns to metric", async () => {
  await toImperial();
  await admin.request("set_config", { path: "server.units", value: null });
  expect(await admin.request("get_status", {})).toMatchObject({ units: "metric" });
  expect((await h.cli(["sensors"])).stdout).toContain("20 °C");
});

test("the setting survives a restart", async () => {
  await toImperial();
  await h.restart();
  expect((await h.connect()).units).toBe("imperial");
});

test("a member hears config_changed for the unit system, but not for other settings", async () => {
  const member = await withMember();
  expect(member.units).toBe("metric");
  expect(await member.request("get_status", {})).toMatchObject({ units: "metric" });
  const seen = record(member);
  await member.request("subscribe", { events: ["config_changed"] });

  await admin.request("set_config", { path: "server.timezone", value: "America/New_York" });
  await toImperial();
  await seen.until(() => seen.events.length > 0);
  expect(seen.events).toEqual([{ type: "config_changed", path: "server.units" }]);
  expect(await member.request("get_status", {})).toMatchObject({ units: "imperial" });
});

test("an admin still hears config_changed for every path", async () => {
  const seen = record(admin);
  await admin.request("subscribe", { events: ["config_changed"] });
  await admin.request("set_config", { path: "server.timezone", value: "America/New_York" });
  await toImperial();
  await seen.until(() => seen.events.length === 2);
  expect(seen.events.map((e) => (e as Row).path)).toEqual(["server.timezone", "server.units"]);
});

test("a member cannot change the unit system", async () => {
  const member = await withMember();
  expect(
    await codeOf(member.request("set_config", { path: "server.units", value: "imperial" })),
  ).toBe("forbidden");
});

// The REPL's one connection keeps the units it had at auth_ok; nothing calls setUnits again.
// Observed: sensors still reads "20 °C" after the change; expected "68 °F".
test("in the REPL, changing the unit system applies to the commands that follow", async () => {
  const out = await h.cli(["repl"], {}, "config set server.units imperial\nsensors\n");
  expect(out.stdout).toContain("68 °F");
});

// The event's path is "server", which members are not sent (nor does the dashboard re-read on it).
// Observed: a member gets no config_changed; expected one, since the units changed.
test("a member hears about a unit change made by setting the whole server block", async () => {
  const member = await withMember();
  const seen = record(member);
  await member.request("subscribe", { events: ["config_changed"] });
  const server = (await admin.request("get_config", { path: "server" })) as { value: Row };
  await admin.request("set_config", {
    path: "server",
    value: { ...server.value, units: "imperial" },
  });
  await seen.until(() => seen.events.length > 0);
});
