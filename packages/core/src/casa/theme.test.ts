import { describe, expect, test } from "bun:test";
import { selectableThemes } from "./compile.ts";
import { Diagnostics } from "./diagnostics.ts";
import { parse } from "./parser.ts";
import {
  builtinThemes,
  compileTheme,
  coverage,
  cssVar,
  isBuiltinTheme,
  isDark,
  lookup,
  OCTOBER_SOURCE,
  themeCss,
  themePaths,
  themePathType,
  VOCABULARY,
} from "./theme.ts";

const [day, night, october] = builtinThemes() as [
  ReturnType<typeof builtinThemes>[0],
  ReturnType<typeof builtinThemes>[0],
  ReturnType<typeof builtinThemes>[0],
];

const theme = (source: string) => {
  const diagnostics = new Diagnostics();
  const file = parse(source, diagnostics);
  const decl = file.themes[0];
  if (!decl) throw new Error("no theme");
  const compiled = compileTheme(decl, [day, night], diagnostics);
  return { compiled, messages: diagnostics.list.map((d) => `${d.code} ${d.message}`) };
};

describe("Day and Night", () => {
  test("carry the 23 token colours under camel-case names", () => {
    const palette = themePaths(day).filter((p) => p.startsWith("palette."));
    expect(palette).toHaveLength(23);
    expect(palette).toContain("palette.surfaceRaised");
    expect(palette).toContain("palette.series1");
    expect(day.values["palette.lamp"]).toEqual({ kind: "color", hex: "#eaa63e" });
    expect(night.values["palette.lamp"]).toEqual({ kind: "color", hex: "#f2b85a" });
  });

  test("define every closed key of every group", () => {
    for (const [group, spec] of Object.entries(VOCABULARY)) {
      for (const key of Object.keys(spec.keys)) {
        expect(day.values[`${group}.${key}`]).toBeDefined();
        expect(night.values[`${group}.${key}`]).toBeDefined();
      }
    }
  });

  test("read as light and dark, with the breakpoints app.css uses", () => {
    expect(isDark(day)).toBe(false);
    expect(isDark(night)).toBe(true);
    expect(day.values["breakpoints.tablet"]).toEqual({ kind: "number", value: 860 });
    expect(day.values["breakpoints.desktop"]).toEqual({ kind: "number", value: 1100 });
  });

  test("lookup follows palette references", () => {
    expect(lookup(day, "text.primary")).toEqual({ kind: "color", hex: "#2a221b" });
    expect(lookup(day, "chart.good")).toEqual({ kind: "color", hex: "#3a7454" });
    expect(lookup(day, "nothing")).toBeUndefined();
  });

  test("a card is a well: the sunken surface with no edge, its icon raised on it", () => {
    for (const t of [day, night]) {
      expect(lookup(t, "surface.card.background")).toEqual(lookup(t, "palette.surfaceSunken"));
      expect(t.values["surface.card.border"]).toEqual({ kind: "word", word: "none" });
      expect(lookup(t, "card.icon.background")).not.toEqual(lookup(t, "surface.card.background"));
    }
    expect(themeCss(night)).toContain("--surface-card-background: var(--palette-surfaceSunken);");
    expect(themeCss(night)).toContain("--surface-card-border: none;");
  });
});

describe("October", () => {
  test("is a built-in over Night, dark, with its Casa source attached", () => {
    expect(october.id).toBe("october");
    expect(october.extends).toBe("Night");
    expect(october.source).toBe(OCTOBER_SOURCE);
    expect(isDark(october)).toBe(true);
    expect(builtinThemes().map(isBuiltinTheme)).toEqual([true, true, true]);
    expect(isBuiltinTheme({ ...october, id: "dusk" })).toBe(false);
  });

  test("recolours the whole palette and touches every other kind of group", () => {
    const palette = themePaths(night).filter((p) => p.startsWith("palette."));
    for (const path of palette) expect(october.values[path]).not.toEqual(night.values[path]);
    const changed = themePaths(night).filter(
      (path) => !path.startsWith("palette.") && october.values[path] !== night.values[path],
    );
    expect(changed).toEqual([
      "card.icon.background",
      "card.icon.border",
      "card.icon.padding",
      "card.icon.shape",
      "card.icon.size",
      "card.subtitle.font",
      "card.subtitle.size",
      "card.title.font",
      "card.title.size",
      "card.title.weight",
      "divider.inset",
      "font.size.lg",
      "font.size.xl",
      "room.icon.background",
      "room.icon.border",
      "room.icon.padding",
      "room.icon.shape",
      "room.icon.size",
      "room.name.font",
      "room.name.size",
      "room.name.weight",
      "room.subtitle.color",
      "room.subtitle.font",
      "room.subtitle.size",
      "section.title.color",
      "section.title.font",
      "section.title.size",
      "section.title.weight",
      "space.lg",
      "space.md",
      "space.xl",
      "surface.card.background",
      "surface.card.border",
      "surface.card.radius",
      "surface.card.shadow",
      "surface.control.radius",
      "surface.raised.radius",
    ]);
    expect(october.values["surface.control.radius"]).toEqual({ kind: "word", word: "full" });
    expect(themeCss(october)).toContain("--surface-control-radius: 999px;");
    expect(themeCss(october)).toContain("--room-icon-shape: 999px;");
    expect(themeCss(october)).toContain("--room-icon-lift: 0px;");
    expect(themeCss(october)).toContain("--room-name-font: var(--font-display);");
    expect(themeCss(october)).toContain(
      "--surface-card-border: 1px solid var(--palette-lineStrong);",
    );
    expect(themeCss(october)).toContain("--surface-card-background: var(--palette-surfaceRaised);");
    expect(themeCss(october)).toContain("--space-md: 14px;");
    expect(lookup(october, "text.accent")).toEqual({ kind: "color", hex: "#f8a659" });
    expect(themeCss(october)).toContain(':root[data-theme="october"]');
    expect(themeCss(october)).toContain("--terracotta: var(--palette-terracotta);");
  });

  test("keeps text readable on every surface", () => {
    const surfaces = ["surface.page.background", "surface.card.background"];
    const texts = ["text.primary", "text.muted", "text.accent", "text.danger"];
    for (const surface of surfaces) {
      for (const text of texts) {
        expect(contrast(hexAt(october, surface), hexAt(october, text))).toBeGreaterThan(4.5);
      }
    }
    expect(
      contrast(hexAt(october, "palette.terracotta"), hexAt(october, "text.onAccent")),
    ).toBeGreaterThan(4.5);
  });

  test("keeps its cards raised, in its own colour, where Night sinks them", () => {
    expect(lookup(october, "surface.card.background")).toEqual(
      lookup(october, "palette.surfaceRaised"),
    );
    expect(lookup(october, "surface.card.background")).not.toEqual(
      lookup(october, "palette.surfaceSunken"),
    );
  });

  test("can be extended by a house theme, which inherits its palette", () => {
    const diagnostics = new Diagnostics();
    const decl = parse("theme Hallow extends October { palette { lamp: #ffd166 } }", diagnostics)
      .themes[0];
    const hallow = decl && compileTheme(decl, builtinThemes(), diagnostics);
    expect(diagnostics.list).toEqual([]);
    expect(hallow?.extends).toBe("October");
    expect(hallow?.values["palette.terracotta"]).toEqual({ kind: "color", hex: "#f08a2e" });
    expect(hallow?.values["palette.lamp"]).toEqual({ kind: "color", hex: "#ffd166" });
    expect(hallow?.source).toBeUndefined();
    expect(hallow && isBuiltinTheme(hallow)).toBe(false);
    expect(hallow && isDark(hallow)).toBe(true);
  });

  test("is selectable with the other built-ins until the house has a theme of its own", () => {
    const builtins = builtinThemes();
    expect(selectableThemes(builtins).map((t) => t.id)).toEqual(["day", "night", "october"]);
    const { compiled } = theme("theme Dusk extends Night { palette { lamp: #f2b05e } }");
    expect(selectableThemes([...builtins, compiled as typeof day]).map((t) => t.id)).toEqual([
      "dusk",
    ]);
  });
});

const hexAt = (theme: typeof day, path: string): string => {
  const value = lookup(theme, path);
  if (value?.kind !== "color") throw new Error(`${path} is not a colour`);
  return value.hex;
};

/** WCAG contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe("a theme declaration", () => {
  test("extends a built-in and overrides or adds values", () => {
    const { compiled, messages } = theme(`theme Dusk extends Night {
      palette    { lamp: #f2b05e  warn: #d9593a }
      surface.card { background: palette.plaster  border: hairline  shadow: lg  radius: md }
      breakpoints  { tablet: 640  desktop: 1100 }
      text { accent: lamp }
    }`);
    expect(messages).toEqual([]);
    expect(compiled?.id).toBe("dusk");
    expect(compiled?.extends).toBe("Night");
    expect(compiled?.values["palette.lamp"]).toEqual({ kind: "color", hex: "#f2b05e" });
    expect(compiled?.values["palette.warn"]).toEqual({ kind: "color", hex: "#d9593a" });
    expect(compiled?.values["palette.ink"]).toEqual(night.values["palette.ink"]);
    expect(compiled?.values["surface.card.background"]).toEqual({
      kind: "ref",
      path: "palette.plaster",
    });
    expect(compiled?.values["surface.card.shadow"]).toEqual({ kind: "word", word: "lg" });
    expect(compiled?.values["breakpoints.tablet"]).toEqual({ kind: "number", value: 640 });
    expect(compiled?.values["text.accent"]).toEqual({ kind: "ref", path: "palette.lamp" });
  });

  test("sets the divider between a card's blocks: colour, thickness, inset and room", () => {
    const { compiled, messages } = theme(`theme Lined extends Day {
      divider { color: terracotta  height: 2  inset: 16  space: 8 }
    }`);
    expect(messages).toEqual([]);
    expect(compiled?.values["divider.color"]).toEqual({ kind: "ref", path: "palette.terracotta" });
    expect(compiled?.values["divider.height"]).toEqual({ kind: "number", value: 2 });
    expect(compiled?.values["divider.inset"]).toEqual({ kind: "number", value: 16 });
    expect(compiled?.values["divider.space"]).toEqual({ kind: "number", value: 8 });
    expect(compiled?.css).toContain("--divider-color: var(--palette-terracotta);");
    expect(compiled?.css).toContain("--divider-height: 2px;");
    expect(compiled?.css).toContain("--divider-inset: 16px;");
    expect(compiled?.css).toContain("--divider-space: 8px;");
    // Day's own: the design system's line, one pixel, edge to edge, 12px above and below.
    expect(day.values["divider.color"]).toEqual({ kind: "ref", path: "palette.line" });
    expect(themeCss(day)).toContain("--divider-inset: 0px;");
    expect(theme("theme L extends Day { divider { width: 2 } }").messages[0]).toContain(
      "theme group `divider` has no key `width`",
    );
  });

  test("resizes the spacing scale, the type and the controls, and the design system's names follow", () => {
    const { compiled, messages } = theme(`theme Roomy extends Day {
      space { md: 20 }
      font.size { md: 17 }
      surface.control { radius: full }
    }`);
    expect(messages).toEqual([]);
    expect(compiled?.css).toContain("--space-md: 20px;");
    expect(compiled?.css).toContain("--space-3: var(--space-md);");
    expect(compiled?.css).toContain("--font-size-md: 17px;");
    expect(compiled?.css).toContain("--text-body-size: var(--font-size-md);");
    expect(compiled?.css).toContain("--surface-control-radius: 999px;");
  });

  test("must extend something", () => {
    expect(theme("theme Dusk { }").messages).toEqual([
      "E021 theme `Dusk` must extend `Day` or `Night` (or a theme that does), so every page value has a default",
    ]);
  });

  test("refuses the wrong kind of value", () => {
    expect(theme("theme Dusk extends Night { space { md: #fff } }").messages).toEqual([
      "E030 theme value `space.md` expects a number, got a colour",
    ]);
    expect(theme("theme Dusk extends Night { surface.card { border: huge } }").messages).toEqual([
      "E030 theme value `surface.card.border` is one of none hairline thin thick, not `huge`",
    ]);
    expect(theme('theme Dusk extends Night { palette { lamp: "red" } }').messages).toEqual([
      "E030 theme value `palette.lamp` expects a colour or a palette name, got a string",
    ]);
    expect(theme("theme Dusk extends Night { glow { x: 1 } }").messages).toEqual([
      "E022 `glow` is not a theme group",
    ]);
  });

  test("a reference must be a palette colour", () => {
    expect(theme("theme Dusk extends Night { text { muted: space.md } }").messages).toEqual([
      "E021 `space.md` is not a palette colour this theme has",
    ]);
  });
});

describe("coverage", () => {
  test("names every theme that lacks a referenced path", () => {
    const { compiled } = theme("theme Dusk extends Night { palette { warn: #d9593a } }");
    const dusk = compiled as NonNullable<typeof compiled>;
    expect(coverage([day, night, dusk], ["palette.warn", "palette.lamp"])).toEqual([
      { theme: "Day", path: "palette.warn" },
      { theme: "Night", path: "palette.warn" },
    ]);
    expect(coverage([dusk], ["palette.warn"])).toEqual([]);
  });
});

describe("the headings", () => {
  test("Day and Night draw them as the components did: an arch for a room and a card", () => {
    for (const t of [day, night]) {
      expect(t.values["room.icon.shape"]).toEqual({ kind: "word", word: "arch" });
      expect(t.values["room.icon.size"]).toEqual({ kind: "number", value: 22 });
      expect(t.values["room.icon.padding"]).toEqual({ kind: "number", value: 11 });
      expect(lookup(t, "room.icon.background")).toEqual(lookup(t, "palette.surfaceRaised"));
      expect(t.values["card.icon.padding"]).toEqual({ kind: "number", value: 9 });
      expect(lookup(t, "card.icon.background")).toEqual(lookup(t, "palette.surfaceRaised"));
      expect(t.values["room.name.size"]).toEqual({ kind: "number", value: 28 });
      expect(t.values["room.name.weight"]).toEqual({ kind: "number", value: 600 });
      expect(t.values["room.name.font"]).toEqual({ kind: "word", word: "body" });
      expect(t.values["card.subtitle.size"]).toEqual({ kind: "number", value: 13 });
      expect(t.values["section.title.size"]).toEqual({ kind: "number", value: 16 });
    }
    const css = themeCss(day);
    expect(css).toContain("--room-icon-shape: 999px 999px 6px 6px;");
    expect(css).toContain("--room-icon-lift: 4px;");
    expect(css).toContain("--card-icon-shape: 999px;");
    expect(css).toContain("--card-icon-lift: 0px;");
    expect(css).toContain("--room-name-font: var(--font-body);");
    expect(css).toContain("--room-name-weight: 600;");
    expect(css).not.toContain("--room-icon-box");
  });

  test("a shape, a face and a weight are checked as words and a range", () => {
    const { compiled, messages } = theme(`theme Ringed extends Day {
      room.icon { shape: circle  border: thin  size: 28  padding: 8 }
      room.name { font: display  weight: 700  size: 26 }
      card.icon { shape: none }
    }`);
    expect(messages).toEqual([]);
    const css = themeCss(compiled as typeof day);
    expect(css).toContain("--room-icon-shape: 999px;");
    expect(css).toContain("--room-icon-lift: 0px;");
    expect(css).toContain("--room-icon-border: 1px solid var(--palette-lineStrong);");
    expect(css).toContain("--room-name-font: var(--font-display);");
    expect(css).toContain("--room-name-weight: 700;");
    expect(css).toContain("--card-icon-shape: 0;");
    expect(css).toContain("--card-icon-box: none;");
    expect(theme("theme R extends Day { room.icon { shape: hexagon } }").messages).toEqual([
      "E030 theme value `room.icon.shape` is one of arch circle square none, not `hexagon`",
    ]);
    expect(theme("theme R extends Day { room.name { font: serif } }").messages).toEqual([
      "E030 theme value `room.name.font` is one of body display mono, not `serif`",
    ]);
    expect(theme("theme R extends Day { room.name { weight: 650 } }").messages).toEqual([
      "E030 theme value `room.name.weight` is a weight from 100 to 900 in hundreds, not 650",
    ]);
    expect(theme("theme R extends Day { section.title { weight: bold } }").messages).toEqual([
      "E030 theme value `section.title.weight` expects a weight from 100 to 900, got `bold`",
    ]);
  });
});

describe("the type of a theme path", () => {
  test("heading paths read as the kinds a page's Icon and Text take", () => {
    expect(themePathType(["room", "icon", "shape"])).toEqual({ kind: "token", group: "shape" });
    expect(themePathType(["room", "icon", "size"])).toEqual({ kind: "number" });
    expect(themePathType(["room", "name", "weight"])).toEqual({ kind: "number" });
    expect(themePathType(["room", "name", "font"])).toEqual({ kind: "token", group: "font" });
    expect(themePathType(["card", "title", "color"])).toEqual({ kind: "color" });
    expect(themePathType(["section", "title", "shape"])).toBeUndefined();
  });

  test("colours, tokens and numbers", () => {
    expect(themePathType(["palette", "lamp"])).toEqual({ kind: "color" });
    expect(themePathType(["accents", "anything"])).toEqual({ kind: "color" });
    expect(themePathType(["surface", "card", "background"])).toEqual({ kind: "color" });
    expect(themePathType(["surface", "card", "radius"])).toEqual({
      kind: "token",
      group: "radius",
    });
    expect(themePathType(["space", "md"])).toEqual({ kind: "token", group: "space" });
    expect(themePathType(["font", "body"])).toEqual({ kind: "token", group: "font" });
    expect(themePathType(["font", "size", "md"])).toEqual({ kind: "number" });
    expect(themePathType(["breakpoints", "tablet"])).toEqual({ kind: "number" });
    expect(themePathType(["text", "glow"])).toBeUndefined();
    expect(themePathType(["surface", "card"])).toBeUndefined();
    expect(themePathType(["nothing"])).toBeUndefined();
  });
});

describe("CSS", () => {
  test("one rule per theme, by path, with the design system's names as aliases", () => {
    const css = themeCss(day);
    expect(css).toStartWith(':root[data-theme="day"] {\n  color-scheme: light;');
    expect(css).toContain("--palette-lamp: #eaa63e;");
    expect(css).toContain("--text-primary: var(--palette-ink);");
    expect(css).toContain("--space-md: 12px;");
    expect(css).toContain("--breakpoints-tablet: 860;");
    expect(css).toContain("--surface-card-background: var(--palette-surfaceSunken);");
    expect(css).toContain("--surface-card-border: none;");
    expect(css).toContain("--surface-card-radius: 14px;");
    expect(css).toContain("--surface-card-shadow: none;");
    expect(css).toContain('--font-body: "Figtree", system-ui, sans-serif;');
    expect(css).toContain("--lamp: var(--palette-lamp);");
    // The ink that reads on each accent, for the headings and the components alike.
    expect(css).toContain("--accents-onLamp: var(--palette-inkOnLamp);");
    expect(css).toContain("--accents-onSky: var(--palette-onSky);");
    expect(css).toContain("--accents-onSage: var(--palette-plaster);");
    expect(css).toContain("--accents-onEmber: var(--palette-inkOnLamp);");
    expect(css).toContain("--surface-raised: var(--palette-surfaceRaised);");
    expect(css).toContain("--shadow-lift: 0 8px 24px rgba(42,34,27,0.14);");
    expect(themeCss(night)).toContain("--shadow-lift: 0 8px 24px rgba(0,0,0,0.5);");
    expect(cssVar("surface.card.background")).toBe("--surface-card-background");
  });

  test("the text roles, series, spacing scale, body face and type sizes stand behind the tokens", () => {
    const css = themeCss(day);
    expect(css).toContain("--ink: var(--text-primary);");
    expect(css).toContain("--ink-muted: var(--text-muted);");
    expect(css).toContain("--terracotta-ink: var(--text-accent);");
    expect(css).toContain("--on-terracotta: var(--text-onAccent);");
    expect(css).toContain("--danger: var(--palette-danger);");
    expect(css).toContain("--series-2: var(--chart-series2);");
    expect(css).toContain("--space-1: var(--space-xs);");
    expect(css).toContain("--space-6: var(--space-xl);");
    expect(css).toContain("--space-8: calc(var(--space-xl) + var(--space-sm));");
    expect(css).toContain("--font-sans: var(--font-body);");
    expect(css).toContain("--text-body-size: var(--font-size-md);");
    expect(css).toContain("--text-display-size: calc(var(--font-size-xl) + 8px);");
    expect(css).toContain("--text-caption-size: calc(var(--font-size-sm) - 1px);");
  });

  test("a compiled theme carries its css", () => {
    const { compiled } = theme("theme Dusk extends Night { palette { lamp: #f2b05e } }");
    expect(compiled?.css).toContain('[data-theme="dusk"]');
    expect(compiled?.css).toContain("--palette-lamp: #f2b05e;");
    expect(compiled?.css).toContain("color-scheme: dark;");
  });
});
