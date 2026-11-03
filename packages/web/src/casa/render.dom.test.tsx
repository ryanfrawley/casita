import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { Row } from "@casita/client";
import { type CompiledPage, compile } from "@casita/core/casa";
import { setupDom } from "@casita/ui/test-dom";
import { AppProvider } from "../context.tsx";
import { type Action, EMPTY, type House, reduce, type Store } from "../store.ts";
import { CasaStore } from "./host.ts";
import { CasaPage } from "./page.tsx";

const dom = setupDom();

const scope = globalThis as unknown as Record<string, unknown>;
let savedMatchMedia: unknown;
beforeAll(() => {
  savedMatchMedia = scope.matchMedia;
  scope.matchMedia = () => ({ matches: false });
});
afterAll(() => {
  scope.matchMedia = savedMatchMedia;
});

// ───────── a house ─────────

const entity = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  domain: id.split(".")[0],
  name,
  integrationId: "test.main",
  capabilities: {},
  level: "control",
  controllable: true,
  ...extra,
});

const state = (id: string, state: Row, extra: Row = {}): Row => ({
  entityId: id,
  state,
  available: true,
  changedAt: 1000,
  updatedAt: 2000,
  ...extra,
});

// Monday 5 October 2026 in Seattle (UTC-7): sunrise 7:12 am, sunset 6:42 pm; then Tuesday's.
const SUNRISE = Date.UTC(2026, 9, 5, 14, 12);
const SUNSET = Date.UTC(2026, 9, 6, 1, 42);
const SUN_DAYS = [
  { date: "2026-10-05", sunrise: SUNRISE, sunset: SUNSET },
  {
    date: "2026-10-06",
    sunrise: Date.UTC(2026, 9, 6, 14, 13),
    sunset: Date.UTC(2026, 9, 7, 1, 40),
  },
];

const LOADED = {
  me: { username: "ry", role: "admin" },
  entities: [
    entity("light.hall", "Hall light", {
      areaId: "hall",
      effectiveAreaId: "hall",
      capabilities: { brightness: true },
    }),
    entity("sensor.hall_temp", "Hall temperature", {
      areaId: "hall",
      effectiveAreaId: "hall",
      controllable: false,
    }),
    entity("switch.porch", "Porch", { deviceId: "dev_porch", effectiveAreaId: "hall" }),
    entity("lock.front", "Front door", { effectiveAreaId: "hall" }),
    entity("cover.garage_left", "Left garage door"),
    entity("cover.garage_right", "Right garage door"),
    entity("sensor.car_location", "Car", { controllable: false }),
    entity("weather.home", "Home", { controllable: false }),
    entity("sensor.pm25", "Particles", { controllable: false }),
    entity("sensor.pm10", "Coarse particles", { controllable: false }),
  ],
  devices: [{ id: "dev_porch", name: "Porch switch", areaId: "hall" }],
  areas: [{ id: "hall", name: "Hall" }],
  cards: [],
  states: [
    state("light.hall", { domain: "light", on: true, brightness: 0.5 }),
    state("sensor.hall_temp", { domain: "sensor", value: 21.5, unit: "°C" }),
    state("switch.porch", { domain: "switch", on: false }),
    state("lock.front", { domain: "lock", locked: true }),
    state("cover.garage_left", { domain: "cover", position: 1, motion: "stopped" }),
    state("cover.garage_right", { domain: "cover", position: 0, motion: "stopped" }),
    state(
      "sensor.car_location",
      { domain: "sensor", value: "Home" },
      { attributes: { latitude: 37.7749, longitude: -122.4194, heading: 90 } },
    ),
    state(
      "weather.home",
      { domain: "weather", condition: "clear", temperature: 14 },
      {
        attributes: {
          timeZone: "America/Los_Angeles",
          daily: SUN_DAYS,
          uvIndex: 4.5,
          latitude: 47.6,
          longitude: -122.32,
        },
      },
    ),
    state("sensor.pm25", { domain: "sensor", value: 21, unit: "µg/m³" }),
    state("sensor.pm10", { domain: "sensor", value: 30, unit: "µg/m³" }, { available: false }),
  ],
  integrations: [],
};

/** A store that reduces like the real one and remembers the commands it was given. */
function stubStore(hold?: Promise<void>) {
  let house: House = reduce(EMPTY, { type: "loaded", data: LOADED as never });
  const listeners = new Set<() => void>();
  const commands: unknown[] = [];
  const dispatch = (action: Action) => {
    house = reduce(house, action);
    for (const listener of listeners) listener();
  };
  const store = {
    getState: () => house,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    command: async (entityId: string, command: unknown) => {
      commands.push({ entityId, command });
      // A command the house has not yet answered, while `hold` is pending.
      await hold;
      return { ok: true, confirmed: true };
    },
    request: async () => ({}),
    onEvent: () => () => {},
    onRenamed: () => () => {},
  } as unknown as Store;
  return { store, commands, dispatch };
}

const REGISTRY = {
  entities: LOADED.entities.map((e) => ({
    id: String(e.id),
    domain: String(e.domain) as "light",
    name: String(e.name),
  })),
  areas: LOADED.areas.map((a) => ({ id: a.id, name: a.name })),
  devices: LOADED.devices.map((d) => ({ id: d.id, name: d.name })),
};

function compiled(source: string, sharedSource?: string): CompiledPage {
  const result = compile({ source, registry: REGISTRY, requirePage: true, sharedSource });
  if (!result.page) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  return result.page;
}

async function mount(source: string, width = 1200, hold?: Promise<void>, sharedSource?: string) {
  const { store, commands, dispatch } = stubStore(hold);
  const casa = new CasaStore(store, { width: () => width, tick: false, timezone: "UTC" });
  const page = compiled(source, sharedSource);
  const el = await dom.render(
    <AppProvider store={store} toast={() => ""} casa={casa} themes={[]}>
      <CasaPage page={page} className="page" />
    </AppProvider>,
  );
  return { el, commands, dispatch, casa, text: () => el.textContent ?? "" };
}

// ───────── tests ─────────

test("a page draws its nodes over the house, and a property follows the state it read", async () => {
  const { el, text, dispatch } = await mount(`page P {
    Stack {
      Text { value: "Hall is " + format(sensor.hall_temp.value, 1) + " " + unit(sensor.hall_temp) }
      Text { value: light.hall.value == .On ? "lit" : "dark"  style: .Label }
      Card { name: "Porch"  active: switch.porch.value == .On
        Row { of: switch.porch }
      }
    }
  }`);
  expect(text()).toContain("Hall is 21.5 °C");
  expect(text()).toContain("lit");
  expect(el.querySelector(".ca-ecard")?.className).not.toContain("ca-ecard-active");

  await dom.act(() => {
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "light.hall",
        new: state("light.hall", { domain: "light", on: false }),
      } as never,
    });
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "switch.porch",
        new: state("switch.porch", { domain: "switch", on: true }),
      } as never,
    });
  });
  expect(text()).toContain("dark");
  expect(text()).toContain("Hall is 21.5 °C");
  expect(el.querySelector(".ca-ecard")?.className).toContain("ca-ecard-active");
});

test("a card whose only row comes through a for, or a variable, is drawn as that row", async () => {
  const { el } = await mount(`
    component One(of: Entity) { Card { name: of.name  Row { of: of } } }
    page P {
      Stack {
        for d in devices { Card { name: d.name  for e in d.entities { Row { of: e } } } }
        Card { name: "Hall"  for e in area.hall.entities where e.domain != "sensor" { Row { of: e } } }
        Card { name: "Nobody"  for e in area.hall.entities where e.domain == "cover" { Row { of: e } } }
        One { of: lock.front }
      }
    }
  `);
  const cards = [...el.querySelectorAll(".ca-ecard, .ca-widget")];
  expect(cards.map((c) => `${c.className.split(" ")[0]} ${c.getAttribute("aria-label")}`)).toEqual([
    "ca-ecard Porch switch",
    "ca-widget Hall",
    "ca-widget Nobody",
    "ca-ecard Front door",
  ]);
  // The one-entity device says its name once, with the entity's state under it.
  expect(cards[0]?.querySelector(".ca-ecard-summary")?.textContent).toBe("Off");
  expect(cards[0]?.querySelectorAll(".ca-row")).toHaveLength(0);
  expect(cards[1]?.querySelectorAll(".ca-row").length).toBeGreaterThan(1);
  expect(cards[2]?.textContent).toContain("Nothing on this card.");
});

test("a card written with no body is its heading alone", async () => {
  const { el } = await mount(`
    page P {
      Card { name: "Exterior door"  subtitle: "Closed · Locked"  icon: "lock" }
    }
  `);
  const card = el.querySelector(".ca-widget");
  expect(card?.textContent).toContain("Exterior door");
  expect(card?.textContent).toContain("Closed · Locked");
  expect(card?.textContent).not.toContain("Nothing on this card.");
  expect(card?.querySelector(".ca-widget-body, .ca-widget-empty")).toBeNull();
});

test("when hides, for repeats by key, and a component's state answers its own events", async () => {
  const { el, text, dispatch } = await mount(`
    component Picker(of: Entity) {
      state range: Enum<Hour | Day | Week> = .Day
      Card { name: of.name
        Text { value: "Range " + (range == .Hour ? "hour" : range == .Day ? "day" : "week") }
        Segmented { options: [.Hour, .Day, .Week]  labels: ["H", "D", "W"]  value: range  onChange: (v) => set range = v }
      }
    }
    page P {
      Stack {
        Text { value: "Locked"  when: lock.front.value == .Locked }
        Text { value: "Unlocked"  when: lock.front.value == .Unlocked }
        for e in area.hall.entities where e.domain == "light" || e.domain == "switch" { Toggle { of: e } }
        Picker { of: sensor.hall_temp }
      }
    }`);
  expect(text()).toContain("Locked");
  expect(text()).not.toContain("Unlocked");
  expect(el.querySelectorAll(".ca-row")).toHaveLength(2);
  expect(text()).toContain("Range day");

  await dom.act(() => {
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "lock.front",
        new: state("lock.front", { domain: "lock", locked: false }),
      } as never,
    });
  });
  expect(text()).toContain("Unlocked");
  expect(text()).not.toContain("Locked");

  const week = [...el.querySelectorAll("button")].find((b) => b.textContent === "W");
  await dom.click(week);
  expect(text()).toContain("Range week");
});

test("screen follows the viewport against the breakpoints", async () => {
  const { text, casa } = await mount(`page P {
    Text { value: screen == .Phone ? "phone" : screen == .Tablet ? "tablet" : "desktop" }
  }`);
  expect(text()).toBe("desktop");
  await dom.act(() => casa.setWidth(900));
  expect(text()).toBe("tablet");
  await dom.act(() => casa.setWidth(400));
  expect(text()).toBe("phone");
  await dom.act(() => casa.setBreakpoints({ tablet: 300, desktop: 500 }));
  expect(text()).toBe("tablet");
});

test("a browser handler sends its command through the store and sets state", async () => {
  const { el, commands, text } = await mount(`page P {
    state presses = 0
    Stack {
      Text { value: "Pressed " + format(presses) }
      Button { label: "Hall on"  onPress: () => { set presses = presses + 1; call light.hall.turn_on { brightness: 80% } } }
    }
  }`);
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Hall on"));
  await dom.click(button);
  expect(commands).toEqual([
    { entityId: "light.hall", command: { domain: "light", action: "turn_on", brightness: 0.8 } },
  ]);
  expect(text()).toContain("Pressed 1");
});

test("a button is busy from its press until the house has answered its handler's command", async () => {
  let answer = () => {};
  const hold = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { el } = await mount(
    `page P { Button { label: "Lock"  icon: "lock"  onPress: () => call lock.front.lock } }`,
    1200,
    hold,
  );
  const button = el.querySelector("button");
  expect(button?.getAttribute("aria-busy")).toBeNull();
  await dom.click(button);
  // Spinning in the icon's place, and a second press does nothing, until the answer comes.
  expect(button?.getAttribute("aria-busy")).toBe("true");
  expect(button?.querySelector("svg.ca-spin")).not.toBeNull();
  await dom.act(async () => {
    answer();
    await hold;
  });
  expect(button?.getAttribute("aria-busy")).toBeNull();
  expect(button?.querySelector("svg.ca-spin")).toBeNull();
});

const DOORS = `page P {
  ButtonGroup { of: [cover.garage_left, cover.garage_right]  labels: ["Left", "Right"]  label: "Garage" }
}`;
const segments = (el: HTMLElement) => [...el.querySelectorAll(".ca-bgroup button")];
const segmentText = (el: HTMLElement) =>
  segments(el).map((b) => b.querySelector(".ca-bgroup-label")?.textContent);

test("a ButtonGroup draws a segment per entity, lit while its cover is open", async () => {
  const { el } = await mount(DOORS);
  expect(el.querySelector(".ca-bgroup")?.getAttribute("aria-label")).toBe("Garage");
  expect(segmentText(el)).toEqual(["Left", "Right"]);
  expect(segments(el).map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  expect(segments(el).map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false]);
});

test("a ButtonGroup's cover asks first, and sends its command only on the second click", async () => {
  const { el, commands } = await mount(DOORS);
  const [left, right] = segments(el);
  await dom.click(left);
  expect(commands).toEqual([]);
  expect(segmentText(el)).toEqual(["Close?", "Right"]);
  // A click on the other door moves the question there, still sending nothing.
  await dom.click(right);
  expect(commands).toEqual([]);
  expect(segmentText(el)).toEqual(["Left", "Open?"]);
  await dom.click(right);
  expect(commands).toEqual([
    { entityId: "cover.garage_right", command: { domain: "cover", action: "open" } },
  ]);
  await dom.click(left);
  await dom.click(left);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual({
    entityId: "cover.garage_left",
    command: { domain: "cover", action: "close" },
  });
});

test("a ButtonGroup's light toggles on one click, and its segment follows the light", async () => {
  const { el, commands, dispatch } = await mount(`page P {
    ButtonGroup { of: [light.hall, switch.porch] }
  }`);
  expect(el.querySelector(".ca-bgroup")?.getAttribute("aria-label")).toBe("Buttons");
  // With no labels, each segment is named for its entity.
  expect(segmentText(el)).toEqual(["Hall light", "Porch"]);
  expect(segments(el).map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  await dom.click(segments(el)[0]);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    entityId: "light.hall",
    command: { domain: "light", action: "turn_off" },
  });
  await dom.click(segments(el)[1]);
  expect(commands[1]).toMatchObject({
    entityId: "switch.porch",
    command: { domain: "switch", action: "turn_on" },
  });
  await dom.act(() =>
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "switch.porch",
        new: state("switch.porch", { domain: "switch", on: true }),
      } as never,
    }),
  );
  expect(segments(el)[1]?.getAttribute("aria-pressed")).toBe("true");
});

const mapOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-map");
const mapTiles = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-map-tile")].map((img) => img.getAttribute("src"));

test("a Map of an entity is centred on its attributes and points the pin along its heading", async () => {
  const { el } = await mount(`page P {
    Map { of: sensor.car_location  zoom: 15  height: 200  latitude: 51.5  longitude: -0.1 }
  }`);
  expect(mapOf(el)?.getAttribute("aria-label")).toBe("Car");
  expect(mapOf(el)?.getAttribute("style")).toBe("height: 200px;");
  // The entity's place wins over the page's own, which is only where to look while it has none.
  expect(el.querySelector(".ca-map-credit")?.getAttribute("href")).toBe(
    "https://www.openstreetmap.org/?mlat=37.77490&mlon=-122.41940#map=15/37.77490/-122.41940",
  );
  expect(mapTiles(el)).toContain("https://tile.openstreetmap.org/15/5241/12665.png");
  expect(el.querySelector(".ca-map-pin")?.getAttribute("style")).toBe("transform: rotate(90deg);");
});

test("a Map in a card is a block of its own, so the body's divider runs above its frame", async () => {
  const { el } = await mount(`page P {
    Card { name: "Car"  Row { of: sensor.hall_temp }  Map { of: sensor.car_location } }
  }`);
  const blocks = [...(el.querySelector(".ca-widget-body")?.children ?? [])];
  expect(blocks).toHaveLength(2);
  expect(blocks[1]?.classList.contains("ca-map")).toBe(false);
  expect(blocks[1]?.firstElementChild?.classList.contains("ca-map")).toBe(true);
});

test("a Map whose entity has no position is drawn at the page's latitude and longitude", async () => {
  const { el } = await mount(`page P {
    Map { of: sensor.hall_temp  latitude: 51.5  longitude: -0.1  zoom: 12  label: "Hall" }
  }`);
  expect(mapOf(el)?.getAttribute("aria-label")).toBe("Hall");
  expect(el.querySelector(".ca-map-credit")?.getAttribute("href")).toBe(
    "https://www.openstreetmap.org/?mlat=51.50000&mlon=-0.10000#map=12/51.50000/-0.10000",
  );
  // The page's place has no heading, so the pin is a plain one.
  expect(el.querySelector(".ca-map-pin")?.className).toBe("ca-map-pin");
});

test("a Map with no position from its entity or the page says it has no location", async () => {
  const { el } = await mount(`page P {
    Map { of: sensor.hall_temp  marker: false }
  }`);
  expect(el.querySelector(".ca-map-none")?.textContent).toBe("No location");
  expect(mapTiles(el)).toEqual([]);
  // Its label is still the entity's name.
  expect(mapOf(el)?.getAttribute("aria-label")).toBe("Hall temperature");
});

test("a Map moves with its entity, and says so when the entity is no longer available", async () => {
  const { el, dispatch } = await mount(`page P { Map { of: sensor.car_location  zoom: 10 } }`);
  const moved = { latitude: 40.7128, longitude: -74.006 };
  await dom.act(() =>
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "sensor.car_location",
        new: state(
          "sensor.car_location",
          { domain: "sensor", value: "Away" },
          { attributes: moved },
        ),
      } as never,
    }),
  );
  expect(el.querySelector(".ca-map-credit")?.getAttribute("href")).toBe(
    "https://www.openstreetmap.org/?mlat=40.71280&mlon=-74.00600#map=10/40.71280/-74.00600",
  );
  // Without a heading the pin no longer points.
  expect(el.querySelector(".ca-map-pin")?.getAttribute("style")).toBeNull();
  await dom.act(() =>
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "sensor.car_location",
        new: state(
          "sensor.car_location",
          { domain: "sensor", value: "Away" },
          { attributes: moved, available: false },
        ),
      } as never,
    }),
  );
  expect(el.querySelector(".ca-map-none")?.textContent).toBe("No location");
});

test("the pretend panel's overrides replace an entity's value in the page's scope only", async () => {
  const { text, casa } = await mount(`page P {
    Text { value: sensor.hall_temp.value > 25 ? "hot" : "fine" }
  }`);
  expect(text()).toBe("fine");
  await dom.act(() => casa.setOverrides(new Map([["sensor.hall_temp", 30]])));
  expect(text()).toBe("hot");
  await dom.act(() => casa.setOverrides(new Map()));
  expect(text()).toBe("fine");
});

test("an area draws its facts, and a grid lays spans out", async () => {
  const { el } = await mount(`page P {
    Grid { columns: 3
      Area { of: area.hall  name: area.hall.name  span: 2
        Headline { of: sensor.hall_temp }
        Bar { of: light.hall  label: "Level" }
        Value { of: sensor.hall_temp  label: "Temp" }
        Status { of: lock.front }
      }
      Area { name: "Not in a room"  facts: false }
    }
  }`);
  const cells = el.querySelectorAll(".app-casa-grid > .app-casa-cell");
  expect(cells).toHaveLength(2);
  expect((cells[0] as HTMLElement).style.gridColumn).toBe("span 2");
  const room = el.querySelector(".ca-area");
  expect(room?.textContent).toContain("Hall");
  expect(room?.textContent).toContain("1 light on");
  expect(room?.textContent).toContain("Locked");
  expect(el.querySelector(".ca-widget-big")?.textContent).toBe("21.5");
  expect(el.querySelector(".ca-widget-unit")?.textContent).toBe("°C");
  expect(el.querySelector(".ca-widget-bar")?.textContent).toContain("Level");
  expect(el.querySelector(".ca-widget-stat dt")?.textContent).toBe("Temp");
});

test("an Area's cards are cells of the area's grid, and one with a span wider than the area takes the row", async () => {
  const { el } = await mount(`page P {
    Area { of: area.hall
      Card { name: "Wide"  span: 3  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Narrow"  Row { of: light.hall } Row { of: lock.front } }
    }
  }`);
  // Without a browser to measure the grid, the area reports one column, which every card
  // fills; in a browser the count follows the area's width, and only the wide card takes the row.
  const cells = [...el.querySelectorAll<HTMLElement>(".ca-area-grid > .app-casa-cell")];
  expect(cells.map((cell) => cell.style.gridColumn)).toEqual(["1 / -1", "1 / -1"]);
  expect(cells.map((cell) => cell.querySelector(".ca-widget-head")?.textContent)).toEqual([
    "Wide",
    "Narrow",
  ]);
});

test("a Grid carries its column count and gap on the element, for the rows a card lists in one", async () => {
  const { el } = await mount(`page P {
    Card { name: "Zones"
      Grid { columns: 1  gap: 4
        Row { of: light.hall }
        Row { of: switch.porch }
      }
      Grid {
        Text { value: "a" }
        Text { value: "b" }
      }
    }
  }`);
  const grids = el.querySelectorAll<HTMLElement>(".ca-widget-body .app-casa-grid");
  expect(grids).toHaveLength(2);
  expect(grids[0]?.dataset.columns).toBe("1");
  expect(grids[0]?.style.getPropertyValue("--casa-grid-gap")).toBe("4px");
  expect(grids[0]?.style.gap).toBe("var(--casa-grid-gap)");
  expect(grids[1]?.dataset.columns).toBe("2");
  expect(grids[1]?.style.getPropertyValue("--casa-grid-gap")).toBe("var(--casa-grid-row-gap)");
  // A given gap is both ways; without one, columns stand further apart than rows. The column
  // gap is on the element too, for the line between columns of rows.
  expect(grids[0]?.style.columnGap).toBe("var(--casa-grid-col-gap)");
  expect(grids[0]?.style.getPropertyValue("--casa-grid-col-gap")).toBe("var(--casa-grid-gap)");
  expect(grids[1]?.style.columnGap).toBe("var(--casa-grid-col-gap)");
  expect(grids[1]?.style.getPropertyValue("--casa-grid-col-gap")).toBe("var(--space-xl)");
  // Each row is a cell's node, where the stylesheet strips the line it brings.
  expect(grids[0]?.querySelectorAll(":scope > .app-casa-cell > .ca-row")).toHaveLength(2);
});

test("a grid without columns has one per child, up to three; a child's align places it in its cell", async () => {
  const { el } = await mount(`page P {
    Stack {
      Grid {
        Text { value: "a" }
        Text { value: "b"  align: .Center }
        Text { value: "c"  align: .End }
        Text { value: "d" }
      }
      Grid { columns: 2
        Text { value: "e" }
        Text { value: "f" }
      }
      Grid { columns: screen == .Phone ? 1 : 9
        Stack { align: .End  Text { value: "g" } }
      }
    }
  }`);
  const grids = el.querySelectorAll<HTMLElement>(".app-casa-grid");
  expect(grids).toHaveLength(3);
  // Four children, so three columns and a second row; the Grid's own cell is the Stack's.
  expect(grids[0]?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
  expect(grids[1]?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  // A computed count past three is clamped to three.
  expect(grids[2]?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
  const cells = grids[0]?.querySelectorAll<HTMLElement>(":scope > .app-casa-cell") ?? [];
  expect(Array.from(cells).map((cell) => cell.className)).toEqual([
    "app-casa-cell",
    "app-casa-cell app-casa-cell-center",
    "app-casa-cell app-casa-cell-end",
    "app-casa-cell",
  ]);
  // A Stack's `align` is its children's, so it fills its cell.
  expect(grids[2]?.querySelector(".app-casa-cell")?.className).toBe("app-casa-cell");
});

test("a row Stack keeps to one line unless it may wrap, and justify spreads its children", async () => {
  const { el } = await mount(`page P {
    Stack {
      Stack { direction: .Row  align: .Center  justify: .Between
        Text { value: "Exterior door" }
        Button { label: "Lock" }
      }
      Stack { direction: .Row  wrap: true  justify: .End  Text { value: "a" } }
      Stack { justify: .Center  wrap: true  Text { value: "b" } }
    }
  }`);
  const stacks = el.querySelectorAll<HTMLElement>(".app-casa-stack .app-casa-stack");
  expect(Array.from(stacks).map((s) => [s.className, s.style.justifyContent])).toEqual([
    ["app-casa-stack app-casa-stack-row", "space-between"],
    ["app-casa-stack app-casa-stack-row app-casa-stack-wrap", "flex-end"],
    // A column has nothing to wrap.
    ["app-casa-stack", "center"],
  ]);
});

test("a child's valign places it on its cell's height, on its own or with an align", async () => {
  const { el } = await mount(`page P {
    Grid { columns: 2
      Text { value: "a"  valign: .Center }
      Button { label: "b"  align: .End  valign: .Center }
      Text { value: "c"  valign: .Bottom }
      Stack { align: .End  valign: .Top  Text { value: "d" } }
    }
  }`);
  const cells = el.querySelectorAll<HTMLElement>(".app-casa-grid > .app-casa-cell");
  expect(Array.from(cells).map((cell) => cell.className)).toEqual([
    "app-casa-cell app-casa-cell-middle",
    "app-casa-cell app-casa-cell-end app-casa-cell-middle",
    "app-casa-cell app-casa-cell-bottom",
    // A Stack's `align` is its own, but its `valign` is still the cell's.
    "app-casa-cell app-casa-cell-top",
  ]);
});

test("a component in a grid is placed by its use's align and span, and a grid in a for is counted by its own children", async () => {
  const { el } = await mount(`
    component Tile(label: String) { Text { value: label  align: .End } }
    component Plain(label: String) { Text { value: label } }
    page P {
      Stack {
        Grid {
          Tile { label: "a" }
          Plain { label: "b"  align: .Center }
          Text { value: "c"  align: .Start }
        }
        Grid { columns: 3
          Plain { label: "d"  span: 2 }
          Plain { label: "e" }
        }
        for e in ["p", "q"] {
          Grid { key: e
            Text { value: "x" }
            Text { value: "y" }
          }
        }
      }
    }`);
  const grids = el.querySelectorAll<HTMLElement>(".app-casa-grid");
  expect(grids).toHaveLength(4);
  expect(grids[0]?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
  const cells = grids[0]?.querySelectorAll<HTMLElement>(":scope > .app-casa-cell") ?? [];
  // The node written in the Grid is the cell: a component's use places it, not its root,
  // whose own `align` is not in a Grid any more.
  expect(Array.from(cells).map((cell) => [cell.textContent, cell.className])).toEqual([
    ["a", "app-casa-cell"],
    ["b", "app-casa-cell app-casa-cell-center"],
    ["c", "app-casa-cell app-casa-cell-start"],
  ]);
  const spanned = grids[1]?.querySelectorAll<HTMLElement>(":scope > .app-casa-cell") ?? [];
  expect(Array.from(spanned).map((cell) => cell.style.gridColumn)).toEqual(["span 2", "span 1"]);
  // A Grid repeated by a for counts its own two children, not the loop's.
  expect(grids[2]?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  expect(grids[3]?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
});

test("a card through a for is drawn as a row while one item passes its where, and as a card otherwise", async () => {
  const { el, dispatch } = await mount(`page P {
    Card { name: "Lit"
      for e in area.hall.entities where e.domain != "lock" && e.domain != "sensor" && e.value == .On { Row { of: e } }
    }
  }`);
  const switchTo = (id: string, on: boolean) =>
    dom.act(() => {
      dispatch({
        type: "event",
        event: {
          type: "state_changed",
          entityId: id,
          new: state(id, { domain: id.split(".")[0], on }),
        } as never,
      });
    });
  // The light is the one lit entity: the card is its row, dimmer and all.
  expect(el.querySelector(".ca-ecard")?.getAttribute("aria-label")).toBe("Lit");
  expect(el.querySelector(".ca-ecard .app-ecard-dimmer")).not.toBeNull();
  expect(el.querySelector(".ca-widget")).toBeNull();

  await switchTo("switch.porch", true);
  expect(el.querySelector(".ca-ecard")).toBeNull();
  expect(el.querySelector(".ca-widget")?.getAttribute("aria-label")).toBe("Lit");
  expect(el.querySelectorAll(".ca-widget .ca-row")).toHaveLength(2);

  await switchTo("light.hall", false);
  expect(el.querySelector(".ca-widget")).toBeNull();
  // Now the porch is the one: a switch has no dimmer.
  expect(el.querySelector(".ca-ecard")?.getAttribute("aria-label")).toBe("Lit");
  expect(el.querySelector(".ca-ecard .app-ecard-dimmer")).toBeNull();
  expect(el.querySelector(".ca-ecard-summary")?.textContent).toBe("On");
});

test("a card's lone row stays a card when it is not of the loop's item, or has a when", async () => {
  const { el } = await mount(`page P {
    Stack {
      Card { name: "A"  for e in area.hall.entities where e.domain == "switch" { Row { of: lock.front } } }
      Card { name: "B"  Row { of: switch.porch  when: switch.porch.value == .On } }
    }
  }`);
  const cards = [...el.querySelectorAll(".ca-ecard, .ca-widget")];
  expect(cards.map((c) => `${c.className.split(" ")[0]} ${c.getAttribute("aria-label")}`)).toEqual([
    "ca-widget A",
    "ca-widget B",
  ]);
  expect(cards[0]?.querySelectorAll(".ca-row")).toHaveLength(1);
  // The porch is off, so B's only row is hidden and the card is empty.
  expect(cards[1]?.querySelectorAll(".ca-row")).toHaveLength(0);
});

test("dividers: false takes the lines out of a card's body", async () => {
  const { el } = await mount(`page P {
    Stack {
      Card { name: "Plain"  dividers: false
        Status { of: switch.porch }
        Row { of: light.hall }
      }
      Card { name: "Lined"
        Status { of: switch.porch }
        Row { of: light.hall }
      }
    }
  }`);
  const [plain, lined] = [...el.querySelectorAll(".ca-widget")];
  expect(plain?.className).toContain("ca-widget-undivided");
  expect(lined?.className).not.toContain("ca-widget-undivided");
});

test("an Area with an area, a name and an icon is headed by the bundled AreaHeader: its name alone", async () => {
  const { el } = await mount(`page P {
    Area { of: area.hall  name: area.hall.name  icon: "lock" }
  }`);
  const heading = el.querySelector(".app-casa-area .ca-area-heading");
  expect(heading?.textContent).toBe("Hall");
  // No icon beside it, and no count of devices and entities under it.
  expect(heading?.querySelector("svg.ca-icon")).toBeNull();
  expect(el.querySelector(".app-casa-area .ca-area-name")).toBeNull();
  expect(el.querySelector(".app-casa-area .ca-area-icon")).toBeNull();
});

test("an Area of an area is headed by its own name, with no name written", async () => {
  const { el } = await mount(`page P {
    Area { of: area.hall }
  }`);
  const area = el.querySelector(".app-casa-area");
  expect(area?.className).not.toContain("ca-area-bare");
  const heading = area?.querySelector(".ca-area-heading");
  expect(heading?.textContent).toBe("Hall");
  expect(heading?.querySelector("svg.ca-icon")).toBeNull();
  expect(area?.querySelector(".ca-area-facts")?.textContent).toContain("1 light on");
});

test("an Area's header: false is bare: no heading row, but its contents", async () => {
  const { el } = await mount(`page P {
    Area { of: area.hall  header: false
      Card { name: "Inside"  Row { of: light.hall } Row { of: lock.front } }
    }
  }`);
  const area = el.querySelector(".app-casa-area");
  expect(area?.className).toContain("ca-area-bare");
  expect(area?.querySelector(".ca-area-head")).toBeNull();
  expect(area?.querySelector(".ca-area-heading")).toBeNull();
  // No facts chips either, though facts are on by default and the hall has a light on.
  expect(area?.querySelector(".ca-area-facts")).toBeNull();
  expect(area?.textContent).not.toContain("1 light on");
  expect(area?.querySelector(".ca-widget-head")?.textContent).toBe("Inside");
});

test("an Area's name and icon replace the area's own, each on its own", async () => {
  const { el } = await mount(`page P {
    Stack {
      Area { of: area.hall  name: "The hall" }
      Area { of: area.hall  icon: "lock" }
    }
  }`);
  const [named, iconed] = [...el.querySelectorAll(".app-casa-area .ca-area-heading")];
  expect(named?.textContent).toBe("The hall");
  // An icon given still heads the area, though the bundled heading does not draw it.
  expect(iconed?.textContent).toBe("Hall");
  expect(iconed?.querySelector("svg.ca-icon")).toBeNull();
});

test("a Card's heading draws the active icon in the ink that reads on its accent", async () => {
  const { el } = await mount(`page P {
    Stack {
      Card { name: "Sky"  accent: accents.sky  active: true  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Lamp"  active: true  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Warn"  accent: palette.danger  active: true  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Off"  accent: accents.sky  active: false  Row { of: light.hall } Row { of: lock.front } }
    }
  }`);
  const boxes = [...el.querySelectorAll<HTMLElement>(".ca-widget-head .app-casa-icon-box")];
  expect(boxes.map((box) => box.style.color)).toEqual([
    "var(--accents-onSky)",
    "var(--accents-onLamp)",
    "var(--text-onAccent)",
    "var(--text-muted)",
  ]);
  expect(boxes[0]?.style.background).toContain("var(--accents-sky)");
});

test("a Card's heading draws its subtitle under the name, and nothing when there is none", async () => {
  const { el } = await mount(`page P {
    Stack {
      Card { name: "Oven"  subtitle: "Preheating"  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Plain"  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Blank"  subtitle: ""  Row { of: light.hall } Row { of: lock.front } }
    }
  }`);
  const heads = [...el.querySelectorAll<HTMLElement>(".ca-widget-head")];
  expect(heads.map((head) => head.textContent)).toEqual(["OvenPreheating", "Plain", "Blank"]);
  // The two lines stack under each other, beside the icon.
  const texts = heads[0]?.querySelectorAll(".ca-text-body") ?? [];
  expect(texts.length).toBe(2);
  expect(texts[1]?.textContent).toBe("Preheating");
  expect(heads[1]?.querySelectorAll(".ca-text-body").length).toBe(1);
});

test("a Card of a device opens the device's sheet from its heading; one of nothing has no button", async () => {
  const { el } = await mount(`page P {
    Stack {
      Card { name: "Car"  of: device.dev_porch  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Plain"  Row { of: light.hall } Row { of: lock.front } }
      Card { name: "Lone"  of: device.dev_porch  Row { of: switch.porch } }
    }
  }`);
  expect(el.querySelectorAll(".ca-widget-open").length).toBe(1);
  // The heading of nothing still takes the head's width, in a wrapper of its own.
  const plain = [...el.querySelectorAll<HTMLElement>(".ca-widget-head")][1];
  expect(plain?.querySelector(":scope > .app-casa-heading")?.textContent).toBe("Plain");
  expect(el.querySelector("[role=dialog]")).toBeNull();
  await dom.click(el.querySelector("[aria-label='Car details']"));
  const sheet = el.querySelector("[role=dialog]");
  expect(sheet?.textContent).toContain("Porch switch");
  expect(sheet?.textContent).toContain("dev_porch");
  await dom.key("Escape", document.body);
  expect(el.querySelector("[role=dialog]")).toBeNull();
  // The lone row's heading opens the device too, not its one entity.
  await dom.click(el.querySelector("[aria-label='Lone details']"));
  expect(el.querySelector("[role=dialog]")?.textContent).toContain("dev_porch");
});

test("an Area's header: names a component of the page to draw its heading instead", async () => {
  const { el } = await mount(`
    component MyHeader(of: Area) { Text { value: "custom " + of.name } }
    page P {
      Area { of: area.hall  header: MyHeader }
    }
  `);
  const heading = el.querySelector(".app-casa-area .ca-area-heading");
  expect(heading?.textContent).toBe("custom Hall");
  expect(heading?.querySelector(".app-casa-icon")).toBeNull();
});

test("an Area's header: is given the name and icon written on the Area, else the area's own", async () => {
  const { el } = await mount(`
    component Echo(of: Area, name: String, icon: String) {
      Text { value: of.name + "|" + (name ?? "none") + "|" + (icon ?? "none") }
    }
    page P {
      Stack {
        Area { of: area.hall  name: "Front"  icon: "lock"  header: Echo }
        Area { of: area.hall  header: Echo }
      }
    }
  `);
  const headings = [...el.querySelectorAll(".app-casa-area .ca-area-heading")];
  // Left out, the name and icon are the area's own.
  expect(headings[0]?.textContent).toBe("Hall|Front|lock");
  expect(headings[1]?.textContent).toMatch(/^Hall\|Hall\|[a-z-]+$/);
});

test("a shared RoomHeader still draws an Area's heading, as AreaHeader", async () => {
  const shared = 'component RoomHeader(of: Area) { Text { value: "old " + of.name } }';
  const { el } = await mount(
    `page P {\n  Area { of: area.hall  name: "Hall" }\n}`,
    1200,
    undefined,
    shared,
  );
  expect(el.querySelector(".app-casa-area .ca-area-heading")?.textContent).toBe("old Hall");
});

test("an Area in no area keeps the plain heading, with no component", async () => {
  const { el } = await mount(`page P {
    Area { name: "Elsewhere"  facts: false }
  }`);
  expect(el.querySelector(".app-casa-area .ca-area-heading")).toBeNull();
  expect(el.querySelector(".app-casa-area .ca-area-name")?.textContent).toBe("Elsewhere");
  // Given no icon, the plain heading has no icon box.
  expect(el.querySelector(".app-casa-area .ca-area-icon")).toBeNull();
});

test("an Area in no area is headed when given a name or an icon, drawing the name alone", async () => {
  const { el } = await mount(`page P {
    Stack {
      Area { name: "Elsewhere"  icon: "lock"  facts: false }
      Area { icon: "lock"  facts: false }
      Area { facts: false  Text { value: "loose" } }
    }
  }`);
  const [named, iconOnly, bare] = [...el.querySelectorAll(".app-casa-area")];
  expect(named?.querySelector(".ca-area-icon")).toBeNull();
  expect(named?.querySelector(".ca-area-name")?.textContent).toBe("Elsewhere");
  expect(iconOnly?.querySelector(".ca-area-head")).not.toBeNull();
  expect(iconOnly?.querySelector(".ca-area-icon")).toBeNull();
  expect(iconOnly?.querySelector(".ca-area-name")).toBeNull();
  expect(iconOnly?.getAttribute("aria-label")).toBeNull();
  expect(bare?.className).toContain("ca-area-bare");
  expect(bare?.querySelector(".ca-area-head")).toBeNull();
  expect(bare?.textContent).toContain("loose");
});

test("a Section is titled by SectionHeader, or by the component its header: names", async () => {
  const { el } = await mount(`
    component Other(title: String) { Text { value: "other " + title } }
    page P {
      Stack {
        Section { title: "Plain"  Text { value: "a" } }
        Section { title: "X"  header: Other  Text { value: "b" } }
      }
    }
  `);
  const titles = [...el.querySelectorAll(".app-casa-section-title")].map((t) => t.textContent);
  expect(titles).toEqual(["Plain", "other X"]);
});

// ───────── Scale and SunPath ─────────

const scaleOf = (el: HTMLElement) => el.querySelector<HTMLElement>("[role=meter]");
/** The CSS variables the track's gradient runs through, in order. */
const trackTones = (el: HTMLElement) =>
  [
    ...(el.querySelector(".ca-scale-track")?.getAttribute("style") ?? "").matchAll(/--scale-(\d)/g),
  ].map((m) => Number(m[1]));

test("a Scale shows the reading, its band's word, and the marker in its band", async () => {
  const { el } = await mount(`page P { Scale { of: sensor.pm25  scale: .PM25 } }`);
  expect(el.querySelector(".ca-scale-value")?.textContent).toBe("21 µg/m³");
  expect(el.querySelector(".ca-scale-word")?.textContent).toBe("Moderate");
  expect(el.querySelector(".ca-scale-word")?.className).toBe("ca-scale-word ca-scale-tone-2");
  // PM2.5's six bands, drawn as one track; 21 is in the second, which runs from 9 to 35.4.
  expect(el.querySelector(".ca-scale-band")).toBeNull();
  expect(trackTones(el)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(el.querySelector(".ca-scale-mark")).not.toBeNull();
  const position = (1 + (21 - 9) / (35.4 - 9)) / 6;
  expect(Number(scaleOf(el)?.getAttribute("aria-valuenow"))).toBeCloseTo(position);
  expect(scaleOf(el)?.getAttribute("aria-valuetext")).toBe("21 µg/m³, Moderate");
});

test("a Scale is labelled with its scale's title, not the entity's name", async () => {
  const { el } = await mount(`page P { Scale { of: sensor.pm25  scale: .PM25 } }`);
  // The entity is called "Particles".
  expect(el.querySelector(".ca-scale-label")?.textContent).toBe("PM2.5");
  expect(scaleOf(el)?.getAttribute("aria-label")).toBe("PM2.5");
});

test.each([
  [".UV", "UV index"],
  [".PM10", "PM10"],
  [".AQI", "Air quality"],
  [".EAQI", "Air quality"],
])("a Scale on %s is titled %p", async (scale, title) => {
  const { el } = await mount(`page P { Scale { of: sensor.pm25  scale: ${scale} } }`);
  expect(el.querySelector(".ca-scale-label")?.textContent).toBe(title);
});

test("a Scale's label replaces the scale's title, and its scale picks the bands", async () => {
  const { el } = await mount(`page P { Scale { of: sensor.pm25  scale: .AQI  label: "Air" } }`);
  expect(el.querySelector(".ca-scale-label")?.textContent).toBe("Air");
  // On the AQI, 21 is Good.
  expect(el.querySelector(".ca-scale-word")?.textContent).toBe("Good");
  expect(Number(scaleOf(el)?.getAttribute("aria-valuenow"))).toBeLessThan(1 / 6);
});

test("a Scale of an attribute reads the attribute's value", async () => {
  const { el } = await mount(`page P { Scale { of: weather.home#uvIndex  scale: .UV } }`);
  expect(el.querySelector(".ca-scale-value")?.textContent).toBe("4.5");
  expect(el.querySelector(".ca-scale-word")?.textContent).toBe("Moderate");
  expect(el.querySelector(".ca-scale-label")?.textContent).toBe("UV index");
  expect(trackTones(el)).toEqual([1, 2, 3, 4, 5]);
});

test("a Scale of an unavailable sensor shows a dash, with no marker or word", async () => {
  const { el } = await mount(`page P { Scale { of: sensor.pm10  scale: .PM10 } }`);
  expect(el.querySelector(".ca-scale-value")?.textContent).toBe("—");
  expect(el.querySelector(".ca-scale-mark")).toBeNull();
  expect(el.querySelector(".ca-scale-word")).toBeNull();
  // The track is still drawn, and the label is still the scale's.
  expect(trackTones(el)).toHaveLength(6);
  expect(el.querySelector(".ca-scale-label")?.textContent).toBe("PM10");
  expect(scaleOf(el)?.className).toBe("ca-scale ca-scale-none");
});

test("a Scale of a word, not a number, is a dash too", async () => {
  const { el } = await mount(`page P { Scale { of: sensor.car_location  scale: .AQI } }`);
  expect(el.querySelector(".ca-scale-value")?.textContent).toBe("—");
  expect(el.querySelector(".ca-scale-mark")).toBeNull();
});

test("a Scale follows its sensor's reading", async () => {
  const { el, dispatch } = await mount(`page P { Scale { of: sensor.pm25  scale: .PM25 } }`);
  await dom.act(() =>
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "sensor.pm25",
        new: state("sensor.pm25", { domain: "sensor", value: 60, unit: "µg/m³" }),
      } as never,
    }),
  );
  expect(el.querySelector(".ca-scale-word")?.textContent).toBe("Unhealthy");
  expect(el.querySelector(".ca-scale-word")?.className).toBe("ca-scale-word ca-scale-tone-4");
});

afterEach(() => setSystemTime());

test("a SunPath draws the times from the weather's daily forecast, in its zone", async () => {
  // Half way through Monday's daylight: 12:57 pm in Seattle.
  setSystemTime(new Date((SUNRISE + SUNSET) / 2));
  const { el } = await mount(`page P { SunPath { weather: weather.home } }`);
  expect([...el.querySelectorAll(".ca-sun-time")].map((t) => t.textContent)).toEqual([
    "7:12 am",
    "6:42 pm",
  ]);
  expect(el.querySelector(".ca-sun-headline")?.textContent).toBe("Sunset in 5h 45m");
  // The weather says where the house is, so the sun's angle follows the daylight.
  expect([...el.querySelectorAll(".ca-sun-detail")].map((d) => d.textContent)).toEqual([
    "11h 30m of daylight",
    expect.stringMatching(/^· Sun \d+° up$/),
  ]);
  expect(el.querySelector(".ca-sun-dot")?.className).toBe("ca-sun-dot ca-sun-dot-up");
  // The sun is placed at the house's time of day, not UTC's.
  const left = Number.parseFloat(el.querySelector<HTMLElement>(".ca-sun-dot")?.style.left ?? "");
  expect(left).toBeCloseTo(((12 * 60 + 57) / 1440) * 100);
  expect(el.querySelector(".ca-sun")?.getAttribute("aria-label")).toBe(
    "Sunset in 5h 45m. Sunrise 7:12 am, sunset 6:42 pm.",
  );
});

test("a SunPath at night has the sun down, and counts down to tomorrow's sunrise", async () => {
  setSystemTime(new Date(SUNSET + 60 * 60_000));
  const { el } = await mount(`page P { SunPath { weather: weather.home  label: "The sun" } }`);
  expect(el.querySelector(".ca-sun")?.className).toBe("ca-sun ca-sun-night");
  expect(el.querySelector(".ca-sun")?.getAttribute("aria-label")).toBe("The sun");
  expect(el.querySelector(".ca-sun-dot")?.className).toBe("ca-sun-dot ca-sun-dot-down");
  // Still today's times, until the house's midnight.
  expect(el.querySelector(".ca-sun-time")?.textContent).toBe("7:12 am");
  expect(el.querySelector(".ca-sun-headline")?.textContent).toBe("Sunrise in 11h 31m");
  // An hour after sunset the sun is several degrees down.
  expect(el.querySelector(".ca-sun-detail:last-child")?.textContent).toMatch(/^· Sun \d+° down$/);
});

test("a SunPath draws nothing once its forecast has run out", async () => {
  setSystemTime(new Date(Date.UTC(2026, 9, 9)));
  const { el } = await mount(`page P { Stack { SunPath { weather: weather.home } } }`);
  expect(el.querySelector(".ca-sun")).toBeNull();
});

test("a Greeting under a known sky draws its weather behind the header", async () => {
  const { el } = await mount(`page P { Greeting { weather: weather.home } }`);
  const head = el.querySelector("header.app-casa-greeting");
  expect(head?.classList.contains("ca-wx-host")).toBe(true);
  expect(head?.querySelector("canvas")?.classList.contains("ca-wx-back")).toBe(true);
  expect(head?.querySelectorAll("canvas.ca-wx").length).toBe(2);
});

test("a Greeting with no current temperature draws no weather, and its header hosts none", async () => {
  const { el, dispatch } = await mount(`page P { Greeting {} }`);
  // A Greeting given no weather still finds the house's; then the reading goes.
  expect(el.querySelector("header canvas.ca-wx")).not.toBeNull();
  await dom.act(() => {
    dispatch({
      type: "event",
      event: {
        type: "state_changed",
        entityId: "weather.home",
        new: state("weather.home", { domain: "weather", condition: "rain" }),
      } as never,
    });
  });
  const head = el.querySelector("header.app-casa-greeting");
  expect(head).not.toBeNull();
  expect(head?.classList.contains("ca-wx-host")).toBe(false);
  expect(head?.querySelector("canvas")).toBeNull();
});
