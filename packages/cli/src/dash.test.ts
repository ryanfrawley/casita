import { expect, test } from "bun:test";
import { setUnits } from "@casita/client";
import { type DashData, type DashHistory, type DashUi, hitAt, render } from "./dash.ts";
import type { Row } from "./present.ts";
import { c, setColor, strip, width } from "./style.ts";

setColor(false);
const NOW = Date.UTC(2026, 9, 4, 2, 42);

function house(): DashData {
  const entity = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    name,
    uniqueId: id,
    domain: id.split(".")[0],
    integrationId: "zigbee2mqtt.main",
    controllable: !["sensor", "binary_sensor"].includes(id.split(".")[0] ?? ""),
    capabilities: {},
    ...extra,
  });
  const entities = [
    entity("light.k_ceiling", "Ceiling light", {
      effectiveAreaId: "kitchen",
      capabilities: { brightness: true },
    }),
    entity("light.k_island", "Island", { effectiveAreaId: "kitchen" }),
    entity("switch.k_dish", "Dishwasher", { effectiveAreaId: "kitchen", controllable: false }),
    entity("cover.garage", "Garage door", { effectiveAreaId: "outside" }),
    entity("binary_sensor.porch", "Porch motion", { effectiveAreaId: "outside" }),
    entity("sensor.attic", "Attic temperature", { deviceId: "d-attic" }),
    entity("light.secret", "Hidden light", { effectiveAreaId: "kitchen", hidden: true }),
    entity("climate.hallway", "Hallway", {
      capabilities: { tempRange: { min: 10, max: 30, step: 0.5 } },
    }),
    entity("lock.front_door", "Front door"),
    entity("lock.back_door", "Back door"),
    entity("lock.side_gate", "Side gate"),
    entity("switch.lawn", "Rachio Lawn", {
      integrationId: "rachio.main",
      deviceId: "d-rachio",
      uniqueId: "zone-1",
    }),
    entity("switch.schedules", "Rachio schedules", {
      integrationId: "rachio.main",
      deviceId: "d-rachio",
      uniqueId: "dev-1-enabled",
    }),
    entity("sensor.car_battery", "Car battery", {
      integrationId: "teslamate.main",
      deviceId: "d-car",
      uniqueId: "teslamate-1-battery_level",
    }),
  ];
  const state = (s: Row, extra: Row = {}) => ({
    state: s,
    available: true,
    changedAt: NOW - 240_000,
    ...extra,
  });
  const states = new Map<string, Row>([
    ["light.k_ceiling", state({ domain: "light", on: true, brightness: 0.6 })],
    ["light.k_island", state({ domain: "light", on: false })],
    ["switch.k_dish", state({ domain: "switch", on: true })],
    [
      "cover.garage",
      state({ domain: "cover", motion: "stopped", position: 0 }, { available: false }),
    ],
    ["binary_sensor.porch", state({ domain: "binary_sensor", on: false, deviceClass: "motion" })],
    ["sensor.attic", state({ domain: "sensor", value: 31.2, unit: "°C" })],
    [
      "climate.hallway",
      state({ domain: "climate", mode: "heat", currentTemp: 21.5, targetTemp: 21 }),
    ],
    ["lock.front_door", state({ domain: "lock", locked: true })],
    ["lock.back_door", state({ domain: "lock", locked: false })],
    ["lock.side_gate", state({ domain: "lock", locked: false, jammed: true })],
    [
      "switch.lawn",
      state({ domain: "switch", on: true }, { attributes: { endsAt: NOW + 6 * 60_000 } }),
    ],
    ["switch.schedules", state({ domain: "switch", on: true })],
    ["sensor.car_battery", state({ domain: "sensor", value: 68, unit: "%" })],
  ]);
  return {
    entities,
    states,
    areas: [
      { id: "outside", name: "Outside" },
      { id: "kitchen", name: "Kitchen" },
    ],
    devices: [
      { id: "d-attic", name: "Attic sensor", integrationId: "zigbee2mqtt.main" },
      { id: "d-rachio", name: "Rachio", integrationId: "rachio.main" },
      { id: "d-car", name: "Terry", model: "Model Y", integrationId: "teslamate.main" },
    ],
    integrations: [
      { integrationId: "zigbee2mqtt.main", status: "running" },
      { integrationId: "rachio.main", status: "running" },
    ],
  };
}

const ui = (extra: Partial<DashUi> = {}): DashUi => ({
  cols: 120,
  now: NOW,
  pane: "left",
  index: 0,
  filter: "",
  filtering: false,
  pending: new Map(),
  status: "",
  recent: [],
  connected: true,
  ...extra,
});
const text = (data: DashData, state: DashUi) => render(data, state).lines.join("\n");

test("rooms come first in name order, then devices not in a room; hidden entities are left out", () => {
  const frame = render(house(), ui());
  const titles = frame.lines.flatMap((line) =>
    [...line.matchAll(/┌ ([^─]+?) ─/g)].map((m) => m[1]),
  );
  expect(titles).toEqual([
    "Kitchen · 1 light on · 2 controls",
    "Thermostat · Hallway",
    "Locks · 2 unlocked",
    "Outside · 1 control",
    "Attic sensor · 1 reading",
    "Terry · Model Y",
    "Irrigation · schedules on",
  ]);
  expect(frame.lines.join("\n")).not.toContain("Hidden light");
  expect(frame.left.map((i) => i.entityId)).toEqual([
    "light.k_ceiling",
    "light.k_island",
    "switch.k_dish",
    "cover.garage",
    "binary_sensor.porch",
    "sensor.attic",
  ]);
  expect(frame.right).toEqual([
    { entityId: "climate.hallway", kind: "climate" },
    { entityId: "lock.front_door", kind: "lock" },
    { entityId: "lock.back_door", kind: "lock" },
    { entityId: "lock.side_gate", kind: "lock" },
    { entityId: "sensor.car_battery", kind: "car" },
    { entityId: "switch.lawn", kind: "zone" },
  ]);
});

test("every line fits the terminal, at several widths", () => {
  for (const cols of [100, 120, 160, 80, 60]) {
    const frame = render(house(), ui({ cols }));
    expect(Math.max(...frame.lines.map(width))).toBeLessThanOrEqual(cols);
  }
});

test("rows show state, level, view-only, unavailable, and how long ago", () => {
  const out = text(house(), ui());
  expect(out).toMatch(/▸ Ceiling light +light\.k_ceiling +On · 60% +██████░░░░/);
  expect(out).toMatch(/ {3}Island +light\.k_island +Off/);
  expect(out).toMatch(/Dishwasher +switch\.k_dish +On {2}view only/);
  expect(out).toMatch(/Garage door +cover\.garage +Unavailable ╱╱ was Closed/);
  expect(out).toMatch(/Porch motion +binary_sensor\.porch +Clear · 4 min/);
});

test("the header summarizes locks, lights, and the thermostat", () => {
  const [first, second] = render(house(), ui()).lines;
  expect(first).toMatch(/^casita · home · Good \w+ +\w{3} \d{1,2} \w{3} · \d{1,2}:\d\d [ap]m$/);
  expect(second).toStartWith("Locks ▲ 1 jammed   Lights 1 on   Hallway 21.5°C heat");

  const data = house();
  data.states.set("lock.side_gate", { state: { domain: "lock", locked: true }, available: true });
  expect(render(data, ui()).lines[1]).toStartWith("Locks ○ 1 unlocked");
  data.states.set("lock.back_door", { state: { domain: "lock", locked: true }, available: true });
  expect(render(data, ui()).lines[1]).toStartWith("Locks ● all locked");
});

test("the cards: thermostat, locks with their keys and a jam explanation, car, irrigation", () => {
  const out = text(house(), ui());
  expect(out).toMatch(/21\.5°C {2}Heat · holding 21°/);
  expect(out).toMatch(/ target 21° +mode heat {2}cool {2}auto {2}off/);
  expect(out).toMatch(/Front door +● Locked +u {2}unlock/);
  expect(out).toMatch(/Back door +○ Unlocked +l {2}lock/);
  expect(out).toMatch(/Side gate +▲ Jammed +r {2}retry/);
  expect(out).toContain("The side gate didn't finish turning.");
  expect(out).toMatch(/\[█+░+\] 68%/);
  expect(out).toMatch(/Lawn +Watering · 6 min left/); // the controller's name is dropped from the zone
});

test("the cursor marks one row, in either pane", () => {
  const cursorLines = (state: DashUi) =>
    render(house(), state).lines.filter((l) => l.includes("▸"));
  expect(cursorLines(ui({ index: 1 }))).toHaveLength(1);
  expect(cursorLines(ui({ index: 1 }))[0]).toContain("▸ Island");
  expect(cursorLines(ui({ pane: "right", index: 0 }))[0]).toContain("▸ 21.5°C");
  expect(cursorLines(ui({ pane: "right", index: 3 }))[0]).toContain("▸ Side gate");
  expect(cursorLines(ui({ pane: "right", index: 4 }))[0]).toContain("▸ [█");
  expect(cursorLines(ui({ pane: "right", index: 5 }))[0]).toContain("▸ Lawn");
});

test("a command in flight shows on its row; the status line and integration health are at the bottom", () => {
  const pending = new Map([["light.k_island", "Turning on…"]]);
  const frame = render(house(), ui({ pending, status: "◐ light.k_island: command sent" }));
  expect(frame.lines.join("\n")).toMatch(/Island +light\.k_island +◐ Turning on… +waiting…/);
  expect(frame.lines.at(-2)).toMatch(
    /^◐ light\.k_island: command sent +core connected · 2 integrations ok$/,
  );

  const data = house();
  data.integrations[1] = { integrationId: "rachio.main", status: "error" };
  expect(render(data, ui()).lines.at(-2)).toContain("▲ rachio.main not running");
  expect(render(house(), ui({ connected: false })).lines.at(-2)).toContain("▲ disconnected");
});

test("the filter narrows rows by name or id, and says so when nothing matches", () => {
  const frame = render(house(), ui({ filter: "island" }));
  expect(frame.left.map((i) => i.entityId)).toEqual(["light.k_island"]);
  expect(frame.right).toEqual([]);
  expect(render(house(), ui({ filter: "lock." })).right.map((i) => i.kind)).toEqual([
    "lock",
    "lock",
    "lock",
  ]);
  expect(text(house(), ui({ filter: "zzz" }))).toContain("Nothing matches · zzz");
  expect(render(house(), ui({ filter: "isl", filtering: true })).lines.at(-1)).toStartWith(
    "filter: isl▏",
  );
});

test("recent events list newest first with how long ago", () => {
  const recent = [
    { text: "Front door locked", at: NOW - 6 * 60_000 },
    { text: "Motion on the porch", at: NOW - 20_000 },
  ];
  const out = text(house(), ui({ recent }));
  expect(out).toMatch(/Front door locked +6 min ago/);
  expect(out).toMatch(/Motion on the porch +just now/);
});

test("a short terminal scrolls to keep the cursor in view and fills the height exactly", () => {
  const top = render(house(), ui({ rows: 14 }));
  expect(top.lines).toHaveLength(14);
  expect(top.lines.join("\n")).toContain("▸ Ceiling light");
  const bottom = render(house(), ui({ rows: 14, index: 5 }));
  expect(bottom.lines).toHaveLength(14);
  expect(bottom.lines.join("\n")).toContain("▸ Attic temperature");
  expect(bottom.lines.join("\n")).not.toContain("Ceiling light");
  // The header and the key hints stay put.
  expect(bottom.lines[0]).toStartWith("casita");
  expect(bottom.lines.at(-1)).toContain("quit");
});

test("a narrow terminal stacks the cards under the rooms", () => {
  const frame = render(house(), ui({ cols: 80 }));
  const kitchen = frame.lines.findIndex((l) => l.includes("Kitchen ·"));
  const thermostat = frame.lines.findIndex((l) => l.includes("Thermostat ·"));
  expect(thermostat).toBeGreaterThan(kitchen + 3);
  expect(frame.lines[kitchen]).not.toContain("Thermostat");
});

test("the detail view shows everything known about one entity", () => {
  const out = text(house(), ui({ detail: "light.k_ceiling" }));
  expect(out).toContain("Ceiling light · light.k_ceiling");
  expect(out).toMatch(/State +On · 60%/);
  expect(out).toContain('{"domain":"light","on":true,"brightness":0.6}');
  expect(out).toMatch(/Area +Kitchen/);
  expect(out).toMatch(/Integration +zigbee2mqtt\.main/);
  expect(out).toContain("Press any key to go back.");
  expect(text(house(), ui({ detail: "light.gone" }))).toContain("That entity is gone.");
});

test("an empty house says what to do next", () => {
  const empty: DashData = {
    entities: [],
    devices: [],
    areas: [],
    states: new Map(),
    integrations: [],
  };
  expect(text(empty, ui())).toContain("Nothing to show yet. Add an integration");
});

// ───────── layout invariants ─────────

/** The house, plus names and ids long enough to overflow anything that does not cut them. */
function crowded(): DashData {
  const data = house();
  const long = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    name,
    uniqueId: id,
    domain: id.split(".")[0],
    integrationId: "zigbee2mqtt.main",
    controllable: true,
    ...extra,
  });
  data.entities.push(
    long(
      "light.an_extremely_long_entity_identifier_that_goes_on_and_on",
      "🚗 A very very very long friendly name for the garage lamp",
      { effectiveAreaId: "kitchen" },
    ),
    long("climate.another_long_thermostat_identifier", "A thermostat with a very long name indeed"),
    long("lock.long", "A lock with an exceedingly long and verbose descriptive name"),
    long("sensor.far", "Far", { effectiveAreaId: "far", controllable: false }),
  );
  data.areas.push({ id: "far", name: "An area whose name will never fit in a narrow terminal" });
  data.states.set("light.an_extremely_long_entity_identifier_that_goes_on_and_on", {
    state: { domain: "light", on: true, brightness: 0.25 },
    available: true,
  });
  return data;
}

// Widths sampled across 40..200, with the narrow/wide switch at 100 and odd sizes either side.
const SOME_COLS = [40, 41, 47, 52, 59, 63, 71, 80, 87, 99, 100, 101, 113, 127, 150, 173, 199, 200];

test("no line is wider than the terminal, from 40 to 200 columns, in color or not", () => {
  const recent = [{ text: "x".repeat(300), at: NOW - 3 * 60_000 }];
  for (const color of [false, true]) {
    setColor(color);
    for (const cols of SOME_COLS) {
      for (const state of [
        ui({ cols, recent }),
        ui({ cols, pane: "right", index: 2, pending: new Map([["lock.back_door", "Locking…"]]) }),
        ui({ cols, detail: "light.an_extremely_long_entity_identifier_that_goes_on_and_on" }),
        ui({ cols, filter: "zzz", filtering: true }),
      ]) {
        const widest = Math.max(...render(crowded(), state).lines.map(width));
        expect(widest).toBeLessThanOrEqual(cols);
      }
    }
  }
  setColor(false);
});

test("with a height, the frame is exactly that many lines and the cursor is always on screen", () => {
  const data = house();
  const counts = { left: render(data, ui()).left.length, right: render(data, ui()).right.length };
  expect(counts).toEqual({ left: 6, right: 6 });
  for (const rows of [9, 10, 11, 12, 13, 16, 21, 30, 44, 60]) {
    for (const cols of [60, 120]) {
      for (const pane of ["left", "right"] as const) {
        for (let index = 0; index < counts[pane]; index++) {
          const { lines } = render(data, ui({ rows, cols, pane, index }));
          expect(lines).toHaveLength(rows);
          expect(lines.filter((l) => l.includes("▸"))).toHaveLength(1);
        }
      }
    }
  }
});

test("a terminal shorter than nine rows still gets exactly its height", () => {
  // The header (3) and footer (3) take six rows and the body is never fewer than three, so
  // an 8-row terminal is sent 9 lines and scrolls.
  for (const rows of [6, 7, 8]) {
    expect(render(house(), ui({ rows })).lines).toHaveLength(rows);
  }
});

test("without a height, nothing is cut or padded", () => {
  const all = render(house(), ui());
  expect(all.lines.at(-1)).toContain("quit");
  expect(all.lines.join("\n")).toContain("Irrigation");
});

// ───────── the cursor and the panes ─────────

test("an index beyond the list draws no cursor and does not break the layout", () => {
  for (const pane of ["left", "right"] as const) {
    const frame = render(house(), ui({ pane, index: 99, rows: 20 }));
    expect(frame.lines).toHaveLength(20);
    expect(frame.lines.join("\n")).not.toContain("▸");
  }
});

test("a pane with nothing in it offers no items and draws no cursor", () => {
  const data = house();
  data.entities = data.entities.filter(
    (e) =>
      !["climate", "lock"].includes(String(e.domain)) &&
      e.integrationId !== "rachio.main" &&
      e.integrationId !== "teslamate.main",
  );
  const frame = render(data, ui({ pane: "right", index: 0 }));
  expect(frame.right).toEqual([]);
  expect(frame.lines.join("\n")).not.toContain("▸");
  expect(frame.left.length).toBeGreaterThan(0);
});

test("every climate gets its own thermostat card, in order, and is selectable", () => {
  const data = house();
  for (const n of [2, 3, 4, 5]) {
    data.entities.push({
      id: `climate.room_${n}`,
      name: `Room ${n}`,
      domain: "climate",
      uniqueId: `c${n}`,
      controllable: true,
    });
    data.states.set(`climate.room_${n}`, {
      state: { domain: "climate", mode: "cool", currentTemp: 20 + n, targetTemp: 18 },
      available: true,
    });
  }
  const frame = render(data, ui({ pane: "right", index: 3 }));
  expect(frame.right.filter((i) => i.kind === "climate").map((i) => i.entityId)).toEqual([
    "climate.hallway",
    "climate.room_2",
    "climate.room_3",
    "climate.room_4",
    "climate.room_5",
  ]);
  const out = frame.lines.join("\n");
  expect(out.match(/Thermostat · /g)).toHaveLength(5);
  expect(frame.lines.find((l) => l.includes("▸"))).toContain("▸ 24°C  Cool · holding 18°");
});

test("a climate with no state shows dashes and Off", () => {
  const data = house();
  data.states.delete("climate.hallway");
  const out = text(data, ui());
  expect(out).toMatch(/— {2}Off/);
  expect(out).toMatch(/ target — /);
});

// ───────── what goes where ─────────

test("a lock on a car's device is the car's, not one of the house's locks", () => {
  const data = house();
  data.entities.push({
    id: "lock.terry_doors",
    name: "Terry doors",
    domain: "lock",
    deviceId: "d-car",
    uniqueId: "teslamate-1-locked",
    integrationId: "teslamate.main",
    controllable: true,
  });
  data.states.set("lock.terry_doors", {
    state: { domain: "lock", locked: false },
    available: true,
  });
  const frame = render(data, ui());
  expect(frame.right.map((i) => i.entityId)).not.toContain("lock.terry_doors");
  expect(frame.left.map((i) => i.entityId)).not.toContain("lock.terry_doors");
  expect(frame.lines.join("\n")).not.toContain("Terry doors");
  // The header's count is the house's: the car being unlocked does not add to it.
  expect(frame.lines[1]).toStartWith("Locks ▲ 1 jammed");
  expect(frame.lines.join("\n")).toContain("Locks · 2 unlocked");
});

test("an entity whose area does not exist falls back to its device, then to Other", () => {
  const data = house();
  data.entities.push(
    { id: "sensor.ghost", name: "Ghost", domain: "sensor", effectiveAreaId: "nowhere" },
    {
      id: "sensor.attic_humidity",
      name: "Attic humidity",
      domain: "sensor",
      effectiveAreaId: "nowhere",
      deviceId: "d-attic",
    },
  );
  const out = text(data, ui());
  expect(out).toMatch(/Other · 1 reading/);
  expect(out).toMatch(/Ghost +sensor\.ghost +No state yet/);
  expect(out).toMatch(/Attic sensor · 2 readings/);
});

test("rachio zones still show when the controller device is missing, under their full name", () => {
  const data = house();
  data.devices = data.devices.filter((d) => d.id !== "d-rachio");
  const frame = render(data, ui({ pane: "right", index: 5 }));
  expect(frame.right.at(-1)).toEqual({ entityId: "switch.lawn", kind: "zone" });
  expect(frame.lines.join("\n")).toMatch(/▸ Rachio Lawn +Watering · 6 min left/);
});

test("rachio's schedule switch and rain delay are card details, not zones", () => {
  const data = house();
  data.entities.push({
    id: "binary_sensor.rain",
    name: "Rachio rain delay",
    domain: "binary_sensor",
    uniqueId: "dev-1-rain-delay",
    deviceId: "d-rachio",
    integrationId: "rachio.main",
    controllable: true,
  });
  data.states.set("binary_sensor.rain", {
    state: { domain: "binary_sensor", on: true },
    available: true,
  });
  data.states.set("switch.schedules", { state: { domain: "switch", on: false }, available: true });
  const frame = render(data, ui());
  expect(frame.right.filter((i) => i.kind === "zone").map((i) => i.entityId)).toEqual([
    "switch.lawn",
  ]);
  expect(frame.lines.join("\n")).toContain("Irrigation · standby · rain delay");
});

test("a zone with no end time waters without a countdown; a past end time reads 0", () => {
  const data = house();
  data.states.set("switch.lawn", { state: { domain: "switch", on: true }, available: true });
  expect(text(data, ui())).toMatch(/Lawn +Watering +│/);
  data.states.set("switch.lawn", {
    state: { domain: "switch", on: true },
    available: true,
    attributes: { endsAt: NOW - 60_000 },
  });
  expect(text(data, ui())).toContain("Watering · 0 min left");
});

test("only the five newest recent events are listed", () => {
  const recent = Array.from({ length: 8 }, (_, i) => ({
    text: `Event ${i}`,
    at: NOW - i * 60_000,
  }));
  const out = text(house(), ui({ recent }));
  for (const i of [0, 1, 2, 3, 4]) expect(out).toContain(`Event ${i}`);
  for (const i of [5, 6, 7]) expect(out).not.toContain(`Event ${i}`);
});

test("recent events past six hours show a clock time without 'ago'", () => {
  const recent = [{ text: "Garage door closed", at: NOW - 7 * 3_600_000 }];
  const out = text(house(), ui({ recent }));
  expect(out).toMatch(/Garage door closed +7:42 pm/);
  expect(out).not.toContain("pm ago");
});

test("the detail view of an entity with no state says so and leaves the rest blank", () => {
  const data = house();
  data.states.delete("light.k_island");
  const out = text(data, ui({ detail: "light.k_island" }));
  expect(out).toMatch(/State +No state yet/);
  expect(out).toMatch(/Raw +—/);
  expect(out).toMatch(/Changed +—/);
  expect(out).toMatch(/Device +—/);
  expect(out).toMatch(/Area +Kitchen/);
});

test("the detail view names the device and its model", () => {
  const out = text(house(), ui({ detail: "sensor.car_battery" }));
  expect(out).toMatch(/Device +Terry \(Model Y\)/);
  expect(out).toMatch(/Controls +view only/);
});

// ───────── filter ─────────

test("a filter that matches only a card leaves the rooms empty without saying nothing matches", () => {
  const frame = render(house(), ui({ filter: "hallway" }));
  expect(frame.left).toEqual([]);
  expect(frame.right).toEqual([{ entityId: "climate.hallway", kind: "climate" }]);
  expect(frame.lines.join("\n")).not.toContain("Nothing matches");
});

test("a filter on the car's name shows just the car card", () => {
  const frame = render(house(), ui({ filter: "terry" }));
  expect(frame.left).toEqual([]);
  expect(frame.right).toEqual([{ entityId: "sensor.car_battery", kind: "car" }]);
  const out = frame.lines.join("\n");
  expect(out).toContain("Terry · Model Y");
  expect(out).not.toContain("Nothing matches");
});

test("the filter is case-insensitive", () => {
  expect(render(house(), ui({ filter: "ISLAND" })).left.map((i) => i.entityId)).toEqual([
    "light.k_island",
  ]);
});

// ───────── header and footer ─────────

test("with no integrations the footer says zero are ok", () => {
  const data = house();
  data.integrations = [];
  expect(render(data, ui()).lines.at(-2)).toMatch(/core connected · 0 integrations ok$/);
});

test("one integration reads in the singular; several broken ones are all named", () => {
  const data = house();
  data.integrations = [{ integrationId: "zigbee2mqtt.main", status: "running" }];
  expect(render(data, ui()).lines.at(-2)).toMatch(/1 integration ok$/);
  data.integrations = [
    { integrationId: "a.main", status: "error" },
    { integrationId: "b.main", status: "starting" },
  ];
  expect(render(data, ui()).lines.at(-2)).toContain("▲ a.main, b.main not running");
});

test("the header shows the outside temperature from a house sensor, not a car's", () => {
  const data = house();
  data.entities.push(
    { id: "sensor.terry_outside_temp", name: "Terry outside", domain: "sensor", deviceId: "d-car" },
    { id: "sensor.outdoor", name: "Outdoor", domain: "sensor", effectiveAreaId: "outside" },
  );
  data.states.set("sensor.terry_outside_temp", {
    state: { domain: "sensor", value: 30, deviceClass: "temperature" },
    available: true,
  });
  expect(render(data, ui()).lines[1]).not.toContain("Outside");
  data.states.set("sensor.outdoor", {
    state: { domain: "sensor", value: 12.34, deviceClass: "temperature" },
    available: true,
  });
  expect(render(data, ui()).lines[1]).toMatch(/Outside 12\.3°C$/);
});

test("hidden lights and thermostats are left out of the header, as they are from the rooms", () => {
  // Today a hidden light that is on makes the header say "Lights 2 on" while the kitchen card
  // says "1 light on", and a hidden thermostat listed first takes the header's thermostat slot.
  const data = house();
  data.states.set("light.secret", { state: { domain: "light", on: true }, available: true });
  data.entities.unshift({
    id: "climate.hidden",
    name: "Hidden stat",
    domain: "climate",
    hidden: true,
  });
  const header = render(data, ui()).lines[1] ?? "";
  expect(header).toStartWith("Locks ▲ 1 jammed   Lights 1 on   Hallway 21.5°C heat");
});

test("at the narrowest supported width (40 columns) every room row still shows its state", () => {
  // The name (up to 22) and id (at least 12) columns are fixed before the state's, so below
  // about 52 columns the state is cut off entirely: "▸ Ceiling light   light.k_ce…" and nothing
  // about whether it is on.
  const data = house();
  data.entities.push({
    id: "light.long",
    name: "A rather long lamp name here",
    domain: "light",
    effectiveAreaId: "kitchen",
    controllable: true,
  });
  const out = text(data, ui({ cols: 40 }));
  expect(out).toMatch(/Ceiling light.*On · 60%/);
  expect(out).toMatch(/Island.*Off/);
});

test("the irrigation card shows when each zone was last watered and when the next run is", () => {
  const data = house();
  data.states.set("switch.lawn", {
    state: { domain: "switch", on: false },
    available: true,
    attributes: { lastWateredAt: NOW - 3 * 3_600_000 },
  });
  data.entities.push(
    {
      id: "sensor.next",
      name: "Rachio next run",
      domain: "sensor",
      integrationId: "rachio.main",
      deviceId: "d-rachio",
      uniqueId: "dev-1-next-run",
    },
    {
      id: "binary_sensor.rain",
      name: "Rachio rain sensor",
      domain: "binary_sensor",
      integrationId: "rachio.main",
      deviceId: "d-rachio",
      uniqueId: "dev-1-rain-sensor",
    },
  );
  data.states.set("sensor.next", {
    state: { domain: "sensor", value: "Mon, end by sunrise" },
    available: true,
  });
  data.states.set("binary_sensor.rain", {
    state: { domain: "binary_sensor", on: true },
    available: true,
  });
  const out = text(data, ui({ cols: 180 }));
  expect(out).toContain("Irrigation · next Mon by sunrise · rain sensor wet");
  expect(out).toMatch(/Lawn +3 h ago/);

  data.states.set("switch.lawn", {
    state: { domain: "switch", on: false },
    available: true,
    attributes: { lastWateredAt: NOW - 4 * 86_400_000 },
  });
  expect(text(data, ui({ cols: 180 }))).toMatch(/Lawn +4 days ago/);
});

// ───────── the history chart in a sensor's detail ─────────

test("a sensor's detail shows a chart of its history with the range picker", () => {
  const points = Array.from({ length: 48 }, (_, i) => ({
    at: NOW - (48 - i) * 30 * 60_000,
    value: 20 + (i % 12),
  }));
  const frame = render(
    house(),
    ui({
      detail: "sensor.attic",
      history: { entityId: "sensor.attic", range: "day", points },
      rows: 40,
    }),
  );
  const out = frame.lines.join("\n");
  expect(out).toContain("Attic temperature · sensor.attic");
  expect(out).toMatch(/History +last hour +last 24 hours +last 7 days/);
  expect(out).toMatch(/31 °C │/);
  expect(out).toMatch(/20 °C │/);
  expect(out).toContain("└─");
  expect(out).toMatch(/min 20 °C · avg [\d.]+ °C · max 31 °C · 48 readings/);
  expect(out).toMatch(/ h {2}hour +d {2}day +w {2}week +any other key to go back/);
  // The usual details are still there, below the chart.
  expect(out).toMatch(/State +31\.2 °C/);
  expect(frame.lines).toHaveLength(40);
  expect(Math.max(...frame.lines.map(width))).toBeLessThanOrEqual(120);
});

test("the chart says when it is loading, failed, empty, or cut short", () => {
  const detail = (history: object) =>
    text(
      house(),
      ui({
        detail: "sensor.attic",
        history: { entityId: "sensor.attic", range: "hour", ...history },
      }),
    );
  expect(detail({})).toContain("Loading history…");
  expect(detail({ error: "Could not load history: Connection closed" })).toContain(
    "Could not load history: Connection closed",
  );
  expect(detail({ points: [] })).toContain("No readings in this range.");
  expect(detail({ points: [{ at: NOW - 60_000, value: 1 }], truncated: true })).toContain(
    "Only the oldest 10,000 readings",
  );
});

test("history for another entity leaves the plain detail view", () => {
  const stale = text(
    house(),
    ui({ detail: "sensor.attic", history: { entityId: "sensor.other", range: "day", points: [] } }),
  );
  expect(stale).not.toContain("History");
  expect(stale).toContain("Press any key to go back.");
});

test("a light's detail shows a bar colored by on and off, not a chart of numbers", () => {
  const states = [
    { at: NOW - 3_600_000, on: false },
    { at: NOW - 2_700_000, on: true },
    { at: NOW - 900_000, on: false },
  ];
  const frame = render(
    house(),
    ui({
      detail: "light.k_ceiling",
      rows: 40,
      history: {
        entityId: "light.k_ceiling",
        range: "hour",
        series: { kind: "state", states, labels: ["On", "Off"] },
      },
    }),
  );
  const out = frame.lines.join("\n");
  expect(out).toMatch(/History +last hour +last 24 hours +last 7 days/);
  expect(out).toMatch(/│ │░+█+░+ +│/);
  expect(out).toMatch(/█ On 50% · ░ Off 50% · 2 changes/);
  expect(out).not.toContain("avg ");
  expect(out).toMatch(/State +On · 60%/);
  expect(out).toMatch(/ h {2}hour +d {2}day +w {2}week/);
  expect(frame.lines).toHaveLength(40);
  expect(Math.max(...frame.lines.map(width))).toBeLessThanOrEqual(120);
});

test("a lock's bar uses its own words", () => {
  const states = [{ at: NOW - 7_200_000, on: true }];
  const out = text(
    house(),
    ui({
      detail: "lock.front_door",
      history: {
        entityId: "lock.front_door",
        range: "hour",
        series: { kind: "state", states, labels: ["Locked", "Unlocked"], tone: "green" },
      },
    }),
  );
  expect(out).toMatch(/│ │█+ +│/);
  expect(out).toContain("█ Locked 100% · ░ Unlocked 0% · 0 changes");
});

test("the chart shrinks on a short terminal but never disappears", () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ at: NOW - (20 - i) * 60_000, value: i }));
  for (const rows of [20, 30, 60]) {
    const frame = render(
      house(),
      ui({
        detail: "sensor.attic",
        history: { entityId: "sensor.attic", range: "hour", points },
        rows,
      }),
    );
    expect(frame.lines).toHaveLength(rows);
    expect(
      frame.lines.filter((l) => l.includes("│") && /[▁▂▃▄▅▆▇█]/.test(l)).length,
    ).toBeGreaterThanOrEqual(1);
  }
});

const minutes = (n: number, value: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ at: NOW - (n - i) * 60_000, value: value(i) }));
const atticDetail = (history: Partial<DashHistory>, extra: Partial<DashUi> = {}) =>
  ui({
    detail: "sensor.attic",
    history: { entityId: "sensor.attic", range: "hour", ...history },
    ...extra,
  });

test("the detail fills exactly the rows given and keeps the chart's top label and a bar row", () => {
  const points = minutes(30, (i) => i);
  for (let rows = 12; rows <= 60; rows++) {
    const frame = render(house(), atticDetail({ points }, { rows }));
    expect(frame.lines).toHaveLength(rows);
    const out = frame.lines.join("\n");
    expect(out).toContain("History");
    expect(out).toMatch(/29 °C │/);
    expect(frame.lines.some((l) => /│[▁▂▃▄▅▆▇█ ]*[▁▂▃▄▅▆▇█]/.test(l))).toBe(true);
    // The screen's own key row is never cut.
    expect(frame.lines.at(-1)).toContain("quit");
  }
});

test("the detail's range keys stay visible on a short terminal", () => {
  // Below 39 rows the chart's height budget is too generous, so the box's last line,
  // "h hour  d day  w week", was cropped off the bottom.
  const points = minutes(30, (i) => i);
  for (const rows of [20, 25, 30, 33, 38]) {
    const out = text(house(), atticDetail({ points }, { rows }));
    expect(out).toMatch(/ h {2}hour +d {2}day +w {2}week/);
  }
});

test("the detail never runs past the terminal's width, even with huge readings", () => {
  const points = [
    { at: NOW - 50 * 60_000, value: 3 },
    { at: NOW - 1_000, value: 1e12 },
  ];
  for (let cols = 40; cols <= 200; cols += 3) {
    const frame = render(house(), atticDetail({ points }, { cols, rows: 40 }));
    expect(Math.max(...frame.lines.map(width))).toBeLessThanOrEqual(cols);
    expect(frame.lines.join("\n")).toContain("1,000,000,000,000 °C │");
  }
});

test("a sensor whose state is a word still charts its numeric history, without a unit", () => {
  const data = house();
  data.states.set("sensor.attic", {
    state: { domain: "sensor", value: "high" },
    available: true,
  });
  const out = text(data, atticDetail({ points: minutes(10, (i) => i + 1) }, { rows: 50 }));
  expect(out).toMatch(/State +high/);
  expect(out).toMatch(/10 │/);
  expect(out).toMatch(/ 1 │/);
  expect(out).toContain("min 1 · avg 5.5 · max 10 · 10 readings");
  expect(out).not.toContain("°C │");
});

test("a sensor with no unit labels its chart with bare numbers", () => {
  const data = house();
  data.states.set("sensor.attic", { state: { domain: "sensor", value: 4 }, available: true });
  const out = text(data, atticDetail({ points: minutes(5, (i) => i * 2) }, { rows: 50 }));
  expect(out).toMatch(/│ 8 │/);
  expect(out).toMatch(/│ 0 │/);
  expect(out).toContain("min 0 · avg 4 · max 8 · 5 readings");
});

test("every range is offered and the chosen one is the highlighted chip", () => {
  const labels = { hour: "last hour", day: "last 24 hours", week: "last 7 days" } as const;
  for (const range of ["hour", "day", "week"] as const) {
    const plain = text(house(), atticDetail({ range, points: minutes(5, (i) => i) }));
    expect(plain).toMatch(/History +last hour +last 24 hours +last 7 days/);
    setColor(true);
    try {
      const colored = text(house(), atticDetail({ range, points: minutes(5, (i) => i) }));
      const chips = colored
        .split("\x1b[48;5;209;38;5;16m")
        .slice(1)
        .map((rest) => rest.slice(0, rest.indexOf("\x1b[0m")).trim());
      expect(chips).toEqual([labels[range]]);
    } finally {
      setColor(false);
    }
  }
});

test("readings outside the chosen range are left out of the chart and its summary", () => {
  const points = [
    { at: NOW - 30 * 86_400_000, value: 99 },
    { at: NOW - 2 * 3_600_000, value: 50 },
    { at: NOW - 30 * 60_000, value: 1 },
    { at: NOW - 60_000, value: 3 },
    { at: NOW + 3_600_000, value: -50 },
  ];
  const hour = text(house(), atticDetail({ range: "hour", points }, { rows: 50 }));
  expect(hour).toContain("min 1 °C · avg 2 °C · max 3 °C · 2 readings");
  const week = text(house(), atticDetail({ range: "week", points }, { rows: 50 }));
  expect(week).toContain("min 1 °C · avg 18 °C · max 50 °C · 3 readings");
});

// ───────── a state bar in the detail view, at every size ─────────

const lightStates = [
  { at: NOW - 3_600_000, on: false },
  { at: NOW - 2_700_000, on: true },
  { at: NOW - 900_000, on: false },
];
const lightDetail = (history: Partial<DashHistory>, extra: Partial<DashUi> = {}) =>
  ui({
    detail: "light.k_ceiling",
    history: {
      entityId: "light.k_ceiling",
      range: "hour",
      series: { kind: "state", states: lightStates, labels: ["On", "Off"] },
      ...history,
    },
    ...extra,
  });
const RANGE_KEYS = / h {2}hour +d {2}day +w {2}week/;
const BAR_ROW = /│ │[░█ ]*[░█]/;

test("a state bar's detail fills exactly the rows given and keeps the bar and range keys from 16 rows up", () => {
  for (let rows = 16; rows <= 60; rows++) {
    const frame = render(house(), lightDetail({}, { rows }));
    expect(frame.lines).toHaveLength(rows);
    expect(frame.lines.some((l) => BAR_ROW.test(l))).toBe(true);
    expect(frame.lines.join("\n")).toMatch(RANGE_KEYS);
    expect(frame.lines.at(-1)).toContain("quit");
  }
});

test("a state bar's detail on a very short terminal still has exactly its rows and the bar", () => {
  for (let rows = 12; rows < 16; rows++) {
    const frame = render(house(), lightDetail({}, { rows }));
    expect(frame.lines).toHaveLength(rows);
    expect(frame.lines.some((l) => BAR_ROW.test(l))).toBe(true);
  }
});

test("a state bar's range keys stay visible from 12 rows up", () => {
  // The height budget in detailView counts no lines for a timeline's axis, time labels,
  // and summary (graphExtra is 0 for "state", dash.ts:563), so from 12 to 15 rows the
  // "h hour  d day  w week" line was cropped off the bottom of the box.
  for (let rows = 12; rows < 16; rows++) {
    expect(text(house(), lightDetail({}, { rows }))).toMatch(RANGE_KEYS);
  }
});

test("a state bar's detail box is closed at every height", () => {
  // At 27 rows the details first fit by the budget, but the timeline's four extra lines
  // were not counted, so the box ran one line over and its bottom border was cut off.
  for (let rows = 16; rows <= 60; rows++) {
    const frame = render(house(), lightDetail({}, { rows }));
    expect(frame.lines.some((l) => /^└─+┘$/.test(l))).toBe(true);
  }
});

test("a state bar's detail never runs past the terminal's width, from 40 to 200 columns", () => {
  for (let cols = 40; cols <= 200; cols++) {
    const frame = render(
      house(),
      lightDetail(
        {
          range: "week",
          truncated: true,
          series: { kind: "state", states: lightStates, labels: ["Wide open", "Shut tight"] },
        },
        { cols, rows: 40 },
      ),
    );
    expect(Math.max(...frame.lines.map(width))).toBeLessThanOrEqual(cols);
    expect(frame.lines.some((l) => BAR_ROW.test(l))).toBe(true);
  }
});

test("a failed load shows the error in place of the bar, with the range keys still offered", () => {
  const frame = render(
    house(),
    lightDetail({ error: "Could not load history: timeout" }, { rows: 30 }),
  );
  const out = frame.lines.join("\n");
  expect(out).toContain("Could not load history: timeout");
  expect(frame.lines.some((l) => BAR_ROW.test(l))).toBe(false);
  expect(out).not.toContain("█ On");
  expect(out).toMatch(RANGE_KEYS);
  expect(frame.lines).toHaveLength(30);
});

test("a cut-short state history says so under the bar's summary", () => {
  const frame = render(house(), lightDetail({ truncated: true }, { rows: 40 }));
  const lines = frame.lines;
  const summary = lines.findIndex((l) => l.includes("█ On 50% · ░ Off 50% · 2 changes"));
  const note = lines.findIndex((l) => l.includes("Only the oldest 10,000 readings"));
  expect(summary).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(summary);
  expect(text(house(), lightDetail({}, { rows: 40 }))).not.toContain("Only the oldest");
});

test("a car's card is selectable and opens the history of what the car was doing", () => {
  const data = house();
  data.entities.push({
    id: "sensor.car_state",
    name: "Car state",
    domain: "sensor",
    integrationId: "teslamate.main",
    deviceId: "d-car",
    uniqueId: "teslamate-1-state",
  });
  data.states.set("sensor.car_state", {
    state: { domain: "sensor", value: "asleep" },
    available: true,
  });
  const frame = render(data, ui({ pane: "right", index: 4 }));
  // The state is preferred over the battery as what enter opens.
  expect(frame.right[4]).toEqual({ entityId: "sensor.car_state", kind: "car" });

  const points = [
    { at: NOW - 3_600_000, value: "asleep" },
    { at: NOW - 1_800_000, value: "online" },
    { at: NOW - 900_000, value: "driving" },
  ];
  const out = text(
    data,
    ui({
      detail: "sensor.car_state",
      rows: 40,
      history: {
        entityId: "sensor.car_state",
        range: "hour",
        series: { kind: "category", points },
      },
    }),
  );
  expect(out).toMatch(/│ │█+▓+▒+ +│/);
  expect(out).toContain("█ asleep 50% · ▓ online 25% · ▒ driving 25% · 2 changes");
  expect(out).toMatch(/ h {2}hour +d {2}day +w {2}week/);
});

/** Adds a TeslaMate entity (a uniqueId suffix, and whether it is hidden) to a car device. */
function carEntity(data: DashData, id: string, name: string, suffix: string, hidden = false) {
  const entityId = `sensor.${id}_${suffix}`;
  data.entities.push({
    id: entityId,
    name: `${name} ${suffix}`,
    domain: "sensor",
    integrationId: "teslamate.main",
    deviceId: id,
    uniqueId: `teslamate-${id}-${suffix}`,
    hidden,
  });
  data.states.set(entityId, {
    state: { domain: "sensor", value: suffix === "state" ? "online" : 50 },
    available: true,
  });
}

/** A TeslaMate car device with entities ending in the given suffixes. */
function withCar(data: DashData, id: string, name: string, suffixes: string[]): void {
  data.devices.push({ id, name, integrationId: "teslamate.main" });
  for (const suffix of suffixes) carEntity(data, id, name, suffix);
}

/** The house without its car's battery, so that car has nothing to open. */
const carless = (): DashData => {
  const data = house();
  data.entities = data.entities.filter((e) => e.id !== "sensor.car_battery");
  return data;
};

test("a car with neither a state nor a battery is shown but cannot be selected", () => {
  const data = carless();
  const frame = render(data, ui({ pane: "right", index: 4 }));
  expect(frame.right.map((i) => i.kind)).toEqual(["climate", "lock", "lock", "lock", "zone"]);
  expect(frame.right[4]).toEqual({ entityId: "switch.lawn", kind: "zone" });
  const card = frame.lines.findIndex((l) => l.includes("Terry · Model Y"));
  expect(card).toBeGreaterThan(-1);
  // The cursor is on the zone below, not on the car.
  expect(frame.lines[card + 1]).not.toContain("▸");
  expect(frame.lines.filter((l) => l.includes("▸"))).toHaveLength(1);
  expect(frame.lines.find((l) => l.includes("▸"))).toContain("Lawn");
});

test("a car opens its battery when its state entity is hidden", () => {
  const data = house();
  carEntity(data, "d-car", "Terry", "state", true);
  const frame = render(data, ui());
  expect(frame.right[4]).toEqual({ entityId: "sensor.car_battery", kind: "car" });
});

test("a car's battery is found by a bare -battery id too", () => {
  const data = carless();
  withCar(data, "d-van", "Vanna", ["battery"]);
  const frame = render(data, ui());
  expect(frame.right[4]).toEqual({ entityId: "sensor.d-van_battery", kind: "car" });
});

test("two cars are each selectable in device order and the cursor marks only the chosen one", () => {
  const data = house();
  withCar(data, "d-van", "Vanna", ["battery_level", "state"]);
  const frame = render(data, ui({ pane: "right", index: 5 }));
  expect(frame.right.slice(4)).toEqual([
    { entityId: "sensor.car_battery", kind: "car" },
    { entityId: "sensor.d-van_state", kind: "car" },
    { entityId: "switch.lawn", kind: "zone" },
  ]);
  const terry = frame.lines.findIndex((l) => l.includes("Terry · Model Y"));
  const vanna = frame.lines.findIndex((l) => l.includes("┌ Vanna"));
  expect(vanna).toBeGreaterThan(terry);
  expect(frame.lines[terry + 1]).not.toContain("▸");
  expect(frame.lines[vanna + 1]).toContain("▸");
  expect(frame.lines.filter((l) => l.includes("▸"))).toHaveLength(1);
});

test("a selected car's line fits its card at 100 and 120 columns, with colors on", () => {
  setColor(true);
  try {
    for (const cols of [100, 120]) {
      const frame = render(house(), ui({ cols, pane: "right", index: 4 }));
      const card = frame.lines.findIndex((l) => l.includes("Terry"));
      const line = frame.lines[card + 1] ?? "";
      expect(line).toContain("▸");
      expect(width(line)).toBe(cols);
      // The card's right edge is the last column, so nothing spilled past it.
      expect(strip(line)).toMatch(/│$/);
      for (const l of frame.lines) expect(width(l)).toBeLessThanOrEqual(cols);
    }
  } finally {
    setColor(false);
  }
});

// ───────── the mouse ─────────

test("every selectable row has a clickable span on its own line, in its own pane's columns", () => {
  const frame = render(house(), ui());
  expect(frame.hits).toHaveLength(frame.left.length + frame.right.length);
  for (const hit of frame.hits) {
    const item = (hit.pane === "left" ? frame.left : frame.right)[hit.index];
    const entity = house().entities.find((e) => e.id === item?.entityId);
    const line = frame.lines[hit.line] ?? "";
    // The row's own text is on that line, within the hit's columns.
    const cells = [...line].slice(hit.from, hit.to + 1).join("");
    const label =
      item?.kind === "zone"
        ? "Lawn"
        : item?.kind === "car"
          ? "68%"
          : item?.kind === "climate"
            ? "21.5°C"
            : String(entity?.name);
    expect(cells).toContain(label);
  }
  // Left and right spans do not overlap.
  const left = frame.hits.filter((h) => h.pane === "left");
  const right = frame.hits.filter((h) => h.pane === "right");
  expect(Math.max(...left.map((h) => h.to))).toBeLessThan(Math.min(...right.map((h) => h.from)));
});

test("hitAt finds the row under a position and nothing between or outside rows", () => {
  const frame = render(house(), ui());
  const first = frame.hits.find((h) => h.pane === "left" && h.index === 0);
  expect(first).toBeDefined();
  if (!first) return;
  expect(hitAt(frame, first.line, first.from + 5)).toMatchObject({ pane: "left", index: 0 });
  expect(hitAt(frame, first.line, first.to)).toMatchObject({ pane: "left", index: 0 });
  // The gap between the columns, the header, and a box border are not rows.
  expect(hitAt(frame, first.line, first.to + 1)).toBeUndefined();
  expect(hitAt(frame, 0, 3)).toBeUndefined();
  expect(hitAt(frame, first.line - 1, 3)).toBeUndefined();
  expect(hitAt(frame, 999, 3)).toBeUndefined();
});

test("clickable rows follow the scroll, stack on a narrow terminal, and vanish in the detail view", () => {
  const scrolled = render(house(), ui({ rows: 14, index: 5 }));
  for (const hit of scrolled.hits) {
    expect(hit.line).toBeGreaterThanOrEqual(0);
    expect(hit.line).toBeLessThan(14);
  }
  const attic = scrolled.hits.find((h) => h.pane === "left" && h.index === 5);
  expect(scrolled.lines[attic?.line ?? -1]).toContain("▸ Attic temperature");

  const narrow = render(house(), ui({ cols: 80 }));
  const lastLeft = Math.max(...narrow.hits.filter((h) => h.pane === "left").map((h) => h.line));
  const firstRight = Math.min(...narrow.hits.filter((h) => h.pane === "right").map((h) => h.line));
  expect(firstRight).toBeGreaterThan(lastLeft);
  expect(narrow.lines[firstRight]).toContain("21.5°C");

  expect(render(house(), ui({ detail: "sensor.attic" })).hits).toEqual([]);
});

/** What a hit's own row must show within its span: the label the existing tests use. */
function labelOf(
  data: DashData,
  frame: ReturnType<typeof render>,
  pane: "left" | "right",
  index: number,
) {
  const item = (pane === "left" ? frame.left : frame.right)[index];
  if (item?.kind === "zone") return "Lawn";
  if (item?.kind === "car") return "68%";
  if (item?.kind === "climate") return "°C";
  return String(data.entities.find((e) => e.id === item?.entityId)?.name);
}

/** Every hit is on a line of the frame, shows its own row, and overlaps no other hit. */
function expectSoundHits(data: DashData, frame: ReturnType<typeof render>): void {
  for (const hit of frame.hits) {
    expect(hit.line).toBeGreaterThanOrEqual(0);
    expect(hit.line).toBeLessThan(frame.lines.length);
    expect(hit.from).toBeLessThanOrEqual(hit.to);
    const cells = [...(frame.lines[hit.line] ?? "")].slice(hit.from, hit.to + 1).join("");
    expect(cells).toContain(labelOf(data, frame, hit.pane, hit.index));
  }
  for (const [i, a] of frame.hits.entries()) {
    for (const b of frame.hits.slice(i + 1)) {
      const overlap = a.line === b.line && a.from <= b.to && b.from <= a.to;
      expect(overlap).toBe(false);
    }
  }
}

test("on a terminal too short for the header, clicks still land on the rows shown", () => {
  for (const rows of [6, 7, 8]) {
    const frame = render(house(), ui({ rows }));
    expect(frame.lines).toHaveLength(rows);
    expect(frame.lines[0]).not.toContain("casita"); // the header was dropped
    expect(frame.hits.length).toBeGreaterThan(0);
    expectSoundHits(house(), frame);
  }
  // At 9 rows the header is back, and the hits move down with it.
  const nine = render(house(), ui({ rows: 9 }));
  expect(nine.lines[0]).toContain("casita");
  expect(nine.hits.find((h) => h.pane === "left" && h.index === 0)?.line).toBe(4);
  expectSoundHits(house(), nine);
});

test("on a short terminal scrolled to the right pane, hits follow the scroll", () => {
  const frame = render(house(), ui({ rows: 6, pane: "right", index: 3 }));
  const gate = frame.hits.find((h) => h.pane === "right" && h.index === 3);
  expect(frame.lines[gate?.line ?? -1]).toContain("▸ Side gate");
  expectSoundHits(house(), frame);
});

test("with a filter, only the matching rows are clickable and each points at its row", () => {
  const frame = render(house(), ui({ filter: "door" }));
  expect(frame.hits).toHaveLength(frame.left.length + frame.right.length);
  expect(frame.hits.map((h) => `${h.pane}${h.index}`)).toEqual(["left0", "right0", "right1"]);
  expectSoundHits(house(), frame);
});

test("an empty pane has no clickable rows, and the other pane's rows still work", () => {
  const leftEmpty = render(house(), ui({ filter: "lock." }));
  expect(leftEmpty.left).toEqual([]);
  expect(leftEmpty.hits.every((h) => h.pane === "right")).toBe(true);
  expect(leftEmpty.hits).toHaveLength(leftEmpty.right.length);
  expectSoundHits(house(), leftEmpty);

  const rightEmpty = render(house(), ui({ filter: "kitchen" }));
  expect(rightEmpty.hits.every((h) => h.pane === "left")).toBe(true);

  // Nothing matches: the "Nothing matches" box is not clickable.
  expect(render(house(), ui({ filter: "zzz" })).hits).toEqual([]);
});

test("in the wide layout a hit never reaches the other pane's border", () => {
  const frame = render(house(), ui({ cols: 120 }));
  for (const hit of frame.hits) {
    const cells = [...(frame.lines[hit.line] ?? "")];
    // Each span starts and ends on its own box's border: one │ at each end, none inside
    // that belongs to the neighbour.
    expect(cells[hit.from]).toBe("│");
    expect(cells[hit.to]).toBe("│");
    const inside = cells.slice(hit.from + 1, hit.to).join("");
    expect(inside).not.toContain("│");
    if (hit.pane === "left")
      expect(cells[hit.to + 1]).toBe(" "); // the gap
    else expect(cells[hit.from - 1]).toBe(" ");
  }
  expectSoundHits(house(), frame);
});

test("in the narrow stacked layout every hit spans the full width on its own line", () => {
  for (const cols of [60, 80]) {
    const frame = render(house(), ui({ cols }));
    expect(frame.hits).toHaveLength(frame.left.length + frame.right.length);
    for (const hit of frame.hits) {
      expect(hit.from).toBe(0);
      expect(hit.to).toBe(cols - 1);
    }
    expectSoundHits(house(), frame);
    expect(new Set(frame.hits.map((h) => h.line)).size).toBe(frame.hits.length);
  }
  // Short and narrow at once.
  const both = render(house(), ui({ cols: 80, rows: 8, pane: "right", index: 2 }));
  expectSoundHits(house(), both);
  expect(both.hits.some((h) => h.pane === "right" && h.index === 2)).toBe(true);
});

test("on a terminal with room only for the keys, nothing is clickable", () => {
  expect(render(house(), ui({ rows: 1 })).hits).toEqual([]);
  const two = render(house(), ui({ rows: 2 }));
  expectSoundHits(house(), two);
  for (const hit of two.hits) expect(hit.line).toBe(0);
});

// ───────── the thermostat card and the key hints ─────────

const targetLine = (frame: ReturnType<typeof render>) =>
  strip(frame.lines.find((l) => /heat .*cool .*auto/.test(strip(l))) ?? "");

test("the thermostat's second line is the target then the mode chips, with no - or + key caps", () => {
  setColor(true);
  try {
    for (const cols of [60, 80, 120, 160]) {
      const frame = render(house(), ui({ cols, pane: "right", index: 0 }));
      const line = frame.lines.find((l) => l.includes("target")) ?? "";
      expect(line).not.toContain(c.key(" - "));
      expect(line).not.toContain(c.key(" + "));
      expect(strip(line)).toMatch(/│ {3}target 21° +mode heat {2}cool {2}auto {2}off {2}│$/);
    }
  } finally {
    setColor(false);
  }
});

test("the key hints offer ←→ for dim and temperature, and no - + hint", () => {
  const last = render(house(), ui({ cols: 200 })).lines.at(-1) ?? "";
  expect(last).toContain(" ←→  dim · temp ");
  expect(last).not.toMatch(/-\s+\+/);
  expect(last.match(/temp/g)).toHaveLength(1); // the temperature is no longer a hint of its own
});

test("on a narrow terminal the key hints are cut at its width, from the first hint on", () => {
  for (const cols of [40, 47, 60, 80, 99]) {
    const last = render(house(), ui({ cols })).lines.at(-1) ?? "";
    expect(width(last)).toBeLessThanOrEqual(cols);
    expect(last).toStartWith(" ↑↓  move");
    expect(last).toEndWith("…");
  }
  // At 60 columns the dim and temperature hint still fits whole.
  expect(render(house(), ui({ cols: 60 })).lines.at(-1)).toContain("←→  dim · temp");
});

test("a thermostat with no target reported shows a dash for it and still shows its mode", () => {
  const data = house();
  data.states.set("climate.hallway", {
    state: { domain: "climate", mode: "cool", currentTemp: 23 },
    available: true,
  });
  const frame = render(data, ui({ pane: "right", index: 0 }));
  expect(frame.lines.find((l) => l.includes("▸"))).toContain("▸ 23°C  Cool");
  expect(targetLine(frame)).toMatch(/│ {3}target — +mode heat {2}cool {2}auto {2}off {2}│$/);
});

test("while a thermostat command is pending, it replaces what the card says it is doing", () => {
  const pending = new Map([["climate.hallway", "Setting 21.5°…"]]);
  const frame = render(house(), ui({ pending }));
  const out = frame.lines.join("\n");
  expect(out).toMatch(/21\.5°C {2}◐ Setting 21\.5°…/);
  expect(out).not.toContain("holding");
  // The target shown is still the one last reported, until the thermostat confirms.
  expect(targetLine(frame)).toMatch(/target 21° +mode heat/);
});

test("the thermostat's second line stays inside its card at every width", () => {
  for (let cols = 40; cols <= 200; cols++) {
    const line = targetLine(render(house(), ui({ cols })));
    expect(line).toMatch(/│$/);
    expect(width(line)).toBeLessThanOrEqual(cols);
  }
});

// A narrow card drops its labels ("mode", then "target") before it lets the two halves touch.
test("the target and the mode chips never run together, at any width", () => {
  const data = house();
  data.states.set("climate.hallway", {
    state: { domain: "climate", mode: "heat", currentTemp: 21.5, targetTemp: 21.5 },
    available: true,
  });
  for (let cols = 40; cols <= 200; cols++) {
    expect(targetLine(render(data, ui({ cols })))).toMatch(
      / 21\.5° +(mode )?heat {2}cool {2}auto {2}off {2}│$/,
    );
  }
});

// ───────── the unit system ─────────

const imperial = <T>(fn: () => T): T => {
  setUnits("imperial");
  try {
    return fn();
  } finally {
    setUnits("metric");
  }
};

test("in imperial the thermostat card and the header read in Fahrenheit", () => {
  const out = imperial(() => text(house(), ui()));
  expect(out).toMatch(/70\.7°F {2}Heat · holding 69\.8°/);
  expect(out).toMatch(/ target 69\.8° +mode heat/);
  expect(out.split("\n")[1]).toStartWith("Locks ▲ 1 jammed   Lights 1 on   Hallway 70.7°F heat");
  expect(out).not.toContain("°C");
});

test("in imperial a room's sensor row reads in Fahrenheit", () => {
  // The attic reads 31.2 °C.
  expect(imperial(() => text(house(), ui()))).toMatch(/Attic temperature +sensor\.attic +88\.2 °F/);
});

test("the header's outside reading follows the unit system, whatever unit the sensor reports", () => {
  const data = house();
  data.entities.push({ id: "sensor.outdoor", name: "Outdoor", domain: "sensor" });
  const outdoor = (state: Row) =>
    data.states.set("sensor.outdoor", {
      state: { domain: "sensor", deviceClass: "temperature", ...state },
      available: true,
    });
  const header = () => render(data, ui()).lines[1];

  outdoor({ value: 12.34 });
  expect(imperial(header)).toMatch(/Outside 54\.2°F$/);
  outdoor({ value: 54.2, unit: "°F" });
  expect(header()).toMatch(/Outside 12\.3°C$/);
  expect(imperial(header)).toMatch(/Outside 54\.2°F$/);
  // A reading that converts to a sliver below zero is not shown as -0.
  outdoor({ value: -17.78, unit: "°C" });
  expect(imperial(header)).toMatch(/Outside 0°F$/);
  outdoor({ value: "n/a", unit: "°C" });
  expect(imperial(header)).not.toContain("Outside");
});

test("a thermostat card with no readings shows dashes in imperial too", () => {
  const data = house();
  data.states.delete("climate.hallway");
  const out = imperial(() => text(data, ui()));
  expect(out).toMatch(/— {2}Off/);
  expect(out).toMatch(/ target — /);
  expect(out.split("\n")[1]).toContain("Hallway ");
  expect(out.split("\n")[1]).not.toContain("°F");
});

test("three-digit Fahrenheit temperatures do not break the card or the frame at any width", () => {
  const data = crowded();
  const hot = { domain: "climate", mode: "cool", currentTemp: 38, targetTemp: 37.8 };
  data.states.set("climate.hallway", { state: hot, available: true });
  data.states.set("climate.another_long_thermostat_identifier", {
    state: { ...hot, currentTemp: -40, targetTemp: -17.78 },
    available: true,
  });
  imperial(() => {
    for (const color of [false, true]) {
      setColor(color);
      for (const cols of SOME_COLS) {
        for (const state of [ui({ cols }), ui({ cols, pane: "right", index: 0 })]) {
          const lines = render(data, state).lines;
          expect(Math.max(...lines.map(width))).toBeLessThanOrEqual(cols);
        }
      }
    }
    setColor(false);
    const out = text(data, ui({ cols: 40 }));
    expect(out).toContain("100.4°F");
    expect(out).toContain("100°");
    expect(out).toContain("-40°F");
    expect(out).not.toContain("-0°");
  });
});

// ───────── a car's detail lists everything the car reports ─────────

type Reading = { suffix: string; name: string; state: Row; attributes?: Row; extra?: Row };

/** The house with its car Terry reporting the given readings, and nothing else. */
function terry(readings: Reading[]): DashData {
  const data = carless();
  for (const { suffix, name, state, attributes, extra } of readings) {
    const id = `${state.domain}.terry_${suffix}`;
    data.entities.push({
      id,
      name,
      domain: state.domain,
      integrationId: "teslamate.main",
      deviceId: "d-car",
      uniqueId: `teslamate-1-${suffix}`,
      ...extra,
    });
    data.states.set(id, { state, available: true, attributes, changedAt: NOW - 60_000 });
  }
  return data;
}

const sensorReading = (suffix: string, name: string, value: unknown, unit?: string): Reading => ({
  suffix,
  name,
  state: { domain: "sensor", value, unit },
});
const WHERE: Reading = {
  suffix: "geofence",
  name: "Terry location",
  state: { domain: "sensor", value: "Home" },
  attributes: { latitude: 47.6694, longitude: -122.1239, heading: 271.6 },
};
const TERRY: Reading[] = [
  sensorReading("state", "Terry state", "online"),
  sensorReading("battery_level", "Terry battery", 68, "%"),
  sensorReading("odometer", "Terry odometer", 48621.33, "km"),
  sensorReading("tpms_pressure_fl", "Terry tire pressure front left", 2.9, "bar"),
  { suffix: "locked", name: "Terry lock", state: { domain: "lock", locked: true } },
  WHERE,
];

/** The lines inside the detail box, without its borders. */
const inside = (data: DashData, state: DashUi): string[] => {
  const lines = render(data, state).lines;
  const top = lines.findIndex((l) => l.includes("┌"));
  const bottom = lines.findIndex((l) => l.includes("└"));
  return lines.slice(top + 1, bottom).map((l) => strip(l).slice(2, -2).trimEnd());
};
/** The labels of the reading lines, in reading order down each column. */
const labelsOf = (lines: string[]): string[] =>
  lines.flatMap((l) =>
    [...l.matchAll(/(?:^|\s{2})([A-Z][a-z][\w ]*?) {2,}/g)].map((m) => m[1] ?? ""),
  );

test("a car's detail lists every reading of the car instead of the one entity's own lines", () => {
  const out = text(terry(TERRY), ui({ detail: "sensor.terry_state" }));
  expect(out).toContain("Terry state · sensor.terry_state");
  expect(out).toMatch(/Battery +68 %/);
  expect(out).toMatch(/Odometer +48,621\.3 km/);
  expect(out).toMatch(/Tire pressure front left +2\.9 bar/);
  expect(out).toMatch(/Lock +Locked/);
  expect(out).toMatch(/State +online/);
  for (const gone of ["Raw ", "Attributes ", "Changed ", "Updated "]) {
    expect(out).not.toContain(gone);
  }
  expect(out).not.toContain('{"domain"');
  expect(out).toMatch(/Device +Terry \(Model Y\)/);
  expect(out).toMatch(/Area +—/);
  expect(out).toMatch(/Integration +teslamate\.main/);
  expect(out).toMatch(/Controls +view only/);
  expect(out).toContain("Press any key to go back.");
});

test("the readings come before the device lines, with a blank line between", () => {
  const lines = inside(terry(TERRY), ui({ detail: "sensor.terry_state" }));
  const device = lines.findIndex((l) => l.startsWith("Device"));
  expect(lines[device - 1]).toBe("");
  expect(lines[device - 2]).toMatch(/^\w/);
  expect(lines.slice(device, device + 4).map((l) => l.split(/ {2,}/)[0])).toEqual([
    "Device",
    "Area",
    "Integration",
    "Controls",
  ]);
});

test("the car's battery, by either id, opens the same list as its state", () => {
  const byState = inside(terry(TERRY), ui({ detail: "sensor.terry_state" }));
  expect(inside(terry(TERRY), ui({ detail: "sensor.terry_battery_level" }))).toEqual(byState);
  const bare = TERRY.map((r) => (r.suffix === "battery_level" ? { ...r, suffix: "battery" } : r));
  expect(inside(terry(bare), ui({ detail: "sensor.terry_battery" }))).toEqual(byState);
});

test("the car's other entities keep the ordinary detail view", () => {
  const data = terry([
    ...TERRY,
    sensorReading("charging_state", "Terry charging state", "Stopped"),
  ]);
  for (const detail of [
    "sensor.terry_odometer",
    "sensor.terry_tpms_pressure_fl",
    "lock.terry_locked",
    "sensor.terry_geofence",
    // ends in "_state", not "-state"
    "sensor.terry_charging_state",
  ]) {
    const out = text(data, ui({ detail }));
    expect(out).toMatch(/Raw +\{/);
    expect(out).toMatch(/Changed +1 min/);
    expect(out).not.toMatch(/Battery +68 %/);
  }
});

test("an entity ending in -state on a device that is not a car keeps the ordinary detail view", () => {
  const data = house();
  data.entities.push({
    id: "sensor.washer_state",
    name: "Attic sensor state",
    domain: "sensor",
    integrationId: "zigbee2mqtt.main",
    deviceId: "d-attic",
    uniqueId: "washer-state",
  });
  data.states.set("sensor.washer_state", {
    state: { domain: "sensor", value: "idle" },
    available: true,
  });
  const out = text(data, ui({ detail: "sensor.washer_state" }));
  expect(out).toMatch(/State +idle/);
  expect(out).toMatch(/Raw +\{"domain":"sensor","value":"idle"\}/);
  expect(out).not.toMatch(/Temperature/);
});

test("a car from the tesla integration gets the same list", () => {
  const data = terry(TERRY);
  for (const e of data.entities) if (e.deviceId === "d-car") e.integrationId = "tesla.main";
  const device = data.devices.find((d) => d.id === "d-car");
  if (device) device.integrationId = "tesla.main";
  const out = text(data, ui({ detail: "sensor.terry_state" }));
  expect(out).toMatch(/Odometer +48,621\.3 km/);
  expect(out).not.toMatch(/Raw /);
});

test("the location is a line of its own at the top: place, position to 5 places, heading", () => {
  const lines = inside(terry(TERRY), ui({ detail: "sensor.terry_state" }));
  expect(lines[0]).toMatch(/^Location +Home · 1 min · 47\.66940, -122\.12390 · heading 272°$/);
  expect(lines.filter((l) => l.includes("Location"))).toHaveLength(1);
});

test("the location without a heading leaves the heading out", () => {
  const where = { ...WHERE, attributes: { latitude: 47.7, longitude: -122.1239 } };
  const lines = inside(terry([...TERRY.slice(0, -1), where]), ui({ detail: "sensor.terry_state" }));
  expect(lines[0]).toMatch(/^Location +Home · 1 min · 47\.70000, -122\.12390$/);
});

test("a heading of 0 is still shown", () => {
  const where = { ...WHERE, attributes: { latitude: 47.7, longitude: -122.1239, heading: 0 } };
  const lines = inside(terry([...TERRY.slice(0, -1), where]), ui({ detail: "sensor.terry_state" }));
  expect(lines[0]).toEndWith("· heading 0°");
});

test("a location with no position is an ordinary reading in the list", () => {
  const where = { ...WHERE, attributes: undefined };
  const lines = inside(terry([...TERRY.slice(0, -1), where]), ui({ detail: "sensor.terry_state" }));
  expect(lines[0]).toMatch(/^Battery/);
  expect(lines.join("\n")).toMatch(/Location +Home · 1 min(?! ·)/);
});

test("from an inner width of 96 the readings are in two columns, sorted down each column", () => {
  const lines = inside(terry(TERRY), ui({ cols: 100, detail: "sensor.terry_state" }));
  const readings = lines.slice(1, lines.indexOf(""));
  expect(readings).toHaveLength(3);
  // Column one holds the first half in order, column two the rest.
  expect(labelsOf(readings.map((l) => l.slice(0, 47)))).toEqual(["Battery", "Lock", "Odometer"]);
  expect(labelsOf(readings.map((l) => l.slice(47)))).toEqual(["State", "Tire pressure front left"]);
  expect(readings[0]).toMatch(/^Battery +68 % +State +online · 1 min$/);
});

test("below an inner width of 96 the readings are one column, sorted", () => {
  const lines = inside(terry(TERRY), ui({ cols: 99, detail: "sensor.terry_state" }));
  const readings = lines.slice(1, lines.indexOf(""));
  expect(readings).toHaveLength(5);
  expect(labelsOf(readings)).toEqual([
    "Battery",
    "Lock",
    "Odometer",
    "State",
    "Tire pressure front left",
  ]);
});

test("an odd number of readings leaves the last row's second column empty", () => {
  const lines = inside(terry(TERRY.slice(0, 5)), ui({ cols: 120, detail: "sensor.terry_state" }));
  const readings = lines.slice(0, lines.indexOf(""));
  expect(readings).toHaveLength(3);
  expect(readings[2]).toMatch(/^Odometer +48,621\.3 km$/);
});

test("a car with only its state lists just that", () => {
  const data = terry([sensorReading("state", "Terry state", "asleep")]);
  for (const cols of [60, 120]) {
    const lines = inside(data, ui({ cols, detail: "sensor.terry_state" }));
    expect(lines[0]).toMatch(/^State +asleep · 1 min$/);
    expect(lines[1]).toBe("");
    expect(lines[2]).toMatch(/^Device +Terry/);
  }
});

test("hidden entities and other devices' entities are not listed", () => {
  const data = terry([
    ...TERRY,
    { ...sensorReading("elevation", "Terry elevation", 112, "m"), extra: { hidden: true } },
  ]);
  const out = text(data, ui({ detail: "sensor.terry_state" }));
  expect(out).not.toContain("Elevation");
  expect(out).not.toContain("112");
  expect(out).not.toContain("Attic");
  expect(out).not.toContain("Lawn");
});

test("a label is the entity's name less the car's name, capitalised", () => {
  const data = terry([
    sensorReading("state", "Terry state", "online"),
    // The car's name as the start of a longer word is not the car's name.
    sensorReading("x1", "Terryville battery", 1),
    // A name that does not start with the car's name is kept whole.
    sensorReading("x2", "rear camera", 2),
    // Only the first letter is raised.
    sensorReading("x3", "Terry tPMS raw", 3),
  ]);
  const out = text(data, ui({ cols: 80, detail: "sensor.terry_state" }));
  expect(out).toMatch(/Terryville battery +1/);
  expect(out).toMatch(/Rear camera +2/);
  expect(out).toMatch(/TPMS raw +3/);
  expect(out).not.toMatch(/│ ville/);
});

test("an unavailable reading says so and what it was", () => {
  const data = terry(TERRY);
  const odo = data.states.get("sensor.terry_odometer");
  if (odo) odo.available = false;
  const out = text(data, ui({ detail: "sensor.terry_state" }));
  expect(out).toMatch(/Odometer +Unavailable ╱╱ was 48,621\.3 km/);
});

test("a label longer than the label column is cut and still separated from its value", () => {
  const data = terry([
    ...TERRY,
    sensorReading("cmax", "Terry charge current request maximum value", 32, "A"),
  ]);
  const out = text(data, ui({ detail: "sensor.terry_state" }));
  expect(out).not.toMatch(/value32/);
  expect(out).toMatch(/ +32 A/);
});

test("the car's detail box is closed at every width from 40 to 200, in color or not", () => {
  const data = terry([
    ...TERRY,
    sensorReading("destination", "Terry destination", "A very long destination name ".repeat(6)),
  ]);
  for (const color of [false, true]) {
    setColor(color);
    try {
      for (let cols = 40; cols <= 200; cols++) {
        const lines = render(data, ui({ cols, detail: "sensor.terry_state" })).lines;
        const top = lines.findIndex((l) => l.includes("┌"));
        const bottom = lines.findIndex((l) => l.includes("└"));
        expect(bottom).toBeGreaterThan(top + 5);
        for (const line of lines.slice(top, bottom + 1)) expect(width(line)).toBe(cols);
        for (const line of lines.slice(top + 1, bottom)) expect(strip(line)).toMatch(/^│ .* │$/);
      }
    } finally {
      setColor(false);
    }
  }
});

test("on a narrow terminal the location line is cut with an ellipsis, not wrapped", () => {
  const lines = inside(terry(TERRY), ui({ cols: 40, detail: "sensor.terry_state" }));
  expect(lines[0]).toStartWith("Location");
  expect(lines[0]).toEndWith("…");
  expect(lines[1]).toMatch(/^Battery/);
});

test("the car's detail keeps its range keys on a short terminal with history open", () => {
  const data = terry(TERRY);
  const points = [
    { at: NOW - 3_600_000, value: "asleep" },
    { at: NOW - 900_000, value: "online" },
  ];
  for (const rows of [10, 14, 20, 25, 30, 46]) {
    const frame = render(
      data,
      ui({
        rows,
        detail: "sensor.terry_state",
        history: {
          entityId: "sensor.terry_state",
          range: "hour",
          series: { kind: "category", points },
        },
      }),
    );
    expect(frame.lines).toHaveLength(rows);
    expect(frame.lines.join("\n")).toMatch(/ h {2}hour +d {2}day +w {2}week/);
  }
  // With room, the readings are shown below the chart.
  const tall = text(
    data,
    ui({
      rows: 60,
      detail: "sensor.terry_state",
      history: {
        entityId: "sensor.terry_state",
        range: "hour",
        series: { kind: "category", points },
      },
    }),
  );
  expect(tall).toMatch(/Odometer +48,621\.3 km/);
});

test("in imperial the car's readings show psi and miles", () => {
  const out = imperial(() => text(terry(TERRY), ui({ detail: "sensor.terry_state" })));
  expect(out).toMatch(/Tire pressure front left +42\.1 psi/);
  expect(out).toMatch(/Odometer +30,211\.9 mi/);
  expect(out).not.toMatch(/ bar| km/);
  // Back in metric afterwards.
  expect(text(terry(TERRY), ui({ detail: "sensor.terry_state" }))).toMatch(/2\.9 bar/);
});
