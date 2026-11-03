// Human-readable output for the CLI.

import { degrees, degreeUnit, inUnits } from "@casita/client";

type Row = Record<string, unknown>;

/** Plain aligned columns; `--json` output never goes through here. */
export function table(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const cell = (value: unknown) => (value === undefined || value === null ? "" : String(value));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(columns.map((c) => c.toUpperCase())),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n");
}

const percent = (value: unknown) =>
  typeof value === "number" ? ` ${Math.round(value * 100)}%` : "";

/** Conversion leaves long tails (70.52000000000001); two decimals is as fine as readings get. */
const round = (value: number) => Math.round(value * 100) / 100;

/** One short phrase for a state record, e.g. "on 50%" or "21.5 °C". */
export function summarize(record: Row | undefined): string {
  if (!record) return "unknown";
  if (record.available === false) return "unavailable";
  const s = record.state as Row;
  switch (s.domain) {
    case "light":
      return s.on ? `on${percent(s.brightness)}` : "off";
    case "switch":
    case "binary_sensor":
      return s.on ? "on" : "off";
    case "sensor":
      if (typeof s.value === "number" && typeof s.unit === "string") {
        const shown = inUnits(s.value, s.unit);
        return `${round(shown.value)} ${shown.unit}`;
      }
      return `${s.value ?? "unknown"}${s.unit ? ` ${s.unit}` : ""}`;
    case "climate":
      return `${s.mode}${typeof s.currentTemp === "number" ? ` ${round(degrees(s.currentTemp))}` : ""}${
        typeof s.targetTemp === "number" ? ` → ${round(degrees(s.targetTemp))}` : ""
      }`;
    case "cover":
      return `${s.motion}${percent(s.position)}`;
    case "lock":
      return s.jammed ? "jammed" : s.locked ? "locked" : "unlocked";
    case "button":
      return typeof s.pressedAt === "number" ? `pressed ${time(s.pressedAt)}` : "never pressed";
    case "weather":
      return `${s.condition}${
        typeof s.temperature === "number" ? ` ${round(degrees(s.temperature))} ${degreeUnit()}` : ""
      }`;
    default:
      return JSON.stringify(s);
  }
}

export const time = (ms: unknown): string =>
  typeof ms === "number" ? new Date(ms).toISOString() : "";

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** `--key value` pairs after a command; values are parsed as JSON when possible. */
export function parseFlags(args: string[]): Row {
  const flags: Row = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) throw new Error(`Expected --key value, got "${arg}"`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[arg.slice(2)] = true;
    } else {
      flags[arg.slice(2)] = parseValue(next);
      i++;
    }
  }
  return flags;
}

export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A typed value as its setting takes it: text stays text, on and off are a switch's, and a
 * number or option name is left for the server to check. An unknown key goes as typed, for
 * the server to say so.
 */
export function settingArgument(
  setting: { type: string } | undefined,
  text: string,
): number | boolean | string {
  if (setting?.type === "string") return text;
  if (setting?.type === "boolean") {
    if (/^(on|true|yes|1)$/i.test(text)) return true;
    if (/^(off|false|no|0)$/i.test(text)) return false;
    return text;
  }
  const parsed = parseValue(text);
  return typeof parsed === "number" || typeof parsed === "boolean" ? parsed : text;
}

/** One remembered run of an automation, as a row of `automation runs` and `automation test`. */
export const RUN_COLUMNS = ["at", "line", "trigger", "calls", "armed", "error"];
export function runRow(r: Record<string, unknown>): Record<string, unknown> {
  const calls = (r.calls as Record<string, unknown>[] | undefined) ?? [];
  const actions = (r.actions as Record<string, unknown>[] | undefined) ?? [];
  return {
    at: r.at,
    line: r.line,
    trigger: r.trigger,
    calls: [
      ...calls.map(
        (c) =>
          `${c.entityId}.${(c.command as Record<string, unknown>).action}${c.error ? ` ✗ ${c.error}` : ""}`,
      ),
      ...actions.map((a) => `run ${a.integrationId}.${a.action}${a.error ? ` ✗ ${a.error}` : ""}`),
    ].join(", "),
    armed: ((r.armed as number[] | undefined) ?? []).map((ms) => `${ms / 1000}s`).join(", "),
    error: r.error,
  };
}

/**
 * `--pretend key=value` pairs as values: a number, true, false or null as such, `"…"` as the
 * quoted text, anything else as the text it is (`rain`, `On`).
 */
export function pretendValues(pairs: string[]): Record<string, number | string | boolean | null> {
  const out: Record<string, number | string | boolean | null> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--pretend takes key=value, not ${pair}`);
    const key = pair.slice(0, eq).trim();
    const text = pair.slice(eq + 1).trim();
    let value: number | string | boolean | null = text;
    if (text === "true" || text === "false") value = text === "true";
    else if (text === "null") value = null;
    else if (text !== "" && Number.isFinite(Number(text))) value = Number(text);
    else if (/^".*"$/.test(text)) value = text.slice(1, -1);
    out[key] = value;
  }
  return out;
}
