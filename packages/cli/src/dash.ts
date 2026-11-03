// The dashboard's layout: a pure function from what the server knows and what the user is
// doing to the lines on screen. All input and output lives in dash-run.ts.

import { degrees, degreeUnit, inUnits } from "@casita/client";
import { categoryTimeline, chart, type Point, type Series, timeline } from "./chart.ts";
import {
  ago,
  carLines,
  carsFrom,
  clock,
  formatNumber,
  levelBar,
  present,
  type Row,
  since,
  tint,
} from "./present.ts";
import { c, fit, pad, padStart, SYMBOL, selectStart, truncate, width } from "./style.ts";

export interface DashData {
  entities: Row[];
  devices: Row[];
  areas: Row[];
  states: Map<string, Row>;
  integrations: Row[];
}

export interface DashUi {
  cols: number;
  /** Terminal height; undefined prints everything without scrolling. */
  rows?: number;
  now: number;
  pane: "left" | "right";
  index: number;
  filter: string;
  /** True while the filter is being typed. */
  filtering: boolean;
  /** Commands in flight: entity id → what is being waited for ("Turning on…"). */
  pending: Map<string, string>;
  /** The message line above the key hints, already colored. */
  status: string;
  recent: { text: string; at: number }[];
  connected: boolean;
  /** Entity shown in the detail view, if any. */
  detail?: string;
  /** History for the detail view's chart; `points` is absent while it loads. */
  history?: DashHistory;
}

export const RANGES = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;
const RANGE_LABEL: Record<Range, string> = {
  hour: "last hour",
  day: "last 24 hours",
  week: "last 7 days",
};

export interface DashHistory {
  entityId: string;
  range: Range;
  /** What to draw. Absent (along with `points`) while it loads. */
  series?: Series;
  /** Shorthand for a numeric series in the unit of the entity's current state. */
  points?: Point[];
  error?: string;
  /** The server's row limit was hit, so the newest part of the range is missing. */
  truncated?: boolean;
}

/** Something the cursor can rest on. */
export interface Item {
  entityId: string;
  kind: "entity" | "climate" | "lock" | "zone" | "car";
}

/** Where on screen an item can be clicked: a line of the frame and a span of its columns. */
export interface Hit {
  line: number;
  from: number;
  to: number;
  pane: "left" | "right";
  index: number;
}

export interface Frame {
  lines: string[];
  left: Item[];
  right: Item[];
  /** The clickable rows currently on screen. Empty in the detail view. */
  hits: Hit[];
}

/** The item at a screen position (zero-based), if any. */
export function hitAt(frame: Frame, line: number, column: number): Hit | undefined {
  return frame.hits.find((h) => h.line === line && column >= h.from && column <= h.to);
}

const MODES = ["heat", "cool", "auto", "off"];
/** Room for the widest lock status: "● Unlocked", or "◐ Unlocking…" while waiting. */
const LOCK_STATUS_W = 12;
/** Paints a row as selected, surviving the color resets inside it. */
const highlight = (line: string): string => {
  const on = selectStart();
  return on ? `${on}${line.replaceAll("\x1b[0m", `\x1b[0m${on}`)}\x1b[0m` : line;
};

const title = (name: string, detail?: string) =>
  `${c.bold(name)}${detail ? c.dim(` · ${detail}`) : ""}`;

function box(heading: string, body: string[], w: number): string[] {
  const inner = w - 4;
  // The title starts in the same column as the panel's contents.
  const shown = fit(heading, Math.min(width(heading), w - 5));
  const rule = "─".repeat(Math.max(0, w - width(shown) - 4));
  const top = `${c.faint("┌")} ${shown} ${c.faint(`${rule}┐`)}`;
  return [
    top,
    ...body.map((line) => `${c.faint("│")} ${fit(line, inner)} ${c.faint("│")}`),
    c.faint(`└${"─".repeat(w - 2)}┘`),
  ];
}

const stateOf = (data: DashData, entity: Row) => data.states.get(String(entity.id));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const kindOf = (entity: Row) => String(entity.integrationId).split(".")[0] ?? "";

/** Lays the whole screen out. */
export function render(data: DashData, ui: DashUi): Frame {
  const { now } = ui;
  const needle = ui.filter.toLowerCase();
  const visible = data.entities.filter(
    (e) => !e.hidden && (!needle || `${e.name} ${e.id}`.toLowerCase().includes(needle)),
  );
  const carDevices = new Set(data.devices.filter(isCar).map((d) => d.id));
  const climates = visible.filter((e) => e.domain === "climate");
  const locks = visible.filter((e) => e.domain === "lock" && !carDevices.has(e.deviceId));
  const zones = visible.filter((e) => kindOf(e) === "rachio");
  const claimed = new Set([...climates, ...locks, ...zones].map((e) => e.id));
  const rest = visible.filter((e) => !claimed.has(e.id) && !carDevices.has(e.deviceId));

  const left: Item[] = [];
  const right: Item[] = [];
  /** Line (within its column) of each selectable item, for scrolling. */
  const leftAt: number[] = [];
  const rightAt: number[] = [];
  const selected = (pane: "left" | "right", list: Item[]) =>
    ui.pane === pane && ui.index === list.length;
  const cursor = (on: boolean) => (on ? `${c.bold(SYMBOL.cursor)} ` : "  ");

  const wide = ui.cols >= 100;
  const leftW = wide ? Math.max(60, Math.floor((ui.cols - 1) * 0.6)) : ui.cols;
  const rightW = wide ? ui.cols - leftW - 1 : ui.cols;

  // ───────── left: rooms (or devices, for things not in a room) ─────────
  const groups = new Map<string, { name: string; entities: Row[]; area: boolean }>();
  for (const entity of rest) {
    const area = data.areas.find((a) => a.id === entity.effectiveAreaId);
    const device = data.devices.find((d) => d.id === entity.deviceId);
    const key = area ? `a:${area.id}` : device ? `d:${device.id}` : "other";
    const name = String(area?.name ?? device?.name ?? "Other");
    if (!groups.has(key)) groups.set(key, { name, entities: [], area: Boolean(area) });
    groups.get(key)?.entities.push(entity);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => Number(b.area) - Number(a.area) || a.name.localeCompare(b.name),
  );

  const leftLines: string[] = [];
  const inner = leftW - 4;
  // The state is what the row is for, so it is sized first; the id gets what is left and is
  // dropped altogether on a narrow terminal.
  const minState = 12;
  const nameW = Math.min(
    22,
    Math.max(12, ...rest.map((e) => width(String(e.name)))),
    Math.max(8, inner - 3 - minState),
  );
  const longestId = Math.max(12, ...rest.map((e) => String(e.id).length));
  // What the widest state on screen actually needs, bar included, so ids are not cut short
  // to leave room nothing uses.
  const stateNeeds = Math.min(
    30,
    Math.max(
      minState,
      ...rest.map((e) => {
        const shown = present(stateOf(data, e), now);
        return width(shown.text) + (shown.level === undefined ? 0 : 11);
      }),
    ),
  );
  const idRoom = inner - 2 - nameW - 1 - stateNeeds - 1;
  const idW = idRoom >= 12 ? Math.min(longestId, idRoom) : 0;
  const stateW = Math.max(minState, inner - 2 - nameW - 1 - (idW ? idW + 1 : 0));
  for (const group of ordered) {
    const lightsOn = group.entities.filter(
      (e) => e.domain === "light" && (stateOf(data, e)?.state as Row | undefined)?.on === true,
    ).length;
    const hasLights = group.entities.some((e) => e.domain === "light");
    const controls = group.entities.filter((e) => e.controllable).length;
    const detail = [
      hasLights ? `${plural(lightsOn, "light")} on` : undefined,
      controls ? plural(controls, "control") : plural(group.entities.length, "reading"),
    ]
      .filter(Boolean)
      .join(" · ");
    const body = group.entities.map((entity, row) => {
      const id = String(entity.id);
      const isSelected = selected("left", left);
      leftAt.push(leftLines.length + 1 + row);
      left.push({ entityId: id, kind: "entity" });
      const shown = present(stateOf(data, entity), now);
      const waiting = ui.pending.get(id);
      const viewOnly =
        !entity.controllable && !["sensor", "binary_sensor"].includes(String(entity.domain));
      let state: string;
      if (waiting) {
        state = `${fit(c.blue(`${SYMBOL.pending} ${waiting}`), stateW - 11)} ${c.dim("waiting…")}`;
      } else if (shown.level !== undefined && stateW >= width(shown.text) + 11) {
        state = `${fit(tint(shown), stateW - 11)} ${levelBar(shown)}`;
      } else {
        state = fit(`${tint(shown)}${viewOnly ? c.dim("  view only") : ""}`, stateW);
      }
      const line = `${cursor(isSelected)}${fit(String(entity.name), nameW)} ${idW ? `${c.dim(fit(id, idW))} ` : ""}${state}`;
      return isSelected ? highlight(fit(line, inner)) : line;
    });
    leftLines.push(...box(title(group.name, detail), body, leftW));
  }
  if (ui.recent.length > 0) {
    const body = ui.recent.slice(0, 5).map((r) => {
      const when = c.dim(
        `${since(r.at, now)}${now - r.at >= 60_000 && now - r.at < 21_600_000 ? " ago" : ""}`,
      );
      return `${fit(r.text, inner - width(when) - 1)} ${when}`;
    });
    leftLines.push(...box(title("Recent"), body, leftW));
  }

  // ───────── right: cards ─────────
  const rightLines: string[] = [];
  const rInner = rightW - 4;

  for (const entity of climates) {
    const record = stateOf(data, entity);
    const state = (record?.state ?? {}) as Row;
    const isSelected = selected("right", right);
    rightAt.push(rightLines.length + 1);
    right.push({ entityId: String(entity.id), kind: "climate" });
    const current =
      typeof state.currentTemp === "number"
        ? `${formatNumber(degrees(state.currentTemp))}${degreeUnit()}`
        : "—";
    const target =
      typeof state.targetTemp === "number" ? `${formatNumber(degrees(state.targetTemp))}°` : "—";
    const mode = String(state.mode ?? "off");
    const waiting = ui.pending.get(String(entity.id));
    const doing = waiting
      ? c.blue(`${SYMBOL.pending} ${waiting}`)
      : record?.available === false
        ? c.dim("Unavailable")
        : mode === "off"
          ? c.dim("Off")
          : c.amber(
              `${mode[0]?.toUpperCase()}${mode.slice(1)}${typeof state.targetTemp === "number" ? ` · holding ${target}` : ""}`,
            );
    const chips = MODES.map((m) => (m === mode ? c.chip(` ${m} `) : ` ${m} `)).join("");
    const first = `${cursor(isSelected)}${c.bold(current)}  ${doing}`;
    // A narrow card sheds its labels before it lets the target and the modes touch:
    // first "mode" (the chips say it themselves), then "target".
    const labelled = `  ${c.dim("target")} ${c.bold(target)}`;
    const controls =
      width(labelled) + 1 + width(chips) <= rInner ? labelled : `  ${c.bold(target)}`;
    const room = rInner - width(controls) - 1;
    const modes = width(chips) + 4 <= room ? `${c.dim("mode")}${chips}` : chips;
    const second = `${controls} ${padStart(modes, room)}`;
    rightLines.push(
      ...box(
        title("Thermostat", String(entity.name)),
        [isSelected ? highlight(fit(first, rInner)) : first, second],
        rightW,
      ),
    );
  }

  if (locks.length > 0) {
    const body: string[] = [];
    const start = rightLines.length + 1;
    for (const entity of locks) {
      const record = stateOf(data, entity);
      const state = (record?.state ?? {}) as Row;
      const isSelected = selected("right", right);
      rightAt.push(start + body.length);
      right.push({ entityId: String(entity.id), kind: "lock" });
      const waiting = ui.pending.get(String(entity.id));
      const shown = present(record, now);
      const symbol = state.jammed
        ? c.red(SYMBOL.warn)
        : state.locked
          ? c.green(SYMBOL.ok)
          : SYMBOL.open;
      const status = waiting ? c.blue(`${SYMBOL.pending} ${waiting}`) : `${symbol} ${tint(shown)}`;
      const [key, verb] = state.jammed
        ? ["r", "retry"]
        : state.locked
          ? ["u", "unlock"]
          : ["l", "lock"];
      const hint =
        entity.controllable && record?.available !== false
          ? `${c.key(` ${key} `)} ${verb}`
          : c.dim("view only");
      // The name takes whatever the status and the key hint leave.
      const lockW = Math.max(8, rInner - 2 - 1 - LOCK_STATUS_W - 1 - width(hint));
      const lead = `${cursor(isSelected)}${fit(String(entity.name), lockW)} ${status}`;
      const line = `${fit(lead, rInner - width(hint) - 1)} ${hint}`;
      body.push(isSelected ? highlight(fit(line, rInner)) : line);
      if (state.jammed) {
        body.push(c.red(`  The ${String(entity.name).toLowerCase()} didn't finish turning.`));
        body.push(c.red("  Check the bolt isn't blocked, then retry."));
      }
    }
    const open = locks.filter(
      (e) => (stateOf(data, e)?.state as Row | undefined)?.locked === false,
    ).length;
    rightLines.push(...box(title("Locks", open ? `${open} unlocked` : "all locked"), body, rightW));
  }

  // carsFrom returns one car per vehicle device, in device order, so the two line up.
  const vehicleDevices = data.devices.filter((d) => carDevices.has(d.id));
  const cars = carsFrom(data.entities, data.devices, data.states)
    .map((car, i) => ({ car, device: vehicleDevices[i] }))
    .filter(
      ({ car }) => !needle || `${car.name} ${car.model ?? ""}`.toLowerCase().includes(needle),
    );
  for (const { car, device } of cars) {
    // Enter on a car opens the history of what it was doing (or its battery, failing that).
    const mine = data.entities.filter((e) => e.deviceId === device?.id && !e.hidden);
    const focus =
      mine.find((e) => String(e.uniqueId).endsWith("-state")) ??
      mine.find((e) => /-battery(_level)?$/.test(String(e.uniqueId)));
    const isSelected = focus !== undefined && selected("right", right);
    if (focus) {
      rightAt.push(rightLines.length + 1);
      right.push({ entityId: String(focus.id), kind: "car" });
    }
    const [gauge, doing] = carLines(car, Math.max(10, rInner - 28), now);
    const detail = [car.model, car.place, car.pluggedIn ? "plugged in" : undefined]
      .filter(Boolean)
      .join(" · ");
    const first = `${cursor(isSelected)}${gauge}`;
    rightLines.push(
      ...box(
        title(car.name, detail),
        [isSelected ? highlight(fit(first, rInner)) : first, `  ${doing}`],
        rightW,
      ),
    );
  }

  if (zones.some((e) => e.domain === "switch" && !String(e.uniqueId).endsWith("-enabled"))) {
    const body: string[] = [];
    const start = rightLines.length + 1;
    const switches = zones.filter(
      (e) => e.domain === "switch" && !String(e.uniqueId).endsWith("-enabled"),
    );
    const prefix = String(data.devices.find((d) => d.id === switches[0]?.deviceId)?.name ?? "");
    // The status is short ("Off") far more often than not, so it is sized to what is
    // actually shown and the zone's name gets the rest of the line.
    const rows = switches.map((entity) => {
      const record = stateOf(data, entity);
      const name = String(entity.name).startsWith(prefix)
        ? String(entity.name).slice(prefix.length).trim()
        : String(entity.name);
      const waiting = ui.pending.get(String(entity.id));
      const endsAt = (record?.attributes as Row | undefined)?.endsAt;
      const watered = (record?.attributes as Row | undefined)?.lastWateredAt;
      const on = (record?.state as Row | undefined)?.on === true;
      const minutes =
        typeof endsAt === "number" ? Math.max(0, Math.ceil((endsAt - now) / 60_000)) : undefined;
      const status = waiting
        ? c.blue(`${SYMBOL.pending} ${waiting}`)
        : record?.available === false
          ? c.dim("Unavailable")
          : on
            ? c.amber(`Watering${minutes === undefined ? "" : ` · ${minutes} min left`}`)
            : // An idle zone shows when it last ran; kept short so the zone's name fits.
              c.dim(typeof watered === "number" ? ago(watered, now) : "Off");
      return { id: String(entity.id), name, status };
    });
    const statusW = Math.max(...rows.map((r) => width(r.status)));
    const zoneW = Math.max(8, rInner - 2 - 1 - statusW);
    for (const row of rows) {
      const isSelected = selected("right", right);
      rightAt.push(start + body.length);
      right.push({ entityId: row.id, kind: "zone" });
      const line = `${cursor(isSelected)}${fit(row.name, zoneW)} ${row.status}`;
      body.push(isSelected ? highlight(fit(line, rInner)) : line);
    }
    const flagged = (suffix: string) => {
      const entity = zones.find((e) => String(e.uniqueId).endsWith(suffix));
      return entity ? (stateOf(data, entity)?.state as Row | undefined) : undefined;
    };
    const next = flagged("-next-run")?.value;
    const detail = [
      flagged("-enabled")?.on === false ? "standby" : undefined,
      typeof next === "string"
        ? `next ${next.replace(", end by", " by")}`
        : flagged("-enabled")?.on
          ? "schedules on"
          : undefined,
      flagged("-rain-delay")?.on ? "rain delay" : undefined,
      flagged("-rain-sensor")?.on ? "rain sensor wet" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    rightLines.push(...box(title("Irrigation", detail), body, rightW));
  }

  if (left.length === 0 && right.length === 0 && rightLines.length === 0 && ui.filter) {
    leftLines.unshift(
      ...box(title("Nothing matches", ui.filter), [c.dim("Press esc to clear the filter.")], leftW),
    );
  }

  // ───────── header ─────────
  const hour = new Date(now).getHours();
  const greeting =
    hour < 5
      ? "Good night"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(now);
  const spread = (a: string, b: string) =>
    `${a}${" ".repeat(Math.max(1, ui.cols - width(a) - width(b)))}${b}`;
  const shownEntities = data.entities.filter((e) => !e.hidden);
  const allLocks = shownEntities.filter((e) => e.domain === "lock" && !carDevices.has(e.deviceId));
  const lockStates = allLocks.map((e) => (data.states.get(String(e.id))?.state ?? {}) as Row);
  const jammed = lockStates.filter((s) => s.jammed).length;
  const unlocked = lockStates.filter((s) => s.locked === false).length;
  const lightsOn = shownEntities.filter(
    (e) =>
      e.domain === "light" &&
      (data.states.get(String(e.id))?.state as Row | undefined)?.on === true,
  ).length;
  const summary = [
    allLocks.length
      ? `Locks ${jammed ? c.red(`${SYMBOL.warn} ${jammed} jammed`) : unlocked ? `${SYMBOL.open} ${unlocked} unlocked` : c.green(`${SYMBOL.ok} all locked`)}`
      : undefined,
    shownEntities.some((e) => e.domain === "light")
      ? `Lights ${c.amber(`${lightsOn} on`)}`
      : undefined,
    ...shownEntities
      .filter((e) => e.domain === "climate")
      .slice(0, 1)
      .map((e) => {
        const s = (data.states.get(String(e.id))?.state ?? {}) as Row;
        const t =
          typeof s.currentTemp === "number"
            ? `${formatNumber(degrees(s.currentTemp))}${degreeUnit()} `
            : "";
        return `${e.name} ${c.amber(`${t}${s.mode ?? ""}`)}`;
      }),
  ]
    .filter(Boolean)
    .join("   ");
  const outside = data.entities.find(
    (e) =>
      e.domain === "sensor" &&
      !carDevices.has(e.deviceId) && // a car's outside temperature is wherever the car is
      /outside|outdoor/i.test(`${e.id}`) &&
      (data.states.get(String(e.id))?.state as Row | undefined)?.deviceClass === "temperature",
  );
  const outsideState = outside
    ? (data.states.get(String(outside.id))?.state as Row | undefined)
    : undefined;
  const outsideShown =
    typeof outsideState?.value === "number"
      ? inUnits(
          outsideState.value,
          typeof outsideState.unit === "string" ? outsideState.unit : "°C",
        )
      : undefined;
  const header = [
    spread(
      `${c.accent("casita")}${c.dim(" · home · ")}${greeting}`,
      `${c.dim(`${date} · `)}${c.bold(clock(now))}`,
    ),
    spread(
      summary,
      outsideShown
        ? `${c.dim("Outside")} ${formatNumber(outsideShown.value)}${outsideShown.unit}`
        : "",
    ),
    "",
  ];

  // ───────── footer ─────────
  const bad = data.integrations.filter((i) => i.status !== "running");
  const core = !ui.connected
    ? c.red(`${SYMBOL.warn} disconnected`)
    : bad.length
      ? c.red(`${SYMBOL.warn} ${bad.map((i) => i.integrationId).join(", ")} not running`)
      : c.dim(`core connected · ${plural(data.integrations.length, "integration")} ok`);
  const hint = (key: string, what: string) => `${c.key(` ${key} `)} ${c.dim(what)}`;
  const hints = ui.filtering
    ? `${c.bold("filter:")} ${ui.filter}▏   ${hint("enter", "keep")}  ${hint("esc", "clear")}`
    : [
        hint("↑↓", "move"),
        hint("tab", "pane"),
        hint("space", "toggle"),
        hint("←→", "dim · temp"),
        hint("m", "mode"),
        hint("enter", "detail"),
        hint("/", "filter"),
        hint("q", "quit"),
      ].join("  ");
  const footer = [
    "",
    spread(ui.status || (ui.filter ? c.dim(`filter: ${ui.filter}`) : ""), core),
    hints,
  ];

  // ───────── body: detail view, or the two columns ─────────
  let body: string[];
  let focus = 0;
  let scrolled = 0;
  let shownRows = Number.POSITIVE_INFINITY;
  if (ui.detail) {
    body = detailView(data, ui, ui.detail);
  } else if (wide) {
    body = [];
    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
      body.push(`${pad(leftLines[i] ?? "", leftW)} ${rightLines[i] ?? ""}`);
    }
    focus = (ui.pane === "left" ? leftAt[ui.index] : rightAt[ui.index]) ?? 0;
  } else {
    body = [...leftLines, ...rightLines];
    focus =
      (ui.pane === "left" ? leftAt[ui.index] : leftLines.length + (rightAt[ui.index] ?? 0)) ?? 0;
  }
  if (body.length === 0)
    body = [c.dim("Nothing to show yet. Add an integration, then it will appear here.")];

  if (ui.rows !== undefined) {
    // On a very short terminal the header goes first, then the message line; the keys stay.
    if (ui.rows < header.length + footer.length + 3) header.length = 0;
    if (ui.rows < footer.length + 1) footer.splice(0, footer.length - Math.max(1, ui.rows - 1));
    const room = Math.max(0, ui.rows - header.length - footer.length);
    const offset = Math.min(
      Math.max(0, focus - Math.floor(room / 2)),
      Math.max(0, body.length - room),
    );
    body = body.slice(offset, offset + room);
    while (body.length < room) body.push("");
    scrolled = offset;
    shownRows = room;
  }
  // Where each selectable row ended up on screen, for the mouse.
  const hits: Hit[] = [];
  if (!ui.detail) {
    const place = (
      pane: "left" | "right",
      at: number[],
      shift: number,
      from: number,
      to: number,
    ) => {
      at.forEach((bodyLine, index) => {
        const row = bodyLine + shift - scrolled;
        if (row >= 0 && row < shownRows)
          hits.push({ line: header.length + row, from, to, pane, index });
      });
    };
    place("left", leftAt, 0, 0, leftW - 1);
    if (wide) place("right", rightAt, 0, leftW + 1, ui.cols - 1);
    else place("right", rightAt, leftLines.length, 0, rightW - 1);
  }
  // Nothing may run past the edge: a wrapped line would push the rest of the screen down.
  const lines = [...header, ...body, ...footer].map((line) => truncate(line, ui.cols));
  return { lines, left, right, hits };
}

const isCar = (device: Row) => ["teslamate", "tesla"].includes(kindOf(device));

/** Every reading a car's device has, by name, in two columns when there is room. */
function carReadings(data: DashData, device: Row, inner: number, now: number): string[] {
  const prefix = `${device.name} `;
  const cells = data.entities
    .filter((e) => e.deviceId === device.id && !e.hidden)
    .map((entity) => {
      const name = String(entity.name);
      const label = name.startsWith(prefix) ? name.slice(prefix.length) : name;
      const record = data.states.get(String(entity.id));
      const { latitude, longitude, heading } = (record?.attributes ?? {}) as Row;
      // Where the car is: the place's name, then the position itself.
      const position =
        typeof latitude === "number" && typeof longitude === "number"
          ? c.dim(
              ` · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}${typeof heading === "number" ? ` · heading ${Math.round(heading) % 360}°` : ""}`,
            )
          : "";
      return {
        label: label[0]?.toUpperCase() + label.slice(1),
        value: tint(present(record, now)) + position,
        wide: position !== "",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const labelW = Math.min(28, Math.max(0, ...cells.map((cell) => width(cell.label))) + 2);
  const columns = inner >= 96 ? 2 : 1;
  const cellW = Math.floor((inner - (columns - 1) * 2) / columns);
  const line = (cell: (typeof cells)[number], w: number) =>
    fit(`${c.dim(pad(truncate(cell.label, labelW - 2), labelW))}${cell.value}`, w);
  // A position is too long for half the width, so it gets a line of its own above the rest.
  const text = cells.filter((cell) => !cell.wide).map((cell) => line(cell, cellW));
  const perColumn = Math.ceil(text.length / columns);
  return [
    ...cells.filter((cell) => cell.wide).map((cell) => line(cell, inner).trimEnd()),
    ...Array.from({ length: perColumn }, (_, i) =>
      [text[i], text[i + perColumn]]
        .slice(0, columns)
        .filter((cell) => cell !== undefined)
        .join("  ")
        .trimEnd(),
    ),
  ];
}

function detailView(data: DashData, ui: DashUi, entityId: string): string[] {
  const { cols, now } = ui;
  const entity = data.entities.find((e) => e.id === entityId);
  if (!entity) return box(title("Detail"), [c.dim("That entity is gone.")], cols);
  const record = data.states.get(entityId);
  const device = data.devices.find((d) => d.id === entity.deviceId);
  const area = data.areas.find((a) => a.id === entity.effectiveAreaId);
  const row = (label: string, value: unknown) => `${c.dim(pad(label, 14))}${value ?? c.dim("—")}`;
  const time = (ms: unknown) =>
    typeof ms === "number" ? `${since(ms, now)} (${new Date(ms).toLocaleString()})` : undefined;
  const details = [
    row("State", tint(present(record, now))),
    row("Raw", record ? JSON.stringify(record.state) : undefined),
    row("Attributes", record?.attributes ? JSON.stringify(record.attributes) : undefined),
    row("Changed", time(record?.changedAt)),
    row("Updated", time(record?.updatedAt)),
    "",
    row("Device", device ? `${device.name}${device.model ? ` (${device.model})` : ""}` : undefined),
    row("Area", area?.name),
    row("Integration", entity.integrationId),
    row("Controls", entity.controllable ? JSON.stringify(entity.capabilities) : "view only"),
  ];
  // A car's card stands for the whole car, so its detail lists everything the car reports.
  if (device && isCar(device) && /-(state|battery(_level)?)$/.test(String(entity.uniqueId))) {
    // The device, area, and integration lines stay; the single entity's own lines make way.
    details.splice(0, details.length - 4, ...carReadings(data, device, cols - 4, now), "");
  }
  const hint = (key: string, what: string) => `${c.key(` ${key} `)} ${c.dim(what)}`;
  const history = ui.history?.entityId === entityId ? ui.history : undefined;
  if (!history) {
    return box(
      title(String(entity.name), entityId),
      [...details, "", c.dim("Press any key to go back.")],
      cols,
    );
  }

  const unit = (record?.state as Row | undefined)?.unit;
  const series: Series | undefined =
    history.series ??
    (history.points && {
      kind: "value",
      points: history.points,
      unit: typeof unit === "string" ? unit : undefined,
    });
  const ranges = (Object.keys(RANGES) as Range[])
    .map((range) =>
      range === history.range
        ? c.chip(` ${RANGE_LABEL[range]} `)
        : c.dim(` ${RANGE_LABEL[range]} `),
    )
    .join("");
  const keys = `${hint("h", "hour")}  ${hint("d", "day")}  ${hint("w", "week")}   ${c.dim("any other key to go back")}`;
  const notes = history.truncated
    ? [c.dim("Only the oldest 10,000 readings of this range are shown.")]
    : [];

  const from = now - RANGES[history.range];
  const graphAt = (height: number): string[] =>
    history.error
      ? [c.red(history.error)]
      : !series
        ? [c.dim("Loading history…")]
        : series.kind === "value"
          ? chart(series.points, { from, to: now, width: cols - 4, height, unit: series.unit })
          : series.kind === "category"
            ? categoryTimeline(series.points, { from, to: now, width: cols - 4 })
            : timeline(series.states, {
                from,
                to: now,
                width: cols - 4,
                labels: series.labels,
                tone: series.tone === "green" ? c.green : c.amber,
              });

  // Everything in the box is counted against the terminal's height. A chart of numbers
  // takes whatever height is left; the details are shown only if they fit below it.
  const room = Math.max(3, (ui.rows ?? 46) - 8); // less the header, footer, and the box's borders
  const around = 2 + notes.length + 2; // the History line and a blank above; a blank and the keys below
  const below = details.length + 1;
  let graph: string[];
  let showDetails: boolean;
  if (series?.kind === "value" && !history.error) {
    const axes = 4; // the axis, the time labels, a blank, and the summary
    showDetails = room - around - axes - below >= 4;
    graph = graphAt(Math.max(2, Math.min(12, room - around - axes - (showDetails ? below : 0))));
  } else {
    graph = graphAt(0);
    showDetails = room - around - graph.length >= below;
  }
  let lines = [
    `${c.bold("History")} ${ranges}`,
    "",
    ...graph,
    ...notes,
    ...(showDetails ? ["", ...details] : []),
    "",
    keys,
  ];
  // Still too tall for a very short terminal: blank lines go first, then the bottom of the
  // graph. The range keys stay, since they are the only way to know what can be pressed.
  if (lines.length > room) lines = lines.filter((line) => line !== "");
  if (lines.length > room) lines = [...lines.slice(0, room - 1), keys];
  return box(title(String(entity.name), entityId), lines, cols);
}
