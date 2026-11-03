import { expect, test } from "bun:test";
import { createCore } from "../testing.ts";
import { REGISTRY } from "./fixtures.ts";
import { PageStore } from "./store.ts";
import { OCTOBER_SOURCE } from "./theme.ts";

async function setup() {
  const { db, bus, now } = await createCore();
  return new PageStore({ db, bus, now, registry: () => REGISTRY });
}

const byId = (store: PageStore, id: string) => store.listThemes().find((t) => t.id === id);

test("October is listed as a built-in with its bundled source; Day and Night have none", async () => {
  const store = await setup();
  expect(store.listThemes().map((t) => [t.id, t.builtin])).toEqual([
    ["day", true],
    ["night", true],
    ["october", true],
  ]);
  expect(byId(store, "october")?.source).toBe(OCTOBER_SOURCE);
  expect(byId(store, "day")?.source).toBeUndefined();
  expect(byId(store, "night")?.source).toBeUndefined();
});

test("with only built-ins, Day and Night are the defaults, not October", async () => {
  const store = await setup();
  expect(byId(store, "day")).toMatchObject({ isLightDefault: true, isDarkDefault: false });
  expect(byId(store, "night")).toMatchObject({ isLightDefault: false, isDarkDefault: true });
  expect(byId(store, "october")).toMatchObject({ isLightDefault: false, isDarkDefault: false });
});

test("a house theme over October keeps its own source and is not a built-in", async () => {
  const store = await setup();
  const source = "theme Hallow extends October { palette { lamp: #ffd166 } }";
  expect(store.saveTheme("hallow", source).ok).toBe(true);
  const hallow = byId(store, "hallow");
  expect(hallow).toMatchObject({ source, builtin: false, extends: "October", dark: true });
  expect(hallow?.isDarkDefault).toBe(true);
  expect(hallow?.values["palette.terracotta"]).toEqual({ kind: "color", hex: "#f08a2e" });
  expect(byId(store, "october")?.source).toBe(OCTOBER_SOURCE);
});

async function setupWithBus() {
  const { db, bus, now } = await createCore();
  return { db, bus, store: new PageStore({ db, bus, now, registry: () => REGISTRY }) };
}

const PILL = "component Pill(label: String) { Text { value: label } }";
const LOUD_AREA = "component AreaHeader(of: Area) { Text { value: upper(of.name) } }";
const LOUD_ROOM = "component RoomHeader(of: Area) { Text { value: upper(of.name) } }";
const pageSource = (body: string) => `page Home {\n${body}\n}\n`;

test("an empty house has an empty components file and no author", async () => {
  const store = await setup();
  expect(store.getComponents()).toEqual({
    source: "",
    updatedAt: undefined,
    updatedBy: undefined,
  });
});

test("checking a components file reports its problems without storing it", async () => {
  const store = await setup();
  expect(store.checkComponents(PILL)).toEqual([]);
  expect(
    store.checkComponents("component A(x: String) { Text { value: y } }").map((d) => d.code),
  ).toEqual(["E005"]);
  expect(store.getComponents().source).toBe("");
});

test("a file of components is stored with its author and announced", async () => {
  const { bus, store } = await setupWithBus();
  const events: string[] = [];
  bus.onAny((e) => events.push(e.type));
  expect(store.saveComponents(PILL, "ry")).toEqual({ ok: true, diagnostics: [] });
  expect(store.getComponents()).toMatchObject({ source: PILL, updatedBy: "ry" });
  expect(store.getComponents().updatedAt).toBeNumber();
  expect(events).toEqual(["components_changed"]);
});

test("a later save replaces the file rather than adding a second", async () => {
  const store = await setup();
  store.saveComponents(PILL);
  expect(store.saveComponents(LOUD_AREA).ok).toBe(true);
  expect(store.getComponents().source).toBe(LOUD_AREA);
});

test("a shared AreaHeader replaces the bundled one in a page saved after it", async () => {
  const store = await setup();
  expect(store.saveComponents(LOUD_AREA).ok).toBe(true);
  const saved = store.save("home", pageSource('  Area { of: area.living  name: "Living" }'));
  expect(saved.ok).toBe(true);
  expect(saved.page?.compiled.components.AreaHeader?.root.type).toBe("Text");
  expect(store.getPage("home")?.compiled.components.AreaHeader?.root.type).toBe("Text");
});

test("a shared RoomHeader is saved with a warning to rename it, and still replaces the bundled AreaHeader", async () => {
  const store = await setup();
  const saved = store.saveComponents(LOUD_ROOM);
  expect(saved.ok).toBe(true);
  expect(saved.diagnostics.map((d) => d.code)).toEqual(["W105"]);
  const page = store.save("home", pageSource('  Area { of: area.living  name: "Living" }'));
  expect(page.ok).toBe(true);
  expect(page.diagnostics).toEqual([]);
  expect(page.page?.compiled.components.AreaHeader?.root.type).toBe("Text");
});

test("saving the file recompiles every stored page against it and announces each", async () => {
  const { bus, store } = await setupWithBus();
  store.save("home", pageSource('  Area { of: area.living  name: "Living" }'));
  const header = () => JSON.stringify(store.getPage("home")?.compiled.components.AreaHeader?.root);
  expect(header()).not.toContain("upper");
  const events: string[] = [];
  bus.onAny((e) => events.push(e.type === "page_changed" ? `page_changed ${e.pageId}` : e.type));
  expect(store.saveComponents(LOUD_AREA).ok).toBe(true);
  expect(header()).toContain("upper");
  expect(events).toEqual(["components_changed", "page_changed home"]);
});

test("a page may use a shared component once the file declares it", async () => {
  const store = await setup();
  const body = pageSource('  Pill { label: "hi" }');
  expect(store.save("home", body).ok).toBe(false);
  store.saveComponents(PILL);
  const saved = store.save("home", body);
  expect(saved.ok).toBe(true);
  expect(saved.page?.compiled.components.Pill).toBeDefined();
});

test("a file that would break a stored page is refused, naming the page, and the old file stays", async () => {
  const { bus, store } = await setupWithBus();
  store.saveComponents(PILL, "ry");
  store.save("home", pageSource('  Pill { label: "hi" }'));
  const before = store.getPage("home");
  const events: string[] = [];
  bus.onAny((e) => events.push(e.type));

  const result = store.saveComponents(LOUD_AREA, "someone");
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual([]);
  expect(result.page).toBe("home");
  expect(result.pageDiagnostics?.length).toBeGreaterThan(0);
  expect(store.getComponents()).toMatchObject({ source: PILL, updatedBy: "ry" });
  expect(store.getPage("home")).toEqual(before);
  expect(events).toEqual([]);
});

test("a file with its own problems is refused with them and nothing is stored", async () => {
  const store = await setup();
  const result = store.saveComponents("component A(x: String) { Text { value: y } }");
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((d) => d.code)).toEqual(["E005"]);
  expect(result.page).toBeUndefined();
  expect(store.getComponents().source).toBe("");
});

test("a file holding a page or a theme is refused with E001", async () => {
  const store = await setup();
  for (const extra of ["page P { Card { } }", "theme Hallow extends October { }"]) {
    const result = store.saveComponents(`${PILL}\n${extra}`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["E001"]);
  }
  expect(store.getComponents().source).toBe("");
});

test("a refresh recompiles a page stored by an older compiler and leaves a current one alone", async () => {
  const { db, bus, store } = await setupWithBus();
  expect(store.save("home", pageSource("  Area { of: area.hall }"), "ryan").ok).toBe(true);
  const stored = store.getPage("home");
  expect(stored?.compiled.components.AreaHeader).toBeDefined();
  // As an older release left it: compiled without the bundled headings.
  const stale = { ...stored, compiled: { ...stored?.compiled, components: {} } };
  db.query("UPDATE pages SET compiled = ? WHERE id = 'home'").run(
    JSON.stringify({ page: stale.compiled, serverHandlers: [] }),
  );
  expect(store.getPage("home")?.compiled.components.AreaHeader).toBeUndefined();

  const events: string[] = [];
  bus.onAny((e) => events.push(e.type));
  expect(store.refresh()).toEqual({ refreshed: ["home"], failed: [] });
  expect(store.getPage("home")?.compiled.components.AreaHeader).toBeDefined();
  expect(store.getSource("home").versions).toHaveLength(1);
  expect(events).toEqual(["page_changed"]);

  expect(store.refresh()).toEqual({ refreshed: [], failed: [] });
});
