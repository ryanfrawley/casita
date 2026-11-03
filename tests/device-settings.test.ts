// Device settings end to end: an integration describes them, the core checks a change, the
// API and CLI read and write them, and the device's report comes back as settings_changed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { createCatalog } from "../packages/core/src/config.ts";
import fixture from "./fixtures/devices.ts";
import dials from "./fixtures/dials.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, codeOf, type Harness, record } from "./harness.ts";

let h: Harness;
let admin: CasitaClient;
beforeEach(async () => {
  h = await boot(
    `[server]\napiToken = "${BOOTSTRAP_TOKEN}"\n\n[[integration]]\ntype = "dials"\n\n[[integration]]\ntype = "fixture"\n`,
    createCatalog(dials, fixture),
  );
  admin = await h.connect();
});
afterEach(() => h.stop());

type Setting = { key: string; value: unknown };
const settings = async (deviceId: string) =>
  ((await admin.request("get_device_settings", { deviceId })) as { settings: Setting[] }).settings;
const settingValue = async (key: string) =>
  (await settings("hall_dimmer")).find((s) => s.key === key)?.value;

test("an integration's settings are listed; a device or integration with none lists nothing", async () => {
  expect((await settings("hall_dimmer")).map((s) => [s.key, s.value])).toEqual([
    ["min", 1],
    ["type", 0],
    ["smart", false],
    ["neutral", 1],
  ]);
  expect(await settings("plain_plug")).toEqual([]);
  expect(await settings("fixture_hub")).toEqual([]);
  expect(await codeOf(settings("nope"))).toBe("not_found");
  const integrations = (await admin.request("get_integrations", {})) as {
    integrationId: string;
    deviceSettings: boolean;
  }[];
  expect(integrations.map((i) => [i.integrationId, i.deviceSettings])).toEqual([
    ["dials.main", true],
    ["fixture.main", false],
  ]);
});

test("a change is checked and normalized, sent, and shown once the device reports it", async () => {
  const seen = record(admin);
  await admin.request("subscribe", { events: ["settings_changed"] });
  expect(
    await admin.request("set_device_setting", {
      deviceId: "hall_dimmer",
      key: "type",
      value: "aux switch",
    }),
  ).toEqual({ key: "type", value: 2 });
  // Not yet: the device has not reported.
  expect(await settingValue("type")).toBe(0);
  await seen.until(() => seen.events.length > 0);
  expect(seen.events).toEqual([{ type: "settings_changed", deviceId: "hall_dimmer" }]);
  expect(await settingValue("type")).toBe(2);
});

test("values that do not fit are refused with the reason, before the integration sees them", async () => {
  const refusal = (key: string, value: unknown) =>
    admin.request("set_device_setting", { deviceId: "hall_dimmer", key, value } as never).then(
      () => "accepted",
      (err: Error & { code: string }) => `${err.code}: ${err.message}`,
    );
  expect(await refusal("min", 60)).toBe("invalid: Minimum level is at most 54");
  expect(await refusal("type", 1)).toBe(
    "invalid: Switch type is one of: 0 (Single pole), 2 (Aux switch)",
  );
  expect(await refusal("smart", 1)).toBe("invalid: Smart bulb mode is on or off: true or false");
  expect(await refusal("neutral", 1)).toBe(
    "invalid: Neutral is reported by the device and can't be changed",
  );
  expect(await refusal("max", 1)).toBe('not_found: hall_dimmer has no setting "max"');
  await Bun.sleep(20);
  expect(await settingValue("min")).toBe(1);
});

test("settings are an admin's: a member can neither read nor change them, nor hear of changes", async () => {
  // Creating the first admin retires the bootstrap token, so continue as that admin.
  const root = await h.connect((await addUser(h, admin, "root", "admin")).token);
  const member = await h.connect((await addUser(h, root, "sam", "member")).token);
  const heard = record(member);
  await member.request("subscribe", {});
  expect(await codeOf(member.request("get_device_settings", { deviceId: "hall_dimmer" }))).toBe(
    "forbidden",
  );
  const seen = record(root);
  await root.request("subscribe", { events: ["settings_changed"] });
  await root.request("set_device_setting", { deviceId: "hall_dimmer", key: "min", value: 5 });
  await seen.until(() => seen.events.length > 0);
  expect(heard.events.filter((e) => e.type === "settings_changed")).toEqual([]);
});

test("cli: device settings lists them in sections; device setting changes one", async () => {
  const listed = await h.cli(["device", "settings", "hall"]);
  expect(listed).toMatchObject({ code: 0, stderr: "" });
  expect(listed.stdout).toBe(
    [
      "KEY      LABEL          VALUE",
      "min      Minimum level  1",
      "type     Switch type    Single pole",
      "neutral  Neutral        Present (reported)",
      "",
      "Bulbs",
      "KEY    LABEL            VALUE",
      "smart  Smart bulb mode  Off",
      "",
    ].join("\n"),
  );
  expect((await h.cli(["device", "settings", "hall", "--find", "bulb"])).stdout).toBe(
    ["", "Bulbs", "KEY    LABEL            VALUE", "smart  Smart bulb mode  Off", ""].join("\n"),
  );
  expect((await h.cli(["device", "settings", "plain"])).stdout).toBe(
    "Plain plug has no settings Casita can change\n",
  );

  expect(await h.cli(["device", "setting", "hall", "smart", "true"])).toMatchObject({
    code: 0,
    stdout: "Sent smart = true to Hall dimmer; it shows when the device reports it\n",
  });
  const refused = await h.cli(["device", "setting", "hall", "min", "0"]);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("Minimum level is at least 1");
});
