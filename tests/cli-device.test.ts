// `casita device set`: finding a device by id or name, renaming it, and moving it between areas.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import garden from "./fixtures/garden.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, type Harness } from "./harness.ts";

type Device = { id: string; name: string; areaId?: string; icon?: string; card?: unknown };
type Entity = { id: string; areaId?: string; effectiveAreaId?: string };

let h: Harness;
let admin: CasitaClient;
let patio: string;
beforeEach(async () => {
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "garden"\n`,
    new Map([[garden.id, garden]]),
  );
  admin = await h.connect();
  patio = ((await admin.request("create_area", { name: "Patio" })) as { id: string }).id;
});
afterEach(() => h.stop());

const devices = async () => (await admin.request("get_devices", {})) as Device[];
const device = async (name: string) => {
  const found = (await devices()).find((d) => d.name === name);
  if (!found) throw new Error(`No device named ${name}`);
  return found;
};
const movedTo = (name: string, area: string) =>
  `${name} is now in ${area}; its entities follow unless they have an area of their own\n`;

test("device set --area moves a device found by its full id", async () => {
  const pump = await device("Pond pump");
  const out = await h.cli(["device", "set", pump.id, "--area", patio]);
  expect(out).toMatchObject({ code: 0, stderr: "", stdout: movedTo("Pond pump", patio) });
  expect((await device("Pond pump")).areaId).toBe(patio);
});

test("device set finds a device by its exact name, ignoring case", async () => {
  expect(await h.cli(["device", "set", "Pond pump", "--area", patio])).toMatchObject({
    code: 0,
    stdout: movedTo("Pond pump", patio),
  });
  await admin.request("update_device", { deviceId: (await device("Lamp post")).id, areaId: null });
  expect(await h.cli(["device", "set", "LAMP POST", "--area", patio])).toMatchObject({
    code: 0,
    stdout: movedTo("Lamp post", patio),
  });
});

test("device set takes a unique prefix of a name or of an id", async () => {
  expect((await h.cli(["device", "set", "pon", "--area", patio])).stdout).toBe(
    movedTo("Pond pump", patio),
  );

  // An id is a slug of the name the device was discovered with.
  expect((await device("Lamp post")).id).toBe("lamp_post");
  expect((await h.cli(["device", "set", "lamp_p", "--area", patio])).stdout).toBe(
    movedTo("Lamp post", patio),
  );
});

test("an exact name wins over another device whose name starts with it", async () => {
  // "lamp" is also a prefix of "Lamp post", but it is exactly the name of "Lamp".
  const out = await h.cli(["device", "set", "lamp", "--area", patio]);
  expect(out).toMatchObject({ code: 0, stdout: movedTo("Lamp", patio) });
  expect((await device("Lamp")).areaId).toBe(patio);
  expect((await device("Lamp post")).areaId).toBeUndefined();
});

test("a prefix that fits more than one device is a usage error that lists them", async () => {
  const listed = (await devices())
    .filter((d) => d.name.startsWith("Lamp"))
    .map((d) => `${d.name} (${d.id})`)
    .join(", ");
  const out = await h.cli(["device", "set", "lam", "--area", patio]);
  expect(out).toMatchObject({ code: 2, stdout: "", stderr: `"lam" is ambiguous: ${listed}\n` });
  expect((await devices()).every((d) => d.areaId === undefined)).toBe(true);

  // "l" starts the ids `lamp` and `lamp_post`.
  const byId = await h.cli(["device", "set", "l", "--area", patio]);
  expect(byId.code).toBe(2);
  expect(byId.stderr).toStartWith('"l" is ambiguous: ');
  expect(byId.stderr.split("), ")).toHaveLength(2);
});

test("an unknown device is not_found with exit 1", async () => {
  expect(await h.cli(["device", "set", "shed", "--area", patio])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "error [not_found]: Unknown device shed\n",
  });
});

test("an unknown area comes back from the server as not_found with exit 1", async () => {
  expect(await h.cli(["device", "set", "Pond pump", "--area", "attic"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "error [not_found]: Unknown area attic\n",
  });
  expect((await device("Pond pump")).areaId).toBeUndefined();
});

test("an empty --area is refused with a clear error, not an internal one", async () => {
  const out = await h.cli(["device", "set", "Pond pump", "--area", ""]);
  expect(out.code).toBeGreaterThan(0);
  expect(out.stderr).not.toContain("[internal]");
  expect((await device("Pond pump")).areaId).toBeUndefined();
});

test("--area none takes a device out of its area", async () => {
  const pump = await device("Pond pump");
  await admin.request("update_device", { deviceId: pump.id, areaId: patio });
  expect(await h.cli(["device", "set", "Pond pump", "--area", "none"])).toMatchObject({
    code: 0,
    stdout: "Pond pump is no longer in an area\n",
  });
  expect((await device("Pond pump")).areaId).toBeUndefined();
});

test("--name renames a device and leaves its area alone", async () => {
  const pump = await device("Pond pump");
  await admin.request("update_device", { deviceId: pump.id, areaId: patio });
  expect(await h.cli(["device", "set", "pond", "--name", "Fountain"])).toMatchObject({
    code: 0,
    stdout: "Renamed Pond pump to Fountain\n",
  });
  expect(await device("Fountain")).toMatchObject({ id: pump.id, areaId: patio });
});

test("--name and --area together rename and move in one go, naming the device by its new name", async () => {
  const out = await h.cli(["device", "set", "Pond pump", "--name", "Fountain", "--area", patio]);
  expect(out).toMatchObject({
    code: 0,
    stdout: `Renamed Pond pump to Fountain\n${movedTo("Fountain", patio)}`,
  });
  expect((await device("Fountain")).areaId).toBe(patio);
});

test("--id changes a device's id; its entities follow and the old id is free", async () => {
  expect(await h.cli(["device", "set", "Pond pump", "--id", "fountain"])).toMatchObject({
    code: 0,
    stdout: "Pond pump is device.fountain now; pages that said device.pond_pump need the new id\n",
  });
  expect((await device("Pond pump")).id).toBe("fountain");
  const entities = (await admin.request("get_entities", {})) as { id: string; deviceId?: string }[];
  expect(entities.find((e) => e.id === "switch.pump")?.deviceId).toBe("fountain");
  expect((await devices()).some((d) => d.id === "pond_pump")).toBe(false);

  // A taken or malformed id is refused with the reason.
  expect(await h.cli(["device", "set", "fountain", "--id", "lamp"])).toMatchObject({
    code: 1,
    stderr: "error [invalid]: lamp is already in use\n",
  });
  expect((await h.cli(["device", "set", "fountain", "--id", "Fountain!"])).stderr).toBe(
    "error [invalid]: New id must look like <a-z0-9_>\n",
  );
  expect((await device("Pond pump")).id).toBe("fountain");
});

test("--json prints the updated device instead of sentences", async () => {
  const pump = await device("Pond pump");
  const out = await h.cli([
    "device",
    "set",
    "Pond pump",
    "--name",
    "Fountain",
    "--area",
    patio,
    "--json",
  ]);
  expect(out.code).toBe(0);
  expect(JSON.parse(out.stdout)).toMatchObject({
    id: pump.id,
    name: "Fountain",
    areaId: patio,
    integrationId: "garden.main",
  });
});

test("with neither --name nor --area there is nothing to change: exit 2", async () => {
  expect(await h.cli(["device", "set", "Pond pump"])).toMatchObject({
    code: 2,
    stdout: "",
    stderr: "Nothing to change: pass --name, --id, --area or --icon\n",
  });
  expect(await h.cli(["device", "set", "Pond pump", "--json"])).toMatchObject({ code: 2 });
});

test("entities follow their device into an area unless they have one of their own", async () => {
  const shed = ((await admin.request("create_area", { name: "Shed" })) as { id: string }).id;
  await admin.request("update_entity", { entityId: "switch.lamp_plug", areaId: shed });

  expect((await h.cli(["device", "set", "Lamp", "--area", patio])).code).toBe(0);
  const entities = (await admin.request("get_entities", {})) as Entity[];
  const areaOf = (id: string) => entities.find((e) => e.id === id)?.effectiveAreaId;
  expect(areaOf("light.lamp_bulb")).toBe(patio);
  expect(areaOf("switch.lamp_plug")).toBe(shed);
  expect(areaOf("light.post")).toBeUndefined(); // another device's entity stays put

  expect((await h.cli(["device", "set", "Lamp", "--area", "none"])).code).toBe(0);
  const after = (await admin.request("get_entities", {})) as Entity[];
  expect(after.find((e) => e.id === "light.lamp_bulb")?.effectiveAreaId).toBeUndefined();
  expect(after.find((e) => e.id === "switch.lamp_plug")?.effectiveAreaId).toBe(shed);
});

test("a member cannot change a device", async () => {
  // The first admin retires the bootstrap token, so continue as that admin.
  const root = await addUser(h, admin, "root", "admin");
  const owner = await h.connect(root.token);
  const member = await addUser(h, owner, "mia", "member");

  const out = await h.cli(["device", "set", "Pond pump", "--name", "Mine", "--area", patio], {
    CASITA_TOKEN: member.token,
  });
  expect(out).toMatchObject({ code: 1, stdout: "", stderr: "error [forbidden]: Not permitted\n" });
  const devicesNow = (await owner.request("get_devices", {})) as Device[];
  expect(devicesNow.find((d) => d.name === "Pond pump")?.areaId).toBeUndefined();
});

test("--area takes an area's name as well as its id, in any case", async () => {
  const out = await h.cli(["device", "set", "Pond pump", "--area", "PATIO"]);
  expect(out.code).toBe(0);
  expect((await device("Pond pump")).areaId).toBe(patio);
  expect((await h.cli(["device", "set", "Pond pump", "--area", "NONE"])).code).toBe(0);
  expect((await device("Pond pump")).areaId).toBeUndefined();
});

test("the server refuses an empty area id rather than failing inside", async () => {
  const pump = await device("Pond pump");
  await expect(
    admin.request("update_device", { deviceId: pump.id, areaId: "" }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    admin.request("update_entity", { entityId: "light.lamp_bulb", areaId: "" }),
  ).rejects.toMatchObject({ code: "not_found" });
});

test('--icon chooses a picture for a device, an entity or an area; "default" takes it back', async () => {
  expect(await h.cli(["device", "set", "Pond pump", "--icon", "droplet"])).toMatchObject({
    code: 0,
  });
  expect((await device("Pond pump")).icon).toBe("droplet");
  expect((await h.cli(["device", "set", "Pond pump", "--icon", "default"])).code).toBe(0);
  expect((await device("Pond pump")).icon).toBeUndefined();

  expect((await h.cli(["entity", "set", "light.lamp_bulb", "--icon", "flame"])).code).toBe(0);
  const lamp = ((await admin.request("get_entities", {})) as { id: string; icon?: string }[]).find(
    (e) => e.id === "light.lamp_bulb",
  );
  expect(lamp?.icon).toBe("flame");

  expect((await h.cli(["area", "set", patio, "--icon", "sprout"])).code).toBe(0);
  expect((await h.cli(["area", "set", patio, "--name", "Terrace"])).code).toBe(0);
  const areas = (await admin.request("get_areas", {})) as {
    id: string;
    name: string;
    icon?: string;
  }[];
  expect(areas.find((a) => a.id === patio)).toMatchObject({ name: "Terrace", icon: "sprout" });
  // The API only takes names that look like icons.
  const bad = await h.cli(["area", "set", patio, "--icon", "Not An Icon"]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toContain("icon");
});
