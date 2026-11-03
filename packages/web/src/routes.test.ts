import { describe, expect, test } from "bun:test";
import {
  DEVICE_SETTINGS_PATH,
  deviceSettingsPath,
  editAutomationPath,
  editPagePath,
  editThemePath,
  matchPath,
} from "./routes.ts";

describe("matchPath", () => {
  test("a plain path matches itself, with or without a trailing slash", () => {
    expect(matchPath("/", "/")).toEqual({});
    expect(matchPath("/devices", "/devices")).toEqual({});
    expect(matchPath("/devices", "/devices/")).toEqual({});
    expect(matchPath("/", "/devices")).toBeUndefined();
    expect(matchPath("/devices", "/")).toBeUndefined();
    expect(matchPath("/devices", "/entities")).toBeUndefined();
  });

  test("a :param takes one segment, decoded", () => {
    expect(matchPath("/devices/:id/card", "/devices/dev_12/card")).toEqual({ id: "dev_12" });
    expect(matchPath("/devices/:id/card", "/devices/a%20b/card")).toEqual({ id: "a b" });
    expect(matchPath("/devices/:id/card", "/devices/dev_12/card/")).toEqual({ id: "dev_12" });
  });

  test("no partial matches, no empty params, no bad escapes", () => {
    expect(matchPath("/devices/:id/card", "/devices/dev_12")).toBeUndefined();
    expect(matchPath("/devices/:id/card", "/devices/dev_12/card/x")).toBeUndefined();
    expect(matchPath("/devices/:id/card", "/devices//card")).toBeUndefined();
    expect(matchPath("/devices/:id/card", "/devices/%E0%A4%A/card")).toBeUndefined();
    expect(matchPath("/devices", "/devices/dev_12")).toBeUndefined();
  });
});

test("editPagePath and editThemePath escape the id and match their own patterns", () => {
  expect(editPagePath("home")).toBe("/edit/home");
  expect(matchPath("/edit/:id", editPagePath("a b"))).toEqual({ id: "a b" });
  expect(editThemePath("dusk")).toBe("/edit/theme/dusk");
  expect(matchPath("/edit/theme/:id", editThemePath("dusk"))).toEqual({ id: "dusk" });
  // The theme route is matched before the page route, which would take "theme" as a page id.
  expect(matchPath("/edit/:id", "/edit/theme/dusk")).toBeUndefined();
  expect(editAutomationPath("hall_light")).toBe("/automations/edit/hall_light");
  expect(matchPath("/automations/edit/:id", editAutomationPath("hall_light"))).toEqual({
    id: "hall_light",
  });
});

test("a device's settings are at /devices/<id>/settings, the id encoded", () => {
  expect(deviceSettingsPath("kitchen_dimmer")).toBe("/devices/kitchen_dimmer/settings");
  expect(matchPath(DEVICE_SETTINGS_PATH, deviceSettingsPath("a b"))).toEqual({ id: "a b" });
  expect(matchPath(DEVICE_SETTINGS_PATH, "/devices")).toBeUndefined();
});
