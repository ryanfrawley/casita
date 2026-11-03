// The Casa page language end to end: Home is generated on first start, a page saves and
// publishes, its server handlers run against the real house, and themes are listed.

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

const page = (body: string) => `page Home {\n${body}\n}\n`;

test("Home is generated from the house on first start and compiles", async () => {
  const home = (await client.request("get_page", { pageId: "home" })) as Row;
  expect(home.id).toBe("home");
  expect(home.name).toBe("Home");
  expect((home.compiled as Row).astVersion).toBe(1);
  expect(await client.request("list_pages", {})).toMatchObject([{ id: "home", name: "Home" }]);
  const source = (await client.request("get_page_source", { pageId: "home" })) as Row;
  expect(source.source).toContain("page Home {");
  expect(source.versions).toHaveLength(1);
  // A restart keeps it rather than generating it again.
  await h.restart();
  client = await h.connect();
  expect(
    ((await client.request("get_page_source", { pageId: "home" })) as Row).versions,
  ).toHaveLength(1);
});

test("check_page reports diagnostics and stores nothing", async () => {
  const result = (await client.request("check_page", {
    pageId: "home",
    source: page("  Card { accent: text.nothing }"),
  })) as { diagnostics: Row[] };
  expect(result.diagnostics.map((d) => d.code)).toEqual(["E022"]);
  expect(
    ((await client.request("get_page_source", { pageId: "home" })) as Row).versions,
  ).toHaveLength(1);
});

test("save_page publishes the page to subscribers and keeps every version; revert is a save", async () => {
  const seen = record(client);
  await client.request("subscribe", { events: ["page_changed"] });
  await seen.until(() => seen.snapshots.length === 1);

  const bad = (await client.request("save_page", {
    pageId: "home",
    source: page("  Crad { }"),
  })) as Row;
  expect(bad.ok).toBe(false);
  expect((bad.diagnostics as Row[])[0]?.code).toBe("E002");

  const good = (await client.request("save_page", {
    pageId: "home",
    source: page('  Card { name: "Hello" }'),
  })) as Row;
  expect(good.ok).toBe(true);
  expect(((good.page as Row).compiled as Row).root).toMatchObject({ type: "Card" });
  await seen.until(() => seen.events.some((e) => e.type === "page_changed"));
  expect(seen.events.find((e) => e.type === "page_changed")).toEqual({
    type: "page_changed",
    pageId: "home",
  });

  const source = (await client.request("get_page_source", { pageId: "home" })) as Row;
  expect(source.source).toContain('Card { name: "Hello" }');
  expect((source.versions as Row[]).map((v) => v.version)).toEqual([2, 1]);
  expect((source.versions as Row[])[0]?.savedBy).toBe("bootstrap");

  const reverted = (await client.request("revert_page", { pageId: "home", version: 1 })) as Row;
  expect(reverted.ok).toBe(true);
  const after = (await client.request("get_page_source", { pageId: "home" })) as Row;
  expect(after.source).toContain("AreaCard");
  expect((after.versions as Row[]).map((v) => v.version)).toEqual([3, 2, 1]);
  expect(await codeOf(client.request("revert_page", { pageId: "home", version: 9 }))).toBe(
    "not_found",
  );
  expect(await codeOf(client.request("get_page", { pageId: "nope" }))).toBe("not_found");
});

test("a server handler runs against the house, as the page, and republishing replaces it", async () => {
  const seen = record(client);
  await client.request("subscribe", {
    events: ["state_changed", "command_issued"],
    entityIds: ["light.desk"],
  });
  await seen.until(() => seen.snapshots.length === 1);

  const source = (brightness: string) =>
    page(`  Card { }
  on lock.front_door changed to .Unlocked {
    call light.desk.turn_on { brightness: ${brightness} }
  }`);
  expect(
    ((await client.request("save_page", { pageId: "home", source: source("30%") })) as Row).ok,
  ).toBe(true);

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
  await unlock();
  await seen.until(() =>
    seen.events.some(
      (e) => e.type === "state_changed" && ((e.new as Row).state as Row).brightness === 0.3,
    ),
  );
  expect(seen.events.find((e) => e.type === "command_issued")).toMatchObject({
    source: { kind: "automation", automationId: "page:home" },
    command: { domain: "light", action: "turn_on", brightness: 0.3 },
  });

  // The new page's handler is the only one that fires now.
  expect(
    ((await client.request("save_page", { pageId: "home", source: source("80%") })) as Row).ok,
  ).toBe(true);
  seen.events.length = 0;
  await unlock();
  await seen.until(() =>
    seen.events.some(
      (e) => e.type === "state_changed" && ((e.new as Row).state as Row).brightness === 0.8,
    ),
  );
  const issued = seen.events.filter(
    (e) => e.type === "command_issued" && (e.command as Row).domain === "light",
  );
  expect(issued).toHaveLength(1);
});

test("themes: the built-ins are listed with css; a saved theme covers what pages use", async () => {
  const themes = (await client.request("list_themes", {})) as Row[];
  expect(themes.map((t) => t.id)).toEqual(["day", "night", "october"]);
  expect(themes[0]).toMatchObject({
    name: "Day",
    builtin: true,
    dark: false,
    isLightDefault: true,
  });
  expect(themes[1]).toMatchObject({
    name: "Night",
    builtin: true,
    dark: true,
    isDarkDefault: true,
  });
  expect(themes[2]).toMatchObject({
    name: "October",
    extends: "Night",
    builtin: true,
    dark: true,
    isDarkDefault: false,
  });
  expect(String(themes[2]?.source)).toStartWith("// October");
  expect(String(themes[0]?.css)).toContain('[data-theme="day"]');

  // A page that needs a colour no theme has cannot be saved; a theme that has it makes it possible.
  const needsWarn = page("  Card { accent: palette.warn }");
  const refused = (await client.request("save_page", { pageId: "home", source: needsWarn })) as Row;
  expect((refused.diagnostics as Row[]).map((d) => d.code)).toEqual(["E021", "E021", "E021"]);

  const dusk = (await client.request("save_theme", {
    themeId: "dusk",
    source: "theme Dusk extends Night { palette { warn: #d9593a } }",
  })) as Row;
  expect(dusk.ok).toBe(true);
  expect(dusk.theme).toMatchObject({
    id: "dusk",
    extends: "Night",
    dark: true,
    isDarkDefault: true,
    isLightDefault: true,
  });
  expect(
    ((await client.request("save_page", { pageId: "home", source: needsWarn })) as Row).ok,
  ).toBe(true);

  // Now the page depends on it, so the theme cannot lose it.
  const stripped = (await client.request("save_theme", {
    themeId: "dusk",
    source: "theme Dusk extends Night { }",
  })) as Row;
  expect(stripped.ok).toBe(false);
  expect((stripped.diagnostics as Row[])[0]?.code).toBe("E021");
  const wrongName = (await client.request("save_theme", {
    themeId: "dusk",
    source: "theme Dawn extends Day { }",
  })) as Row;
  expect(wrongName.ok).toBe(false);

  // Themes declared in a page's file are stored beside it.
  const withTheme = `theme Dawn extends Day { palette { warn: #d9593a } }\n${needsWarn}`;
  expect(
    ((await client.request("save_page", { pageId: "home", source: withTheme })) as Row).ok,
  ).toBe(true);
  const listed = (await client.request("list_themes", {})) as Row[];
  expect(listed.map((t) => t.id)).toEqual(["day", "night", "october", "dawn", "dusk"]);
  expect(listed.find((t) => t.id === "dawn")).toMatchObject({
    isLightDefault: true,
    source: "theme Dawn extends Day { palette { warn: #d9593a } }",
  });
});

test("a member can read pages and themes but not the source, nor save", async () => {
  // Creating the first admin retires the bootstrap token, so continue as that admin.
  const admin = await h.connect((await addUser(h, client, "ada", "admin")).token);
  const member = await h.connect((await addUser(h, admin, "mel", "member")).token);
  expect(((await member.request("get_page", { pageId: "home" })) as Row).id).toBe("home");
  expect(((await member.request("list_themes", {})) as Row[])[0]?.source).toBeUndefined();
  expect(await codeOf(member.request("get_page_source", { pageId: "home" }))).toBe("forbidden");
  expect(await codeOf(member.request("save_page", { pageId: "home", source: "" }))).toBe(
    "forbidden",
  );
});

test("the CLI has a subcommand per request: list, source, check, save, revert, themes", async () => {
  expect((await h.cli(["page", "list"])).stdout).toMatch(/home +Home/);
  expect((await h.cli(["page", "source", "home"])).stdout).toContain("page Home {");
  expect((await h.cli(["page", "source", "home", "--versions"])).stdout).toMatch(/^1 +\d+$/m);
  const bad = await h.cli(["page", "check", "home", "page Home { Crad { } }"]);
  expect(bad.code).toBe(1);
  expect(bad.stdout).toContain("E002");
  const saved = await h.cli(
    ["page", "save", "home", "-"],
    {},
    'page Home { Card { name: "cli" } }',
  );
  expect(saved.code).toBe(0);
  expect(saved.stdout).toBe("Saved home\n");
  expect((await h.cli(["page", "show", "home"])).stdout).toContain('"type": "Card"');
  expect((await h.cli(["page", "revert", "home", "1"])).stdout).toBe(
    "Reverted home to version 1\n",
  );
  expect((await h.cli(["theme", "list"])).stdout).toMatch(/day +Day/);
  const theme = await h.cli([
    "theme",
    "save",
    "dusk",
    "theme Dusk extends Night { palette { lamp: #fff } }",
  ]);
  expect(theme.stdout).toBe("Saved theme dusk\n");
  expect((await h.cli(["theme", "list"])).stdout).toMatch(/dusk +Dusk +Night/);
});
