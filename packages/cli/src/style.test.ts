import { afterEach, expect, test } from "bun:test";
import {
  bar,
  c,
  fit,
  pad,
  padStart,
  selectStart,
  setColor,
  setTheme,
  strip,
  themeFromEnv,
  themeFromReply,
  truncate,
  width,
} from "./style.ts";

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
/** Any SGR escape, whole. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** An escape introducer that is not followed by a complete SGR code: a code cut in half. */
const BROKEN = new RegExp(`${ESC}(?!\\[[0-9;]*m)`);
const plain = (text: string) => text;

afterEach(() => setColor(false));

// ───────── width, pad, padStart ─────────

test("width counts visible characters and ignores color codes", () => {
  setColor(true);
  expect(width(c.amber("On"))).toBe(2);
  expect(width(`${c.red("ab")}${c.bold(c.green("cd"))}`)).toBe(4);
  expect(width("")).toBe(0);
  expect(width(c.amber(""))).toBe(0);
});

test("width counts an astral character such as an emoji once, not per UTF-16 unit", () => {
  // "🚗".length is 2; the old surrogate-pair mistake would count 9 here.
  expect(width("🚗 Garage")).toBeLessThanOrEqual(9);
  expect(width("🚗 Garage")).toBeGreaterThanOrEqual(8);
});

test("width counts wide characters (emoji, CJK) as the two terminal columns they occupy", () => {
  // A terminal draws these two columns wide, so a row sized by width() runs past the edge
  // and wraps, pushing the rest of the dashboard down.
  expect(width("🚗 Garage")).toBe(9);
  expect(width("中文")).toBe(4);
  // A combining accent adds no column.
  expect(width("é")).toBe(1);
});

test("pad and padStart fill to the requested visible width, and never cut", () => {
  setColor(true);
  const colored = c.green("ok");
  expect(width(pad(colored, 6))).toBe(6);
  expect(strip(pad(colored, 6))).toBe("ok    ");
  expect(strip(padStart(colored, 6))).toBe("    ok");
  expect(pad("toolong", 3)).toBe("toolong");
  expect(padStart("toolong", 3)).toBe("toolong");
  expect(pad("x", -5)).toBe("x");
});

// ───────── truncate ─────────

test("truncate leaves text that already fits untouched", () => {
  setColor(true);
  const colored = c.amber("Locked");
  expect(truncate(colored, 6)).toBe(colored);
  expect(truncate(colored, 60)).toBe(colored);
  expect(truncate("", 0)).toBe("");
});

test("truncate to zero or fewer columns gives an empty string", () => {
  setColor(true);
  expect(truncate(c.amber("Locked"), 0)).toBe("");
  expect(truncate("Locked", -3)).toBe("");
});

test("truncate to one column is just the ellipsis", () => {
  setColor(false);
  expect(truncate("Locked", 1)).toBe("…");
  setColor(true);
  expect(strip(truncate(c.amber("Locked"), 1))).toBe("…");
  expect(width(truncate(c.amber("Locked"), 1))).toBe(1);
});

test("truncate without color ends with an ellipsis and no escape codes", () => {
  setColor(false);
  expect(truncate("Garage door", 6)).toBe("Garag…");
  expect(truncate("Garage door", 6)).not.toContain(ESC);
});

test("truncate of colored text is exactly the limit wide at every limit, and never splits a code", () => {
  setColor(true);
  const text = `${c.bold("Front")} ${c.green(`${c.bold("door")} locked`)}${c.dim(" · 4 min")}`;
  const full = width(text);
  for (let columns = 1; columns < full; columns++) {
    const out = truncate(text, columns);
    expect(width(out)).toBe(columns);
    expect(out).not.toMatch(BROKEN);
    expect(strip(out).endsWith("…")).toBe(true);
    // A reset follows, so the color does not bleed into whatever comes next.
    expect(out.endsWith(RESET)).toBe(true);
  }
});

test("truncate keeps the visible prefix of colored text in order", () => {
  setColor(true);
  const text = `${c.red("ab")}${c.green("cd")}${c.blue("ef")}`;
  expect(strip(truncate(text, 4))).toBe("abc…");
  // Codes before the cut survive whole, so "c" is still green.
  expect(truncate(text, 4)).toContain(`${ESC}[38;5;114mc`);
});

test("truncate never cuts an emoji in half", () => {
  setColor(false);
  const out = truncate("🚗 Garage", 4);
  expect(out).toBe("🚗 …"); // the car is two columns wide
  expect(out.isWellFormed()).toBe(true);
  expect(truncate("🚗🚙🚕🚌", 3)).toBe("🚗…");
  expect(truncate("🚗🚙🚕🚌", 2)).toBe("…"); // no room for a two-column car and the ellipsis
  expect(truncate("🚗🚙🚕🚌", 2).isWellFormed()).toBe(true);
});

test("truncate with color on still adds a reset after plain text it cuts", () => {
  setColor(true);
  expect(truncate("plain text", 4)).toBe(`pla…${RESET}`);
});

// ───────── fit ─────────

test("fit always returns exactly the requested visible width", () => {
  for (const on of [false, true]) {
    setColor(on);
    const inputs = ["", "a", "Garage door", c.amber("On · 40%"), `${c.red("x")}${c.green("yz")}`];
    for (const input of inputs) {
      for (let columns = 0; columns <= 14; columns++) {
        expect(width(fit(input, columns))).toBe(columns);
      }
    }
  }
});

test("fit of an emoji-led name keeps whole characters", () => {
  setColor(false);
  expect(fit("🚗 Garage door opener", 6)).toBe("🚗 Ga…");
  expect(fit("🚗", 4)).toBe("🚗  ");
});

test("fit to a negative width is empty", () => {
  setColor(false);
  expect(fit("abc", -1)).toBe("");
});

// ───────── bar ─────────

test("an empty bar for zero, negative, NaN, and negative infinity", () => {
  setColor(false);
  for (const fraction of [0, -0.2, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    expect(bar(fraction, 10, plain)).toBe("░░░░░░░░░░");
  }
});

test("a full bar for one and anything above it", () => {
  setColor(false);
  for (const fraction of [1, 1.0001, 2, Number.POSITIVE_INFINITY]) {
    expect(bar(fraction, 10, plain)).toBe("██████████");
  }
});

test("any level above zero shows at least one cell, however small", () => {
  setColor(false);
  expect(bar(0.0001, 10, plain)).toBe("█░░░░░░░░░");
  expect(bar(Number.MIN_VALUE, 10, plain)).toBe("█░░░░░░░░░");
});

test("a bar rounds to the nearest cell", () => {
  setColor(false);
  expect(bar(0.94, 10, plain)).toBe("█████████░");
  expect(bar(0.96, 10, plain)).toBe("██████████");
  expect(bar(0.25, 4, plain)).toBe("█░░░");
});

test("a bar is always `cells` wide", () => {
  setColor(true);
  for (const cells of [0, 1, 3, 10, 34]) {
    for (const fraction of [0, 0.3, 1]) {
      for (const tick of [undefined, 0, 0.5, 1, 3]) {
        expect(width(bar(fraction, cells, c.amber, tick))).toBe(cells);
      }
    }
  }
});

test("a one-cell bar is filled for any level and empty at zero", () => {
  setColor(false);
  expect(bar(0.4, 1, plain)).toBe("█");
  expect(bar(0, 1, plain)).toBe("░");
  expect(bar(0, 1, plain, 0.5)).toBe("│");
});

test("the mark is drawn in the cell where its fraction ends, only past the filled part", () => {
  setColor(false);
  expect(bar(0.3, 10, plain, 0.8)).toBe("███░░░░│░░");
  expect(bar(0.3, 10, plain, 1)).toBe("███░░░░░░│");
  expect(bar(0.3, 10, plain, 1.5)).toBe("███░░░░░░│"); // clamped to the last cell
  expect(bar(0.3, 10, plain, 0.4)).toBe("███│░░░░░░"); // right after the fill
  expect(bar(0.3, 10, plain, 0.3)).toBe("███░░░░░░░"); // inside the fill: not drawn
});

test("a mark at or below zero sits in the first cell, which shows only on an empty bar", () => {
  setColor(false);
  expect(bar(0, 10, plain, 0)).toBe("│░░░░░░░░░");
  expect(bar(0, 10, plain, -1)).toBe("│░░░░░░░░░");
  expect(bar(0.3, 10, plain, 0)).toBe("███░░░░░░░");
});

test("a NaN mark is not drawn", () => {
  setColor(false);
  expect(bar(0.3, 10, plain, Number.NaN)).toBe("███░░░░░░░");
});

test("the bar uses its tone for filled cells only", () => {
  setColor(false);
  expect(bar(0.5, 4, (t) => t.replace("█", "#"))).toBe("##░░");
});

test("with color on, the bar's escape codes are whole and it strips to the plain bar", () => {
  setColor(true);
  const out = bar(0.5, 10, c.amber, 0.8);
  expect(out.replace(SGR, "")).toBe("█████░░│░░");
  expect(out).not.toMatch(BROKEN);
});

// ───────── setColor ─────────

test("setColor turns color on and off for every helper", () => {
  setColor(true);
  expect(c.amber("x")).toBe(`${ESC}[38;5;215mx${RESET}`);
  expect(c.amber("")).toBe(""); // empty text is never wrapped
  setColor(false);
  expect(c.amber("x")).toBe("x");
  expect(c.select("x")).toBe("x");
});

// ───────── themes ─────────

test("each theme has its own colors; ansi uses only the terminal's own", () => {
  setColor(true);
  try {
    setTheme("dark");
    expect(c.amber("x")).toBe(`${ESC}[38;5;215mx${RESET}`);
    expect(c.key("x")).toBe(`${ESC}[48;5;238;1mx${RESET}`);
    setTheme("light");
    expect(c.amber("x")).toBe(`${ESC}[38;5;166mx${RESET}`);
    // A light key cap sets both its background and a dark text color, so it reads on white.
    expect(c.key("x")).toBe(`${ESC}[48;5;252;38;5;235;1mx${RESET}`);
    expect(selectStart()).toBe(`${ESC}[48;5;254m`);
    setTheme("ansi");
    expect(c.amber("x")).toBe(`${ESC}[33mx${RESET}`);
    expect(c.key("x")).toBe(`${ESC}[7mx${RESET}`);
    expect(selectStart()).toBe(`${ESC}[1m`);
  } finally {
    setTheme("dark");
    setColor(false);
  }
  expect(selectStart()).toBe("");
});

test("the theme can be named, or implied by the terminal's COLORFGBG", () => {
  expect(themeFromEnv({ CASITA_THEME: "light" })).toBe("light");
  expect(themeFromEnv({ CASITA_THEME: "ANSI", COLORFGBG: "0;15" })).toBe("ansi");
  expect(themeFromEnv({ CASITA_THEME: "purple", COLORFGBG: "0;15" })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
  expect(themeFromEnv({ COLORFGBG: "0;default;7" })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "12;8" })).toBe("dark");
  expect(themeFromEnv({ COLORFGBG: "nonsense" })).toBeUndefined();
  expect(themeFromEnv({})).toBeUndefined();
});

test("the terminal's answer about its background decides light or dark", () => {
  expect(themeFromReply(`${ESC}]11;rgb:f3f3/f3f3/f3f3${ESC}\\`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:1e1e/1e1e/2e2e\u0007`)).toBe("dark");
  expect(themeFromReply(`${ESC}]11;rgb:ff/ff/ff\u0007`)).toBe("light"); // two digits per channel
  expect(themeFromReply(`${ESC}]11;rgb:0000/0000/0000\u0007`)).toBe("dark");
  // A saturated blue is dark to the eye even though one channel is full.
  expect(themeFromReply(`${ESC}]11;rgb:0000/0000/ffff\u0007`)).toBe("dark");
  expect(themeFromReply("q")).toBeUndefined();
  expect(themeFromReply("")).toBeUndefined();
});

test("a background reply is read whatever the number of hex digits per channel", () => {
  expect(themeFromReply(`${ESC}]11;rgb:f/f/f\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:1/1/2\u0007`)).toBe("dark");
  expect(themeFromReply(`${ESC}]11;rgb:eee/eee/eee\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:000/000/000\u0007`)).toBe("dark");
  // Channels of different lengths are each scaled to their own maximum.
  expect(themeFromReply(`${ESC}]11;rgb:f/ffff/ff\u0007`)).toBe("light");
});

test("a background reply in uppercase hex is read the same as lowercase", () => {
  expect(themeFromReply(`${ESC}]11;rgb:F3F3/F3F3/F3F3${ESC}\\`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:1E1E/1E1E/2E2E${ESC}\\`)).toBe("dark");
});

test("a background just above mid-grey is light and just below is dark", () => {
  expect(themeFromReply(`${ESC}]11;rgb:8080/8080/8080\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:7f7f/7f7f/7f7f\u0007`)).toBe("dark");
  expect(themeFromReply(`${ESC}]11;rgb:80/80/80\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:7f/7f/7f\u0007`)).toBe("dark");
});

test("a keypress typed before or after the background reply does not hide it", () => {
  expect(themeFromReply(`jj${ESC}]11;rgb:ffff/ffff/ffff\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgb:0000/0000/0000\u0007q`)).toBe("dark");
  expect(themeFromReply(`${ESC}[A${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\${ESC}[B`)).toBe("light");
});

test("when two background replies arrive together, the first decides", () => {
  const light = `${ESC}]11;rgb:ffff/ffff/ffff\u0007`;
  const dark = `${ESC}]11;rgb:0000/0000/0000\u0007`;
  expect(themeFromReply(`${light}${dark}`)).toBe("light");
  expect(themeFromReply(`${dark}${light}`)).toBe("dark");
});

test("a reply about another color, or with malformed channels, is not a background", () => {
  // OSC 10 is the foreground color.
  expect(themeFromReply(`${ESC}]10;rgb:ffff/ffff/ffff\u0007`)).toBeUndefined();
  expect(themeFromReply(`${ESC}]11;rgb:ffff/ffff\u0007`)).toBeUndefined();
  expect(themeFromReply(`${ESC}]11;rgb:zzzz/ffff/ffff\u0007`)).toBeUndefined();
  expect(themeFromReply(`${ESC}]11;rgb:/ffff/ffff\u0007`)).toBeUndefined();
  expect(themeFromReply(`${ESC}]11;?\u0007`)).toBeUndefined();
});

// urxvt and some others answer with an alpha channel: `rgba:RRRR/GGGG/BBBB/AAAA`.
test("a background reply with an alpha channel (rgba:) is read", () => {
  expect(themeFromReply(`${ESC}]11;rgba:ffff/ffff/ffff/ffff\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgba:0000/0000/0000/c000\u0007`)).toBe("dark");
});

test("COLORFGBG as terminals write it decides light or dark by its last field", () => {
  expect(themeFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
  expect(themeFromEnv({ COLORFGBG: "0;15" })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "0;default;15" })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "7;0" })).toBe("dark");
  expect(themeFromEnv({ COLORFGBG: "0;7" })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "default;default" })).toBeUndefined();
});

test("COLORFGBG backgrounds 8 to 14 count as dark", () => {
  for (const background of [8, 9, 10, 11, 12, 13, 14]) {
    expect(themeFromEnv({ COLORFGBG: `15;${background}` })).toBe("dark");
  }
});

test("an empty CASITA_THEME falls through to COLORFGBG", () => {
  expect(themeFromEnv({ CASITA_THEME: "", COLORFGBG: "0;15" })).toBe("light");
});

// Number("") is 0, so an empty or cut-off COLORFGBG reads as background 0 (black).
test("an empty or cut-off COLORFGBG says nothing about the background", () => {
  expect(themeFromEnv({ COLORFGBG: "" })).toBeUndefined();
  expect(themeFromEnv({ COLORFGBG: "15;" })).toBeUndefined();
  expect(themeFromEnv({ COLORFGBG: " " })).toBeUndefined();
});

test("selectStart follows the theme, and is empty with color off", () => {
  setColor(true);
  try {
    setTheme("dark");
    expect(selectStart()).toBe(`${ESC}[48;5;236m`);
    setTheme("light");
    expect(selectStart()).toBe(`${ESC}[48;5;254m`);
    setColor(false);
    expect(selectStart()).toBe("");
  } finally {
    setTheme("dark");
    setColor(false);
  }
});

test("an rgba reply is judged by its color alone, whatever the alpha", () => {
  expect(themeFromReply(`${ESC}]11;rgba:ffff/ffff/ffff/0000\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgba:1e1e/1e1e/2e2e/ffff${ESC}\\`)).toBe("dark");
  expect(themeFromReply(`${ESC}]11;RGBA:F3F3/F3F3/F3F3/FFFF\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgba:ff/ff/ff/80\u0007`)).toBe("light");
  expect(themeFromReply(`${ESC}]11;rgba:ffff/ffff`)).toBeUndefined(); // cut off
});

test("COLORFGBG's last field must be a whole number, give or take spaces", () => {
  expect(themeFromEnv({ COLORFGBG: "0; 15 " })).toBe("light");
  expect(themeFromEnv({ COLORFGBG: "0;015" })).toBe("light");
  for (const odd of ["0;15x", "0;-1", ";", "0;1.5", "0;0x7"]) {
    expect(themeFromEnv({ COLORFGBG: odd })).toBeUndefined();
  }
  expect(themeFromEnv({ CASITA_THEME: "purple", COLORFGBG: "" })).toBeUndefined();
});
