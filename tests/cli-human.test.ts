// The human-facing CLI: one-shot commands and the dashboard's one-frame output.

import { afterAll, beforeAll, expect, test } from "bun:test";
import house from "./fixtures/house.ts";
import { BOOTSTRAP_TOKEN, boot, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "house"\n`,
    new Map([[house.id, house]]),
    { confirmTimeoutMs: 150 },
  );
  const admin = await h.connect();
  const kitchen = (await admin.request("create_area", { name: "Kitchen" })) as { id: string };
  const devices = (await admin.request("get_devices", {})) as { id: string; name: string }[];
  const hub = devices.find((d) => d.name === "Kitchen hub");
  await admin.request("update_device", { deviceId: hub?.id ?? "", areaId: kitchen.id });
});
afterAll(() => h.stop());

const lines = (text: string) => text.trimEnd().split("\n");

test("light set: a sent line, then the confirmed state and who confirmed it", async () => {
  const out = await h.cli(["light", "set", "light.k_ceiling", "--brightness", "40"]);
  expect(out.code).toBe(0);
  const [sent, done] = lines(out.stdout);
  expect(sent).toMatch(/^◐ light\.k_ceiling {2,}sent · waiting for device…$/);
  expect(done).toMatch(/^● light\.k_ceiling {2,}On · 40% {2,}confirmed by house in \d+\.\d s$/);

  const off = await h.cli(["light", "off", "light.k_c"]); // a unique prefix works here too
  expect(lines(off.stdout)[1]).toMatch(/^● light\.k_ceiling {2,}Off/);
  const bad = await h.cli(["light", "set", "light.k_ceiling", "--brightness", "140"]);
  expect(bad).toMatchObject({ code: 2, stdout: "" });
  expect(bad.stderr).toContain("--brightness is a percentage from 0 to 100");
});

test("a lock that jams: what happened, what to do, and exit 3", async () => {
  const out = await h.cli(["lock", "retry", "lock.side_gate"]);
  expect(out.code).toBe(3);
  const [sent, failed, why, exit] = lines(out.stdout);
  expect(sent).toMatch(/^◐ lock\.side_gate {2,}sent · waiting for device…$/);
  expect(failed).toMatch(/^▲ lock\.side_gate {2,}Jammed$/);
  expect(why).toBe(
    "  The side gate lock didn't finish turning. Check the bolt isn't blocked, then try again.",
  );
  expect(exit).toMatch(/^ {2}exit 3 · command_failed · Door controller · \d+\.\d s$/);

  const works = await h.cli(["lock", "unlock", "lock.front_door"]);
  expect(works.code).toBe(0);
  expect(lines(works.stdout)[1]).toMatch(/^● lock\.front_door {2,}Unlocked {2,}confirmed by house/);
  await h.cli(["lock", "lock", "lock.front_door"]);
});

test("a device that never confirms, a read-only one, and an unknown one", async () => {
  const silent = await h.cli(["switch", "on", "switch.k_kettle"]);
  expect(silent.code).toBe(3);
  expect(lines(silent.stdout).slice(1)).toEqual([
    expect.stringMatching(/^▲ switch\.k_kettle {2,}No confirmation$/),
    "  Kettle took the command but didn't report the change. It may be slow or out of range; check it, then try again.",
    expect.stringMatching(/^ {2}exit 3 · unconfirmed · Kitchen hub · /),
  ]);

  const readOnly = await h.cli(["switch", "on", "switch.k_dish"]);
  expect(readOnly.code).toBe(3);
  expect(lines(readOnly.stdout)[1]).toMatch(/^▲ switch\.k_dish {2,}Not supported$/);

  const unknown = await h.cli(["light", "on", "light.nope"]);
  expect(unknown).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "error [not_found]: Unknown entity light.nope\n",
  });
});

test("ls lists a room with states, level bars, and view-only notes", async () => {
  await h.cli(["light", "set", "light.k_ceiling", "--brightness", "40"]);
  const out = await h.cli(["ls", "--area", "kitchen"]);
  expect(lines(out.stdout)).toEqual([
    "NAME           ID               STATE     LEVEL",
    "Ceiling light  light.k_ceiling  On · 40%  ████░░░░░░",
    "Kettle         switch.k_kettle  Off",
    "Dishwasher     switch.k_dish    On        view only",
  ]);
  expect((await h.cli(["ls", "--area", "Kitchen", "--domain", "light"])).stdout).toContain(
    "Ceiling light",
  );
  expect((await h.cli(["ls"])).stdout).toContain("lock.front_door");
  expect(await h.cli(["ls", "--area", "attic"])).toMatchObject({
    code: 1,
    stderr: "error [not_found]: Unknown area attic\n",
  });
  const json = JSON.parse((await h.cli(["ls", "--area", "kitchen", "--json"])).stdout) as {
    id: string;
    controllable: boolean;
  }[];
  expect(json.map((e) => [e.id, e.controllable])).toEqual([
    ["light.k_ceiling", true],
    ["switch.k_kettle", true],
    ["switch.k_dish", false],
  ]);
});

test("sensors sorts by value and flags readings that need attention", async () => {
  const out = await h.cli(["sensors", "--sort", "value"]);
  expect(lines(out.stdout)).toEqual([
    "NAME         ID                  VALUE",
    "Bedroom CO2  sensor.bedroom_co2  1,140 ppm ▲ high",
    "Office CO2   sensor.office_co2   760 ppm",
  ]);
  expect(lines((await h.cli(["sensors"])).stdout)[1]).toStartWith("Bedroom CO2");
});

test("car says so when there is no vehicle", async () => {
  expect((await h.cli(["car"])).stdout).toBe(
    "No vehicles. Add the teslamate or tesla integration.\n",
  );
});

test("dash --once prints one frame: rooms on the left, thermostat and locks on the right", async () => {
  const out = await h.cli(["dash", "--once", "--width", "120"]);
  expect(out.code).toBe(0);
  const frame = lines(out.stdout);
  expect(frame.every((line) => [...line].length <= 120)).toBe(true);
  expect(frame[0]).toMatch(
    /^casita · home · Good (morning|afternoon|evening|night) +\w{3} \d{1,2} \w{3} · \d{1,2}:\d\d [ap]m$/,
  );
  expect(frame[1]).toStartWith("Locks ▲ 1 jammed   Lights 1 on   Hallway 21.5°C heat");

  const text = out.stdout;
  expect(text).toContain("┌ Kitchen · 1 light on · 2 controls ─");
  expect(text).toMatch(/│ ▸ Ceiling light +light\.k_ceiling +On · 40% +████░░░░░░ │/);
  expect(text).toMatch(/│ {3}Dishwasher +switch\.k_dish +On {2}view only +│/);
  expect(text).toContain("┌ Thermostat · Hallway ─");
  expect(text).toMatch(/21\.5°C {2}Heat · holding 21°/);
  expect(text).toMatch(/ target 21° +mode heat {2}cool {2}auto {2}off/);
  expect(text).toContain("┌ Locks · 1 unlocked ─");
  expect(text).toMatch(/Front door +● Locked +u {2}unlock/);
  expect(text).toMatch(/Side gate lock +▲ Jammed +r {2}retry/);
  expect(text).toContain("The side gate lock didn't finish turning.");
  expect(text).toContain("core connected · 1 integration ok");
  expect(frame.at(-1)).toContain(" q  quit");
});
