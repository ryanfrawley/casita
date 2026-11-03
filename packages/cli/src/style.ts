// Terminal styling for the one-shot commands and the dashboard: colors, symbols, bars, and
// width-aware padding. Colors are off when output is not a terminal or NO_COLOR is set.

export const SYMBOL = { pending: "◐", ok: "●", warn: "▲", open: "○", cursor: "▸" } as const;

let enabled = Boolean(process.stdout.isTTY) && !Bun.env.NO_COLOR;

export function setColor(on: boolean): void {
  enabled = on;
}

export type Theme = "dark" | "light" | "ansi";
type Style =
  | "amber"
  | "red"
  | "blue"
  | "green"
  | "dim"
  | "faint"
  | "bold"
  | "accent"
  | "chip"
  | "key"
  | "select";

/**
 * Colors for each kind of terminal background. "dark" and "light" use fixed 256-color
 * values chosen for that background. "ansi" uses only the terminal's own sixteen colors and
 * attributes, which every theme keeps readable; it is the fallback when the background is
 * not known.
 */
const PALETTES: Record<Theme, Record<Style, string>> = {
  dark: {
    amber: "38;5;215",
    red: "38;5;210",
    blue: "38;5;110",
    green: "38;5;114",
    dim: "38;5;245",
    faint: "38;5;240",
    bold: "1",
    accent: "1;38;5;209",
    chip: "48;5;209;38;5;16",
    key: "48;5;238;1",
    select: "48;5;236",
  },
  light: {
    amber: "38;5;166",
    red: "38;5;160",
    blue: "38;5;25",
    green: "38;5;28",
    dim: "38;5;242",
    faint: "38;5;250",
    bold: "1",
    accent: "1;38;5;166",
    chip: "48;5;166;38;5;231",
    key: "48;5;252;38;5;235;1",
    select: "48;5;254",
  },
  ansi: {
    amber: "33",
    red: "31",
    blue: "34",
    green: "32",
    dim: "2",
    faint: "2",
    bold: "1",
    accent: "1;33",
    chip: "7",
    key: "7",
    select: "1",
  },
};

let theme: Theme = "dark";

export function setTheme(next: Theme): void {
  theme = next;
}

/**
 * The theme the environment asks for or implies: CASITA_THEME, else COLORFGBG (set by some
 * terminals as "foreground;background" color numbers). Undefined when neither says.
 */
export function themeFromEnv(env: Record<string, string | undefined> = Bun.env): Theme | undefined {
  const asked = env.CASITA_THEME?.toLowerCase();
  if (asked === "dark" || asked === "light" || asked === "ansi") return asked;
  const field = env.COLORFGBG?.split(";").at(-1)?.trim() ?? "";
  // An empty or cut-off value says nothing; Number("") would read as 0, which is black.
  if (!/^\d+$/.test(field)) return undefined;
  const background = Number(field);
  // 7 and 15 are the white backgrounds; everything else in the basic sixteen is dark.
  return background === 7 || background === 15 ? "light" : "dark";
}

/**
 * Reads a terminal's answer to "what is your background color?" (OSC 11), which looks
 * like `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` (or `rgba:` with an alpha channel last). Undefined if the text holds no such answer.
 */
export function themeFromReply(reply: string): Theme | undefined {
  const match = /\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return undefined;
  const channel = (hex: string | undefined) =>
    Number.parseInt(hex ?? "0", 16) / (16 ** (hex?.length ?? 1) - 1);
  const luminance =
    0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
  return luminance > 0.5 ? "light" : "dark";
}

const wrap = (style: Style) => (text: string) =>
  enabled && text ? `\x1b[${PALETTES[theme][style]}m${text}\x1b[0m` : text;

export const c = {
  amber: wrap("amber"),
  red: wrap("red"),
  blue: wrap("blue"),
  green: wrap("green"),
  dim: wrap("dim"),
  faint: wrap("faint"),
  bold: wrap("bold"),
  accent: wrap("accent"),
  /** A highlighted chip: the selected mode, the chosen range. */
  chip: wrap("chip"),
  /** A key cap in the hint row. */
  key: wrap("key"),
  /** The selected row. */
  select: wrap("select"),
};

/** The escape that starts the selected-row style, for repainting it after resets inside a row. */
export const selectStart = (): string => (enabled ? `\x1b[${PALETTES[theme].select}m` : "");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_AT = /\x1b\[[0-9;]*m/y;
export const strip = (text: string): string => text.replace(ANSI, "");
/** Columns a string occupies, ignoring color codes. */
export const width = (text: string): number => {
  let columns = 0;
  for (const char of strip(text)) columns += charWidth(char);
  return columns;
};

const ZERO_WIDTH = /^(?:\p{M}|[\u200B-\u200D]|[\uFE00-\uFE0F])$/u;
const WIDE =
  /^(?:\p{Emoji_Presentation}|[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}])$/u;

/** Terminal columns one character takes: 2 for emoji and CJK, 0 for combining marks. */
export const charWidth = (char: string): number =>
  ZERO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1;

export const pad = (text: string, columns: number): string =>
  text + " ".repeat(Math.max(0, columns - width(text)));
export const padStart = (text: string, columns: number): string =>
  " ".repeat(Math.max(0, columns - width(text))) + text;

/** Cuts a possibly colored string to `columns`, ending with an ellipsis if anything was lost. */
export function truncate(text: string, columns: number): string {
  if (width(text) <= columns) return text;
  if (columns <= 0) return "";
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length; ) {
    ANSI_AT.lastIndex = i;
    const code = ANSI_AT.exec(text);
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i) ?? 32);
    // Stop while there is still a column left for the ellipsis.
    if (used + charWidth(char) > columns - 1) break;
    out += char;
    used += charWidth(char);
    i += char.length;
  }
  return `${out}…${enabled ? "\x1b[0m" : ""}`;
}

/** Pads or cuts to exactly `columns`. */
export const fit = (text: string, columns: number): string => pad(truncate(text, columns), columns);

/**
 * A level bar: filled cells for `fraction` of `cells`. `mark` (also a fraction) draws a
 * tick, for a charge limit or a target temperature.
 */
export function bar(
  fraction: number,
  cells = 10,
  tone: (text: string) => string = c.amber,
  mark?: number,
): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = clamped > 0 ? Math.max(1, Math.round(clamped * cells)) : 0;
  const tick =
    mark === undefined ? -1 : Math.min(cells - 1, Math.max(0, Math.round(mark * cells) - 1));
  let out = "";
  for (let i = 0; i < cells; i++) {
    if (i === tick && i >= filled) out += c.bold("│");
    else out += i < filled ? tone("█") : c.faint("░");
  }
  return out;
}
