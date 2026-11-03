// casa/theme.ts
// Themes: the vocabulary of groups and keys, the built-ins (Day and Night generated from the
// design tokens, October written in Casa over Night), how a `theme` declaration resolves over
// the one it extends, the coverage rule, and the CSS a theme becomes.

import type { ThemeDecl, ThemeValue } from "./ast.ts";
import { Diagnostics, didYouMean, NOWHERE, type Span } from "./diagnostics.ts";
import { parse } from "./parser.ts";
import { COLORS, FAMILIES, SHADOWS } from "./tokens.gen.ts";
import { COLOR, NUMBER, type Type, token } from "./types.ts";

// ───────── vocabulary ─────────

export const BORDERS = ["none", "hairline", "thin", "thick"] as const;
export const SHADOW_SIZES = ["none", "sm", "md", "lg"] as const;
export const RADII = ["none", "sm", "md", "lg", "full"] as const;
/** The box behind a heading's icon: the house's arch, a circle, a square, or no box at all. */
export const SHAPES = ["arch", "circle", "square", "none"] as const;
/** A heading's face, naming one of the theme's `font` families. */
export const FACES = ["body", "display", "mono"] as const;

type ValueKind =
  | "color"
  | "number"
  | "string"
  | "border"
  | "shadow"
  | "radius"
  | "shape"
  | "face"
  /** A font weight, 100–900. */
  | "weight";

interface Group {
  /** Keys with their value kind; an open group also accepts new keys, all of `open`'s kind. */
  keys: Record<string, ValueKind>;
  open?: ValueKind;
}

const SURFACE: Group = {
  keys: { background: "color", border: "border", shadow: "shadow", radius: "radius" },
};
/** The box behind a heading's icon: its shape, the icon's size and the room around it, in px. */
const ICON: Group = {
  keys: {
    shape: "shape",
    size: "number",
    border: "border",
    background: "color",
    padding: "number",
  },
};
/** A heading's line of text. */
const HEADING: Group = {
  keys: { size: "number", weight: "weight", font: "face", color: "color" },
};

export const VOCABULARY: Record<string, Group> = {
  palette: { keys: {}, open: "color" },
  "surface.page": SURFACE,
  "surface.card": SURFACE,
  "surface.raised": SURFACE,
  "surface.control": SURFACE,
  text: {
    keys: { primary: "color", muted: "color", accent: "color", onAccent: "color", danger: "color" },
  },
  space: { keys: { xs: "number", sm: "number", md: "number", lg: "number", xl: "number" } },
  font: { keys: { body: "string", display: "string", mono: "string" } },
  "font.size": { keys: { sm: "number", md: "number", lg: "number", xl: "number" } },
  chart: {
    keys: {
      grid: "color",
      axis: "color",
      series1: "color",
      series2: "color",
      series3: "color",
      good: "color",
      warn: "color",
      bad: "color",
    },
  },
  breakpoints: { keys: { tablet: "number", desktop: "number" } },
  accents: { keys: {}, open: "color" },
  /** The line between the blocks of a card: its colour, thickness, how far in from the card's
   * edges it starts and ends, and the room above and below it, in px. */
  divider: { keys: { color: "color", height: "number", inset: "number", space: "number" } },
  /** A room's heading: the icon's box, the name, the line under it. */
  "room.icon": ICON,
  "room.name": HEADING,
  "room.subtitle": HEADING,
  /** A card's heading, on device and entity cards and every `Card`. */
  "card.icon": ICON,
  "card.title": HEADING,
  "card.subtitle": HEADING,
  /** A section's title line. */
  "section.title": HEADING,
};

/** The group names a page may start a theme path with. */
export const GROUP_NAMES = [
  "palette",
  "surface",
  "text",
  "space",
  "font",
  "chart",
  "breakpoints",
  "accents",
  "divider",
  "room",
  "card",
  "section",
];

/** Splits `surface.card.background` into its group and key. */
export function splitPath(path: string[]): { group: string; key: string } | undefined {
  for (let n = path.length - 1; n >= 1; n--) {
    const group = path.slice(0, n).join(".");
    if (VOCABULARY[group]) return { group, key: path.slice(n).join(".") };
  }
  return undefined;
}

const kindOf = (group: Group, key: string): ValueKind | undefined => group.keys[key] ?? group.open;

/** The type a page sees a theme path as, or undefined when the vocabulary has no such key. */
export function themePathType(path: string[]): Type | undefined {
  const split = splitPath(path);
  if (!split || split.key.includes(".")) return undefined;
  const group = VOCABULARY[split.group] as Group;
  const kind = kindOf(group, split.key);
  if (!kind) return undefined;
  if (kind === "color") return COLOR;
  if (kind === "number" || kind === "weight")
    return split.group === "space" ? token("space") : NUMBER;
  if (kind === "string" || kind === "face") return token("font");
  return token(kind);
}

/** Whether a path names a group a page may go on into (`surface` → `surface.card`). */
export const isGroupPrefix = (path: string[]): boolean => {
  const joined = path.join(".");
  return Object.keys(VOCABULARY).some(
    (group) => group === joined || group.startsWith(`${joined}.`),
  );
};

// ───────── resolved themes ─────────

export type Resolved =
  | { kind: "color"; hex: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "word"; word: string }
  /** A palette reference, kept as one so CSS can say `var(--palette-ink)`. */
  | { kind: "ref"; path: string };

export interface Theme {
  id: string;
  name: string;
  extends?: string;
  /** Every path the theme defines or inherits, `surface.card.background` → its value. */
  values: Record<string, Resolved>;
  css: string;
  /** The Casa it was compiled from; Day and Night are generated and have none. */
  source?: string;
}

export const themeId = (name: string): string => name.toLowerCase();

/** The value at a path, following palette references. */
export function lookup(theme: Theme, path: string): Resolved | undefined {
  let value = theme.values[path];
  for (let hops = 0; value?.kind === "ref" && hops < 8; hops++) value = theme.values[value.path];
  return value;
}

/** The paths a theme defines, for autocomplete. */
export const themePaths = (theme: Theme): string[] => Object.keys(theme.values).sort();

// ───────── Day and Night ─────────

function base(theme: "light" | "dark"): Record<string, Resolved> {
  const values: Record<string, Resolved> = {};
  for (const colour of COLORS)
    values[`palette.${colour.name}`] = { kind: "color", hex: colour[theme] };
  const ref = (name: string): Resolved => ({ kind: "ref", path: `palette.${name}` });
  const word = (word: string): Resolved => ({ kind: "word", word });
  const number = (value: number): Resolved => ({ kind: "number", value });
  const string = (value: string): Resolved => ({ kind: "string", value });
  Object.assign(values, {
    "surface.page.background": ref("plaster"),
    "surface.page.border": word("none"),
    "surface.page.shadow": word("none"),
    "surface.page.radius": word("none"),
    // A card is a well, as a room is: the sunken surface, no edge and no shadow, so a card in
    // a room is one with the room and a card on the page is a well of its own.
    "surface.card.background": ref("surfaceSunken"),
    "surface.card.border": word("none"),
    "surface.card.shadow": word("none"),
    "surface.card.radius": word("md"),
    "surface.raised.background": ref("surfaceRaised"),
    "surface.raised.border": word("none"),
    "surface.raised.shadow": word("lg"),
    "surface.raised.radius": word("md"),
    "surface.control.background": ref("surfaceSunken"),
    "surface.control.border": word("hairline"),
    "surface.control.shadow": word("none"),
    "surface.control.radius": word("sm"),
    "text.primary": ref("ink"),
    "text.muted": ref("inkMuted"),
    "text.accent": ref("terracottaInk"),
    "text.onAccent": ref("onTerracotta"),
    "text.danger": ref("danger"),
    "space.xs": number(4),
    "space.sm": number(8),
    "space.md": number(12),
    "space.lg": number(16),
    "space.xl": number(24),
    "font.body": string(FAMILIES.sans),
    "font.display": string(FAMILIES.display),
    "font.mono": string(FAMILIES.mono),
    "font.size.sm": number(13),
    "font.size.md": number(15),
    "font.size.lg": number(22),
    "font.size.xl": number(32),
    "chart.grid": ref("line"),
    "chart.axis": ref("inkMuted"),
    "chart.series1": ref("series1"),
    "chart.series2": ref("series2"),
    "chart.series3": ref("series3"),
    "chart.good": ref("sage"),
    "chart.warn": ref("lamp"),
    "chart.bad": ref("danger"),
    "breakpoints.tablet": number(860),
    "breakpoints.desktop": number(1100),
    "accents.lamp": ref("lamp"),
    "accents.sky": ref("sky"),
    "accents.sage": ref("sage"),
    "accents.ember": ref("ember"),
    // The ink that reads on each accent, as the components pair them: dark on lamp and
    // ember, light on sky, the page's plaster on sage.
    "accents.onLamp": ref("inkOnLamp"),
    "accents.onSky": ref("onSky"),
    "accents.onSage": ref("plaster"),
    "accents.onEmber": ref("inkOnLamp"),
    "divider.color": ref("line"),
    "divider.height": number(1),
    "divider.inset": number(0),
    // The blocks of a card are grid units with a 16px gutter between them; the line runs
    // through the middle of the gutter, 8px from each block.
    "divider.space": number(8),
    // The headings: a room's is its name alone, at 28px; a card's a 22px icon in a 40px circle,
    // raised on the card, and its title, in a 56px head. The arch is kept for a house that asks
    // for an icon: the house's doorway, a room's alone, 44px and 4px taller.
    "room.icon.shape": word("arch"),
    "room.icon.size": number(22),
    "room.icon.border": word("none"),
    "room.icon.background": ref("surfaceRaised"),
    "room.icon.padding": number(11),
    "room.name.size": number(28),
    "room.name.weight": number(600),
    "room.name.font": word("body"),
    "room.name.color": ref("ink"),
    "room.subtitle.size": number(12),
    "room.subtitle.weight": number(400),
    "room.subtitle.font": word("body"),
    "room.subtitle.color": ref("inkMuted"),
    "card.icon.shape": word("circle"),
    "card.icon.size": number(22),
    "card.icon.border": word("none"),
    "card.icon.background": ref("surfaceRaised"),
    "card.icon.padding": number(9),
    "card.title.size": number(16),
    "card.title.weight": number(500),
    "card.title.font": word("body"),
    "card.title.color": ref("ink"),
    "card.subtitle.size": number(13),
    "card.subtitle.weight": number(400),
    "card.subtitle.font": word("body"),
    "card.subtitle.color": ref("inkMuted"),
    "section.title.size": number(16),
    "section.title.weight": number(600),
    "section.title.font": word("body"),
    "section.title.color": ref("ink"),
  } satisfies Record<string, Resolved>);
  return values;
}

const finish = (
  id: string,
  name: string,
  values: Record<string, Resolved>,
  extends_?: string,
): Theme => {
  const theme: Theme = { id, name, extends: extends_, values, css: "" };
  theme.css = themeCss(theme);
  return theme;
};

// ───────── October ─────────

/**
 * The seasonal built-in, written in Casa so an admin can open it and read how a theme is
 * made. Night's warm browns go plum, terracotta goes pumpkin, the lamp becomes candlelight,
 * and the greens turn a little witchy; then the surfaces, spacing, type and dividers each
 * take a turn, so the source shows every group a theme can reach.
 */
export const OCTOBER_SOURCE = `// October: a moonlit night in the house.
theme October extends Night {
  palette {
    // The walls: plum-black instead of Night's warm brown.
    plaster: #17121f
    surfaceRaised: #221a2d
    surfaceSunken: #0f0b15
    line: #3a2f4c
    lineStrong: #6f6189

    // Bone-white text, lavender when muted.
    ink: #f4ecdf
    inkMuted: #b3a6c2
    unavailable: #5d5370

    // Pumpkin where Night has terracotta.
    terracotta: #f08a2e
    onTerracotta: #17121f
    terracottaInk: #f8a659
    ember: #ff7a3d

    // Candlelight.
    lamp: #f6c243
    inkOnLamp: #17121f
    lampSoft: #4b3520

    // Moonlight, potion green, and a redder red.
    sky: #a3b4f2
    onSky: #0f0b15
    sage: #8fd69b
    danger: #ff8597
    onDanger: #0f0b15

    series1: #f08a2e
    series2: #a98be6
    series3: #4ec49a
  }

  // Cards are raised, cut sharp, edged in lavender, and float on a deep shadow.
  surface.card {
    background: surfaceRaised
    border: thin
    shadow: lg
    radius: sm
  }
  surface.raised {
    radius: sm
  }

  // Fields, buttons and switches are pills.
  surface.control {
    radius: full
  }

  // A little more air between things, and a bigger greeting.
  space {
    md: 14
    lg: 20
    xl: 28
  }
  font.size {
    lg: 24
    xl: 36
  }

  // The lines between rows stop short of the card's edge.
  divider {
    inset: 12
  }

  // Headings. A room's icon sits in a ringed medallion instead of the arch and its name is
  // set in the display face; the line under it is small type from the mono face, like a
  // label on a specimen jar. Cards follow at a smaller size; a section's title is pumpkin.
  room.icon {
    shape: circle
    size: 24
    padding: 12
    border: thin
    background: surfaceSunken
  }
  room.name {
    font: display
    size: 26
    weight: 500
  }
  room.subtitle {
    font: mono
    size: 11
    color: sky
  }
  card.icon {
    shape: circle
    size: 20
    padding: 9
    border: hairline
    background: surfaceSunken
  }
  card.title {
    font: display
    size: 18
    weight: 500
  }
  card.subtitle {
    font: mono
    size: 11
  }
  section.title {
    font: display
    size: 20
    weight: 500
    color: terracottaInk
  }
}
`;

function october(night: Theme): Theme {
  const diagnostics = new Diagnostics();
  const decl = parse(OCTOBER_SOURCE, diagnostics).themes[0];
  const theme = decl && !diagnostics.failed ? compileTheme(decl, [night], diagnostics) : undefined;
  if (!theme) {
    throw new Error(
      `the October theme does not compile: ${diagnostics.list.map((d) => d.message).join("; ")}`,
    );
  }
  return { ...theme, source: OCTOBER_SOURCE };
}

/** `Day` and `Night`, from the design tokens, and `October`, from Casa over Night. */
export function builtinThemes(): Theme[] {
  const day = finish("day", "Day", base("light"));
  const night = finish("night", "Night", base("dark"));
  return [day, night, october(night)];
}

export const BUILTIN_THEME_NAMES = ["Day", "Night", "October"];
export const BUILTIN_THEME_IDS = BUILTIN_THEME_NAMES.map(themeId);

/** Whether a theme ships with Casita rather than being the house's own. */
export const isBuiltinTheme = (theme: Theme): boolean => BUILTIN_THEME_IDS.includes(theme.id);

// ───────── compiling a declaration ─────────

const WORDS: Record<string, readonly string[]> = {
  border: BORDERS,
  shadow: SHADOW_SIZES,
  radius: RADII,
  shape: SHAPES,
  face: FACES,
};

/**
 * Resolves a `theme` declaration over the theme it extends. Every entry is checked against
 * the vocabulary; a reference must name a palette colour the theme (or its parent) has.
 */
export function compileTheme(
  decl: ThemeDecl,
  themes: Theme[],
  diagnostics: Diagnostics,
): Theme | undefined {
  const parent = decl.extends ? themes.find((t) => t.name === decl.extends) : undefined;
  if (decl.extends && !parent) {
    diagnostics.error(
      "E021",
      decl.span,
      `theme \`${decl.name}\` extends \`${decl.extends}\`, which is not a theme${didYouMean(
        decl.extends,
        themes.map((t) => t.name),
      )}`,
    );
    return undefined;
  }
  if (!decl.extends) {
    diagnostics.error(
      "E021",
      decl.span,
      `theme \`${decl.name}\` must extend \`Day\` or \`Night\` (or a theme that does), so every page value has a default`,
    );
    return undefined;
  }
  const values: Record<string, Resolved> = { ...(parent as Theme).values };
  const before = diagnostics.list.length;
  for (const group of decl.groups) {
    const groupPath = group.path.join(".");
    const vocabulary = VOCABULARY[groupPath];
    if (!vocabulary) {
      diagnostics.error(
        "E022",
        group.span,
        `\`${groupPath}\` is not a theme group${didYouMean(groupPath, Object.keys(VOCABULARY))}`,
      );
      continue;
    }
    for (const entry of group.entries) {
      const kind = kindOf(vocabulary, entry.key);
      if (!kind) {
        diagnostics.error(
          "E022",
          entry.span,
          `theme group \`${groupPath}\` has no key \`${entry.key}\`${didYouMean(entry.key, Object.keys(vocabulary.keys))}`,
        );
        continue;
      }
      const resolved = resolveEntry(
        entry.value,
        kind,
        `${groupPath}.${entry.key}`,
        values,
        diagnostics,
        entry.span,
      );
      if (resolved) values[`${groupPath}.${entry.key}`] = resolved;
    }
  }
  if (diagnostics.list.length > before && diagnostics.failed) return undefined;
  return finish(themeId(decl.name), decl.name, values, decl.extends);
}

function resolveEntry(
  value: ThemeValue,
  kind: ValueKind,
  path: string,
  values: Record<string, Resolved>,
  diagnostics: Diagnostics,
  span: Span,
): Resolved | undefined {
  const wrong = (got: string) => {
    diagnostics.error(
      "E030",
      span,
      `theme value \`${path}\` expects ${KIND_WORDS[kind]}, got ${got}`,
    );
    return undefined;
  };
  switch (value.kind) {
    case "color":
      return kind === "color" ? { kind: "color", hex: value.hex } : wrong("a colour");
    case "number":
      if (kind === "weight") {
        if (value.value < 100 || value.value > 900 || value.value % 100 !== 0) {
          diagnostics.error(
            "E030",
            span,
            `theme value \`${path}\` is a weight from 100 to 900 in hundreds, not ${value.value}`,
          );
          return undefined;
        }
        return { kind: "number", value: value.value };
      }
      return kind === "number" ? { kind: "number", value: value.value } : wrong("a number");
    case "string":
      return kind === "string" ? { kind: "string", value: value.value } : wrong("a string");
    case "ref": {
      const words = WORDS[kind];
      if (words && value.path.length === 1) {
        const word = value.path[0] as string;
        if (!words.includes(word)) {
          diagnostics.error(
            "E030",
            span,
            `theme value \`${path}\` is one of ${words.join(" ")}, not \`${word}\``,
          );
          return undefined;
        }
        return { kind: "word", word };
      }
      if (kind !== "color") return wrong(`\`${value.path.join(".")}\``);
      const target = value.path.length === 1 ? `palette.${value.path[0]}` : value.path.join(".");
      if (!target.startsWith("palette.") || !values[target]) {
        const names = Object.keys(values)
          .filter((p) => p.startsWith("palette."))
          .map((p) => p.slice(8));
        diagnostics.error(
          "E021",
          span,
          `\`${value.path.join(".")}\` is not a palette colour this theme has${didYouMean(value.path[value.path.length - 1] as string, names)}`,
        );
        return undefined;
      }
      return { kind: "ref", path: target };
    }
  }
}

const KIND_WORDS: Record<ValueKind, string> = {
  color: "a colour or a palette name",
  number: "a number",
  string: "a string",
  border: `one of ${BORDERS.join(" ")}`,
  shadow: `one of ${SHADOW_SIZES.join(" ")}`,
  radius: `one of ${RADII.join(" ")}`,
  shape: `one of ${SHAPES.join(" ")}`,
  face: `one of ${FACES.join(" ")}`,
  weight: "a weight from 100 to 900",
};

// ───────── coverage ─────────

export interface Gap {
  theme: string;
  path: string;
}

/** Every (theme, path) pair where a theme lacks a value some page references. */
export function coverage(themes: Theme[], paths: Iterable<string>): Gap[] {
  const gaps: Gap[] = [];
  for (const path of new Set(paths)) {
    for (const theme of themes) {
      if (theme.values[path] === undefined) gaps.push({ theme: theme.name, path });
    }
  }
  return gaps;
}

/** Diagnostics for a page's references that some theme cannot resolve. */
export function reportGaps(gaps: Gap[], spans: Map<string, Span>, diagnostics: Diagnostics): void {
  for (const gap of gaps) {
    diagnostics.error(
      "E021",
      spans.get(gap.path) ?? NOWHERE,
      `\`${gap.path}\` is not defined by theme \`${gap.theme}\`; add it to \`${gap.theme}\` or to a theme it extends`,
    );
  }
}

// ───────── CSS ─────────

const BORDER_CSS: Record<string, string> = {
  none: "none",
  hairline: "1px solid var(--palette-line)",
  thin: "1px solid var(--palette-lineStrong)",
  thick: "2px solid var(--palette-lineStrong)",
};
const RADIUS_CSS: Record<string, string> = {
  none: "0",
  sm: "6px",
  md: "14px",
  lg: "22px",
  full: "999px",
};

const shadowCss = (word: string, dark: boolean): string => {
  const tile = SHADOWS.find((s) => s.name === "shadow-tile");
  const lift = SHADOWS.find((s) => s.name === "shadow-lift");
  const pick = (s: (typeof SHADOWS)[number] | undefined) =>
    s ? (dark ? s.dark : s.light) : "none";
  switch (word) {
    case "sm":
      return pick(tile);
    case "md":
      return `${pick(tile)}, ${pick(lift)}`;
    case "lg":
      return pick(lift);
    default:
      return "none";
  }
};

/** The corners of a heading's icon box; `none` draws no box, so its corners don't matter. */
const SHAPE_CSS: Record<string, string> = {
  arch: "999px 999px 6px 6px",
  circle: "999px",
  square: "6px",
  none: "0",
};

export const cssVar = (path: string): string => `--${path.replace(/\./g, "-")}`;

/** Whether a theme reads as dark: its page background is darker than its text. */
export function isDark(theme: Theme): boolean {
  const background = lookup(theme, "surface.page.background");
  const text = lookup(theme, "text.primary");
  if (background?.kind !== "color" || text?.kind !== "color") return false;
  return luminance(background.hex) < luminance(text.hex);
}

function luminance(hex: string): number {
  const digits =
    hex.length <= 4
      ? hex
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(1, 7);
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map(
    (i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * One rule for `:root[data-theme="<id>"]`: every value as a custom property named by its path,
 * plus the design system's own `--lamp`-style names as aliases so `packages/ui` needs no change.
 */
export function themeCss(theme: Theme): string {
  const dark = isDark(theme);
  const lines: string[] = [`color-scheme: ${dark ? "dark" : "light"};`];
  for (const [path, value] of Object.entries(theme.values).sort(([a], [b]) => a.localeCompare(b))) {
    const name = cssVar(path);
    switch (value.kind) {
      case "color":
        lines.push(`${name}: ${value.hex};`);
        break;
      case "number": {
        // Breakpoints are compared with a width in JS, and a weight is unitless; the rest are px.
        const bare = path.startsWith("breakpoints.") || path.endsWith(".weight");
        lines.push(`${name}: ${bare ? value.value : `${value.value}px`};`);
        break;
      }
      case "string":
        lines.push(`${name}: ${value.value};`);
        break;
      case "ref":
        lines.push(`${name}: var(${cssVar(value.path)});`);
        break;
      case "word":
        if (path.endsWith(".border")) lines.push(`${name}: ${BORDER_CSS[value.word] ?? "none"};`);
        else if (path.endsWith(".shadow")) lines.push(`${name}: ${shadowCss(value.word, dark)};`);
        else if (path.endsWith(".radius")) lines.push(`${name}: ${RADIUS_CSS[value.word] ?? "0"};`);
        else if (path.endsWith(".shape")) {
          const box = path.slice(0, -".shape".length);
          lines.push(`${name}: ${SHAPE_CSS[value.word] ?? "0"};`);
          // A room's arch stands 4px taller than it is wide, the icon below its crown, as the
          // design draws it; a card's arch is as squat as its other shapes.
          const lift = value.word === "arch" && box === "room.icon" ? "4px" : "0px";
          lines.push(`${cssVar(`${box}.lift`)}: ${lift};`);
          // No box: the icon stands on its own, whatever the background and border say.
          if (value.word === "none") lines.push(`${cssVar(`${box}.box`)}: none;`);
        } else if (path.endsWith(".font")) lines.push(`${name}: var(--font-${value.word});`);
        break;
    }
  }
  for (const colour of COLORS) lines.push(`--${colour.token}: var(--palette-${colour.name});`);
  for (const [token, path] of Object.entries(ALIASES)) lines.push(`--${token}: ${path};`);
  lines.push(
    `--shadow-tile: ${shadowCss("sm", dark)};`,
    `--shadow-lift: ${shadowCss("lg", dark)};`,
  );
  return `:root[data-theme="${theme.id}"] {\n${lines.map((l) => `  ${l}`).join("\n")}\n}\n`;
}

/**
 * The design system's names that a theme's groups stand behind, after the palette: the text
 * roles, the chart series, the spacing scale, the body face and the type scale's sizes. Day
 * and Night point each at the value the tokens already had, so a house theme that changes
 * `space.md` or `font.size.lg` reaches every component through these.
 */
const ALIASES: Record<string, string> = {
  ink: "var(--text-primary)",
  "ink-muted": "var(--text-muted)",
  "terracotta-ink": "var(--text-accent)",
  "on-terracotta": "var(--text-onAccent)",
  "series-1": "var(--chart-series1)",
  "series-2": "var(--chart-series2)",
  "series-3": "var(--chart-series3)",
  "space-1": "var(--space-xs)",
  "space-2": "var(--space-sm)",
  "space-3": "var(--space-md)",
  "space-4": "var(--space-lg)",
  "space-6": "var(--space-xl)",
  "space-8": "calc(var(--space-xl) + var(--space-sm))",
  "font-sans": "var(--font-body)",
  "text-caption-size": "calc(var(--font-size-sm) - 1px)",
  "text-label-size": "var(--font-size-sm)",
  "text-entity-id-size": "var(--font-size-sm)",
  "text-body-size": "var(--font-size-md)",
  "text-heading-size": "calc(var(--font-size-md) + 1px)",
  "text-title-size": "var(--font-size-lg)",
  "text-reading-size": "var(--font-size-xl)",
  "text-display-size": "calc(var(--font-size-xl) + 8px)",
};
