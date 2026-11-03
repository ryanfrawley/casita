// The dashboard's live half: loads data, follows events, reads keys, and redraws.

import {
  type CasitaClient,
  CasitaError,
  degrees,
  setUnits,
  toCelsius,
  unitSystem,
} from "@casita/client";
import { seriesFor } from "./chart.ts";
import {
  type DashData,
  type DashHistory,
  type DashUi,
  type Frame,
  hitAt,
  type Item,
  RANGES,
  type Range,
  render,
} from "./dash.ts";
import { formatNumber, present, type Row, tint } from "./present.ts";
import {
  c,
  SYMBOL,
  setColor,
  setTheme,
  type Theme,
  themeFromEnv,
  themeFromReply,
} from "./style.ts";

export interface DashOptions {
  /** Print one frame and exit. Implied when output is not a terminal. */
  once?: boolean;
  width?: number;
  /** Colors for a dark or light background; by default the terminal is asked which it has. */
  theme?: Theme;
  /** False leaves the mouse to the terminal, for selecting and copying text. */
  mouse?: boolean;
}

/**
 * Asks the terminal for its background color (OSC 11) and waits briefly for the answer.
 * Terminals that do not answer leave the theme unknown. Stdin must already be in raw mode.
 */
function askTerminalTheme(timeoutMs = 200): Promise<Theme | undefined> {
  return new Promise((resolve) => {
    let reply = "";
    const finish = (theme: Theme | undefined) => {
      clearTimeout(timer);
      process.stdin.off("data", onReply);
      resolve(theme);
    };
    const onReply = (chunk: Buffer) => {
      reply += String(chunk);
      // The answer can arrive in pieces; half a color would be misread, so wait for its end.
      if (REPLY_END.test(reply)) finish(themeFromReply(reply));
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    process.stdin.on("data", onReply);
    process.stdout.write("\x1b]11;?\x07");
  });
}

/** Narrower than this and the layout has nothing sensible to draw. */
const MIN_COLS = 40;
/** The most history rows the server returns in one request. */
const HISTORY_LIMIT = 10_000;
const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const TOPOLOGY = /^(entity|device|area)_/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply ends with BEL or ESC \
const REPLY_END = /\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/;
// A whole escape sequence (CSI, OSC, SS3, or alt plus a key), else a single character.
const SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are control characters
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO[\s\S]|\x1b[^[\]O\x1b]|[\s\S]/uy;
// The start of a sequence whose end has not arrived yet.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are control characters
const UNFINISHED = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|O)$/;
/** Longer than any real sequence; an unfinished one past this is noise, not something to wait on. */
const MAX_CARRY = 256;

/**
 * Splits terminal input into keys and whole escape sequences. A sequence cut off by the end
 * of the chunk comes back as `rest`, to be put in front of the next chunk. A lone escape at
 * the end is the Escape key.
 */
export function tokenize(input: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let at = 0;
  while (at < input.length) {
    const remainder = input.slice(at);
    if (UNFINISHED.test(remainder)) {
      return { keys, rest: remainder.length > MAX_CARRY ? "" : remainder };
    }
    SEQUENCE.lastIndex = at;
    const key = SEQUENCE.exec(input)?.[0] ?? remainder.slice(0, 1);
    keys.push(key);
    at += key.length;
  }
  return { keys, rest: "" };
}

/** The escape sequences that mean something here: the arrow keys. Mouse reports are read apart. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are control characters
const ARROW = /^\x1b(?:\[|O)([A-D])$/;
// Mouse reporting: button presses, in the SGR form that works past column 223.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

export interface MouseEvent {
  /** "left", "middle", "right", or a wheel direction. */
  button: "left" | "middle" | "right" | "up" | "down";
  /** Zero-based screen position. */
  line: number;
  column: number;
  /** False for a button release. */
  press: boolean;
}

/** Reads an SGR mouse report (`ESC [ < button ; column ; line M`); undefined for anything else. */
export function parseMouse(sequence: string): MouseEvent | undefined {
  const match = /\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (!match) return undefined;
  const code = Number(match[1]);
  // 128 marks the extra buttons (back, forward), which mean nothing here.
  if (code & 128) return undefined;
  // With 64 set the low bits name a wheel direction; the last two are the horizontal wheel.
  const button = (code & 64 ? (["up", "down"] as const) : (["left", "middle", "right"] as const))[
    code & 3
  ];
  if (!button) return undefined;
  return {
    button,
    line: Number(match[3]) - 1,
    column: Number(match[2]) - 1,
    // 32 marks motion: a drag with the button held is not a new press.
    press: match[4] === "M" && (code & 32) === 0,
  };
}

/** What a state change reads like in the Recent list, if it is worth mentioning. */
function describe(entity: Row, before: Row | undefined, after: Row): string | undefined {
  const name = String(entity.name);
  const was = (before?.state ?? {}) as Row;
  const is = after.state as Row;
  // The first report of something new is not news.
  if (!before) return undefined;
  if (before.available !== after.available) {
    return after.available ? `${name} is back` : `${name} went unavailable`;
  }
  switch (is.domain) {
    case "lock":
      if (is.jammed && !was.jammed) return `${name} jammed`;
      return was.locked === is.locked ? undefined : `${name} ${is.locked ? "locked" : "unlocked"}`;
    case "light":
    case "switch":
      return was.on === is.on || before === undefined
        ? undefined
        : `${name} turned ${is.on ? "on" : "off"}`;
    case "cover":
      if (was.position === is.position) return undefined;
      return is.position === 0
        ? `${name} closed`
        : is.position === 1
          ? `${name} opened`
          : undefined;
    case "binary_sensor": {
      if (was.on === is.on || before === undefined) return undefined;
      const opening = is.deviceClass === "door" || is.deviceClass === "window";
      if (opening) return `${name} ${is.on ? "opened" : "closed"}`;
      return is.on ? `${name}: ${present(after).text.split(" · ")[0]?.toLowerCase()}` : undefined;
    }
    case "button":
      return typeof is.pressedAt === "number" && was.pressedAt !== is.pressedAt
        ? `${name} pressed`
        : undefined;
    case "sensor":
      // Only word-valued sensors tell a story: a car going from asleep to driving.
      return typeof is.value === "string" && before !== undefined && was.value !== is.value
        ? `${name}: ${is.value}`
        : undefined;
    default:
      return undefined;
  }
}

export async function runDash(client: CasitaClient, options: DashOptions = {}): Promise<void> {
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY) && !options.once;
  const data: DashData = {
    entities: [],
    devices: [],
    areas: [],
    states: new Map(),
    integrations: [],
  };
  const ui: DashUi = {
    // A terminal can report a size of zero (some multiplexers, a pty not sized yet).
    cols: Math.max(MIN_COLS, options.width || process.stdout.columns || 120),
    rows: interactive ? process.stdout.rows || 46 : undefined,
    now: Date.now(),
    pane: "left",
    index: 0,
    filter: "",
    filtering: false,
    pending: new Map(),
    status: "",
    recent: [],
    connected: true,
  };
  let frame: Frame = { lines: [], left: [], right: [], hits: [] };

  const load = async () => {
    const [entities, devices, areas, states, integrations] = await Promise.all([
      client.request("get_entities", {}),
      client.request("get_devices", {}),
      client.request("get_areas", {}),
      client.request("get_states", {}),
      client.request("get_integrations", {}),
    ]);
    data.entities = entities as Row[];
    data.devices = devices as Row[];
    data.areas = areas as Row[];
    data.integrations = integrations as Row[];
    data.states = new Map((states as Row[]).map((s) => [String(s.entityId), s]));
  };
  await load();

  if (!interactive) {
    if (!process.stdout.isTTY) setColor(false);
    console.log(render(data, ui).lines.join("\n"));
    return;
  }

  // ───────── drawing ─────────
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    scheduled = undefined;
    ui.now = Date.now();
    ui.cols = Math.max(MIN_COLS, process.stdout.columns || ui.cols);
    ui.rows = process.stdout.rows || ui.rows;
    frame = render(data, ui);
    // Keep the cursor on something that exists as the lists change under it.
    const list = ui.pane === "left" ? frame.left : frame.right;
    if (ui.index >= list.length && list.length > 0) {
      ui.index = list.length - 1;
      frame = render(data, ui);
    }
    // Each line is cleared before it is written. Clearing after it would erase the last
    // column of a full-width line, where the cursor is left waiting to wrap.
    process.stdout.write(`\x1b[H${frame.lines.map((line) => `\x1b[2K${line}`).join("\n")}\x1b[J`);
  };
  const redraw = () => {
    scheduled ??= setTimeout(draw, 30);
  };

  // ───────── events ─────────
  let reload: ReturnType<typeof setTimeout> | undefined;
  client.onEvent(({ event }) => {
    if (event.type === "state_changed") {
      const id = String(event.entityId);
      const after = event.new as Row;
      const entity = data.entities.find((e) => e.id === id);
      const text =
        entity && !entity.hidden ? describe(entity, data.states.get(id), after) : undefined;
      if (text) ui.recent.unshift({ text, at: Date.now() });
      ui.recent.length = Math.min(ui.recent.length, 20);
      data.states.set(id, after);
      extendHistory(id, after);
    } else if (event.type === "integration_status") {
      const entry = data.integrations.find((i) => i.integrationId === event.integrationId);
      if (entry) entry.status = event.status;
      else data.integrations.push({ integrationId: event.integrationId, status: event.status });
    } else if (
      event.type === "config_changed" &&
      ["server.units", "server", ""].includes(String(event.path))
    ) {
      void client.request("get_status", {}).then(
        (status) => {
          setUnits((status as Row).units === "imperial" ? "imperial" : "metric");
          // An open chart was drawn in the old units.
          if (ui.history?.series) chartFrom(ui.history);
          redraw();
        },
        () => {},
      );
    } else if (TOPOLOGY.test(event.type)) {
      clearTimeout(reload);
      reload = setTimeout(() => void load().then(redraw, () => {}), 200);
    }
    redraw();
  });
  await client.request("subscribe", {});

  // ───────── commands ─────────
  const send = (entityId: string, command: Row, waiting: string) => {
    const entity = data.entities.find((e) => e.id === entityId);
    const via = String(entity?.integrationId ?? "the device").split(".")[0];
    const started = Date.now();
    ui.pending.set(entityId, waiting);
    ui.status = c.blue(
      `${SYMBOL.pending} ${entityId}: command sent, waiting for ${via} to confirm…`,
    );
    redraw();
    client
      .request("send_command", {
        entityId,
        command: { domain: entityId.split(".")[0], ...command } as never,
        confirm: true,
      })
      .then(
        (result) => {
          const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
          const shown = tint(present(data.states.get(entityId)));
          ui.status =
            (result as Row).status === "confirmed"
              ? `${c.amber(SYMBOL.ok)} ${entityId}: ${shown} ${c.dim(`· confirmed by ${via} in ${took}`)}`
              : c.red(`${SYMBOL.warn} ${entityId}: sent, but the device did not confirm`);
        },
        (err: unknown) => {
          ui.status = c.red(
            `${SYMBOL.warn} ${entityId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      )
      .finally(() => {
        ui.pending.delete(entityId);
        redraw();
      });
  };

  const entityOf = (item: Item | undefined) => data.entities.find((e) => e.id === item?.entityId);
  const stateOf = (id: string) => (data.states.get(id)?.state ?? {}) as Row;
  const selected = () => (ui.pane === "left" ? frame.left : frame.right)[ui.index];
  const note = (text: string) => {
    ui.status = c.dim(text);
    redraw();
  };

  const toggle = () => {
    const entity = entityOf(selected());
    if (!entity) return;
    const id = String(entity.id);
    if (!entity.controllable) return note(`${id} is view only`);
    if (data.states.get(id)?.available === false) return note(`${id} is unavailable`);
    // A second toggle before the first lands would only repeat it: the state has not changed yet.
    if (ui.pending.has(id)) return note(`${id}: still waiting for the last command`);
    const state = stateOf(id);
    switch (entity.domain) {
      case "light":
      case "switch":
        return send(
          id,
          { action: state.on ? "turn_off" : "turn_on" },
          state.on ? "Turning off…" : "Turning on…",
        );
      case "cover": {
        const open = typeof state.position === "number" && state.position > 0;
        return send(id, { action: open ? "close" : "open" }, open ? "Closing…" : "Opening…");
      }
      case "lock":
        return send(
          id,
          { action: state.locked ? "unlock" : "lock" },
          state.locked ? "Unlocking…" : "Locking…",
        );
      case "button":
        return send(id, { action: "press" }, "Pressing…");
      default:
        return note("Use ← and → for temperature, m for mode");
    }
  };

  const dim = (direction: -1 | 1) => {
    const entity = entityOf(selected());
    if (!entity) return;
    const id = String(entity.id);
    if (entity.domain === "climate") return nudge(direction);
    if (entity.domain !== "light" || !(entity.capabilities as Row | undefined)?.brightness) {
      return note(`${id} has no brightness to change`);
    }
    const state = stateOf(id);
    const current = state.on ? (typeof state.brightness === "number" ? state.brightness : 1) : 0;
    const next = Math.min(1, Math.max(0, Math.round((current + direction * 0.1) * 10) / 10));
    if (next === current) return;
    send(
      id,
      { action: "turn_on", brightness: next },
      next === 0 ? "Turning off…" : `Setting ${Math.round(next * 100)}%…`,
    );
  };

  /** The climate under the cursor, or the only one there is. */
  const climate = (): Row | undefined => {
    const under = entityOf(selected());
    if (under?.domain === "climate") return under;
    const all = data.entities.filter((e) => e.domain === "climate" && !e.hidden);
    return all.length === 1 ? all[0] : undefined;
  };
  const nudge = (direction: -1 | 1) => {
    const entity = climate();
    if (!entity) return note("Select a thermostat first (tab, then ↑↓)");
    const id = String(entity.id);
    const range = (entity.capabilities as Row | undefined)?.tempRange as Row | undefined;
    const step = typeof range?.step === "number" ? range.step : 0.5;
    const target = stateOf(id).targetTemp;
    if (typeof target !== "number") return note(`${id} has not reported a target yet`);
    const min = typeof range?.min === "number" ? range.min : Number.NEGATIVE_INFINITY;
    const max = typeof range?.max === "number" ? range.max : Number.POSITIVE_INFINITY;
    // In Fahrenheit a step is one whole degree from what is shown; the device is still told Celsius.
    const stepped =
      unitSystem() === "imperial"
        ? toCelsius(Math.round(degrees(target)) + direction)
        : target + direction * step;
    // Rounded so that steps of 0.1 do not read 21.200000000000003; finer in Fahrenheit, where
    // a tenth of a degree Celsius would show a whole degree as 71.1.
    const grain = unitSystem() === "imperial" ? 100 : 10;
    const next = Math.min(max, Math.max(min, Math.round(stepped * grain) / grain));
    if (next === target)
      return note(`${id} is at its ${direction > 0 ? "highest" : "lowest"} setting`);
    send(id, { action: "set_target", temp: next }, `Setting ${formatNumber(degrees(next))}°…`);
  };
  const cycleMode = () => {
    const entity = climate();
    if (!entity) return note("Select a thermostat first (tab, then ↑↓)");
    const modes = ["heat", "cool", "auto", "off"];
    const next =
      modes[(modes.indexOf(String(stateOf(String(entity.id)).mode)) + 1) % modes.length] ?? "off";
    send(String(entity.id), { action: "set_mode", mode: next }, `Switching to ${next}…`);
  };

  /** u, l, r act on the lock under the cursor, or on the only lock they could mean. */
  const lockKey = (key: "u" | "l" | "r") => {
    const fits = (e: Row) => {
      const s = stateOf(String(e.id));
      return key === "r"
        ? s.jammed === true
        : key === "u"
          ? s.locked === true && !s.jammed
          : s.locked === false;
    };
    const under = entityOf(selected());
    const candidates = data.entities.filter(
      (e) => e.domain === "lock" && e.controllable && !e.hidden && fits(e),
    );
    const lock =
      under?.domain === "lock" && fits(under)
        ? under
        : candidates.length === 1
          ? candidates[0]
          : undefined;
    if (!lock)
      return note(
        candidates.length > 1 ? "Select the lock first (tab, then ↑↓)" : "No lock to do that to",
      );
    const action = key === "u" ? "unlock" : "lock";
    send(
      String(lock.id),
      { action },
      key === "u" ? "Unlocking…" : key === "r" ? "Retrying…" : "Locking…",
    );
  };

  // ───────── history for the detail view ─────────
  /** The records behind the open chart; live changes are added to them as they arrive. */
  let records: Row[] | undefined;
  /** Changes that arrived while the history was still loading. */
  let early: Row[] = [];
  const domainOf = (entityId: string) =>
    String(data.entities.find((e) => e.id === entityId)?.domain ?? entityId.split(".")[0]);
  const stamp = (record: Row) => (typeof record.updatedAt === "number" ? record.updatedAt : 0);

  /** Rebuilds what is drawn from the records, keeping one from before the range. */
  const chartFrom = (history: DashHistory) => {
    const cutoff = Date.now() - RANGES[history.range];
    const sorted = (records ?? []).sort((a, b) => stamp(a) - stamp(b));
    const firstInside = sorted.findIndex((r) => stamp(r) >= cutoff);
    // Everything before the range except the last record, which is what the range starts as.
    const keepFrom = firstInside === -1 ? sorted.length - 1 : firstInside - 1;
    records = keepFrom > 0 ? sorted.slice(keepFrom) : sorted;
    history.series = seriesFor(domainOf(history.entityId), records);
    // Nothing chartable after all (a sensor with no numbers and no words): the plain detail.
    if (!history.series && ui.history === history) ui.history = undefined;
  };

  const loadHistory = (entityId: string, range: Range) => {
    // A button has presses, not a state to chart.
    if (domainOf(entityId) === "button") {
      ui.history = undefined;
      return redraw();
    }
    const now = Date.now();
    const from = now - RANGES[range];
    const history: DashHistory = { entityId, range };
    ui.history = history;
    records = undefined;
    early = [];
    redraw();
    client
      .request("get_history", {
        entityId,
        from,
        to: now,
        limit: HISTORY_LIMIT,
        includePrevious: true,
      })
      .then(
        (result) => {
          // The user may have moved on, or asked again, while this was loading.
          if (ui.history !== history) return;
          const { resolution, records: loaded } = result as { resolution: string; records: Row[] };
          if (resolution !== "raw") {
            // Retention has already reduced this far back to summaries, which have another shape.
            history.error = `History this far back is kept only as ${resolution} summaries; try a shorter range.`;
            return;
          }
          // The record from before the range does not count against the limit.
          history.truncated = loaded.filter((r) => stamp(r) >= from).length >= HISTORY_LIMIT;
          const newest = stamp(loaded.at(-1) ?? {});
          // When the load was cut short, what happened between its end and now is unknown,
          // so later changes are not stitched on as if nothing had happened in between.
          records = history.truncated
            ? loaded
            : [...loaded, ...early.filter((r) => stamp(r) > newest)];
          early = [];
          chartFrom(history);
        },
        (err: unknown) => {
          if (ui.history !== history) return;
          early = [];
          history.error = `Could not load history: ${err instanceof Error ? err.message : String(err)}`;
        },
      )
      .finally(redraw);
  };

  /** A state change for the entity whose chart is open. */
  const extendHistory = (entityId: string, record: Row) => {
    const history = ui.history;
    if (!history || history.entityId !== entityId || history.error || history.truncated) return;
    if (!records) {
      early.push(record);
      return;
    }
    records.push(record);
    chartFrom(history);
  };

  // ───────── keys ─────────
  let finish: (error?: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = (error) => (error ? reject(error) : resolve());
  });
  const move = (delta: number) => {
    const list = ui.pane === "left" ? frame.left : frame.right;
    if (list.length > 0) ui.index = Math.min(list.length - 1, Math.max(0, ui.index + delta));
  };
  const onKey = (key: string) => {
    if (key === "\x03") return finish();
    if (ui.detail) {
      // In a sensor's detail, h, d, and w change the chart's range; anything else goes back.
      const range =
        ui.history && ({ h: "hour", d: "day", w: "week" } as const)[key as "h" | "d" | "w"];
      if (range) return loadHistory(ui.detail, range);
      ui.detail = undefined;
      ui.history = undefined;
      return redraw();
    }
    if (ui.filtering) {
      if (key === "\r") ui.filtering = false;
      else if (key === "\x1b") {
        ui.filtering = false;
        ui.filter = "";
      } else if (key === "\x7f") ui.filter = ui.filter.slice(0, -1);
      else if (key.length === 1 && key >= " ") ui.filter += key;
      ui.index = 0;
      return redraw();
    }
    ui.status = "";
    switch (key) {
      case "q":
        return finish();
      case "\x1b[A":
      case "k":
        move(-1);
        break;
      case "\x1b[B":
      case "j":
        move(1);
        break;
      case "\t": {
        const other = ui.pane === "left" ? "right" : "left";
        if ((other === "left" ? frame.left : frame.right).length > 0) {
          ui.pane = other;
          ui.index = 0;
        }
        break;
      }
      case " ":
        toggle();
        break;
      case "\x1b[D":
        dim(-1);
        break;
      case "\x1b[C":
        dim(1);
        break;
      case "m":
        cycleMode();
        break;
      case "u":
      case "l":
      case "r":
        lockKey(key);
        break;
      case "\r":
        openDetail();
        break;
      case "/":
        ui.filtering = true;
        break;
      case "\x1b":
        ui.filter = "";
        break;
      default:
        break;
    }
    redraw();
  };

  const openDetail = () => {
    const entity = entityOf(selected());
    ui.detail = selected()?.entityId;
    if (entity) loadHistory(String(entity.id), "day");
  };

  /**
   * The mouse: a click selects a row, a click on the row already selected acts on it,
   * a right click opens its detail, and the wheel moves the selection.
   */
  const onMouse = (event: MouseEvent) => {
    if (!event.press || ui.filtering) return;
    if (ui.detail) {
      // Like any key in the detail view, a click goes back.
      if (event.button === "left" || event.button === "right") onKey("\x1b");
      return;
    }
    if (event.button === "up" || event.button === "down") {
      move(event.button === "up" ? -1 : 1);
      return redraw();
    }
    // What was clicked is what is on screen, so a redraw still waiting has to happen first.
    if (scheduled) {
      clearTimeout(scheduled);
      draw();
    }
    const hit = hitAt(frame, event.line, event.column);
    if (!hit || event.button === "middle") return;
    const already = ui.pane === hit.pane && ui.index === hit.index;
    ui.pane = hit.pane;
    ui.index = hit.index;
    ui.status = "";
    const entity = entityOf((hit.pane === "left" ? frame.left : frame.right)[hit.index]);
    // Locks are never changed by a click; a slip of the hand should not unlock a door.
    const clickable =
      entity?.controllable &&
      ["light", "switch", "cover", "button"].includes(String(entity.domain));
    if (event.button === "right" || (already && !clickable)) openDetail();
    else if (already) toggle();
    redraw();
  };

  let carry = "";
  const onData = (chunk: Buffer) => {
    // A paste or fast typing can deliver several keys at once, and a sequence can span two chunks.
    const { keys, rest } = tokenize(carry + String(chunk));
    carry = rest;
    for (const key of keys) {
      const mouse = parseMouse(key);
      const arrow = ARROW.exec(key)?.[1];
      if (mouse) onMouse(mouse);
      else if (arrow) onKey(`\x1b[${arrow}`);
      // Any other sequence (a function key, a late answer about the background) is not typing.
      else if (key.length === 1) onKey(key);
    }
  };
  const tick = setInterval(redraw, 15_000);
  const offClose = client.onClose(() => {
    ui.connected = false;
    finish(new CasitaError("connection", "Connection closed"));
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  // Colors picked for a dark background are unreadable on a light one, and the reverse.
  const theme = options.theme ?? themeFromEnv() ?? (await askTerminalTheme());
  if (theme) setTheme(theme);
  process.stdout.write(`${ENTER_SCREEN}${options.mouse === false ? "" : MOUSE_ON}`);
  process.stdin.on("data", onData);
  process.stdout.on("resize", redraw);
  try {
    draw();
    await done;
  } finally {
    offClose();
    clearInterval(tick);
    clearTimeout(scheduled);
    clearTimeout(reload);
    process.stdin.off("data", onData);
    process.stdout.off("resize", redraw);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${MOUSE_OFF}${LEAVE_SCREEN}`);
  }
}
