import { describe, expect, test } from "bun:test";
import type { Diagnostic, Registry } from "@casita/core/casa";
import {
  BUILTIN_NAMES,
  BUILTINS,
  COMMON_PROPS,
  DOMAIN_NAMES,
  FUNCTION_NAMES,
} from "@casita/core/casa";
import {
  completions,
  describeTrigger,
  marks,
  offsetOf,
  propertiesAt,
  referenceAt,
  referencesIn,
  type Stream,
  type StreamState,
  startState,
  type TokenStyle,
  themePathsAt,
  token,
} from "./language.ts";

// ───────── a stream over one line, as CodeMirror's StringStream behaves ─────────

class LineStream implements Stream {
  pos = 0;
  start = 0;
  constructor(readonly string: string) {}

  match(pattern: RegExp | string, consume = true): RegExpMatchArray | string | boolean | null {
    if (typeof pattern === "string") {
      if (this.string.startsWith(pattern, this.pos)) {
        if (consume) this.pos += pattern.length;
        return true;
      }
      return null;
    }
    const m = this.string.slice(this.pos).match(pattern);
    if (m?.index !== 0) return null;
    if (consume) this.pos += m[0].length;
    return m;
  }

  eat(pattern: RegExp | string): string | undefined {
    const c = this.string.charAt(this.pos);
    const ok = typeof pattern === "string" ? c === pattern : c !== "" && pattern.test(c);
    if (!ok) return undefined;
    this.pos++;
    return c;
  }

  eatWhile(pattern: RegExp): boolean {
    const from = this.pos;
    while (this.eat(pattern) !== undefined);
    return this.pos > from;
  }

  next(): string | undefined {
    return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined;
  }

  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }

  skipToEnd(): void {
    this.pos = this.string.length;
  }

  eatSpace(): boolean {
    return this.eatWhile(/\s/);
  }

  sol(): boolean {
    return this.pos === 0;
  }

  current(): string {
    return this.string.slice(this.start, this.pos);
  }

  eol(): boolean {
    return this.pos >= this.string.length;
  }
}

/** Every non-space token on a line, with its style; the state carries over between calls. */
function tokens(line: string, state: StreamState = startState()): [string, TokenStyle][] {
  const stream = new LineStream(line);
  const out: [string, TokenStyle][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = token(stream, state);
    if (stream.pos === stream.start) throw new Error(`token() did not advance at ${stream.pos}`);
    if (style) out.push([stream.current(), style]);
  }
  return out;
}

const styleOf = (line: string, text: string, state?: StreamState) =>
  tokens(line, state).find(([t]) => t === text)?.[1];

describe("token", () => {
  // KNOWN BUG: token() asks stream.sol() after it has consumed the word, and a StringStream's
  // sol() is `pos === lineStart`, so it is never true there (checked against CodeMirror's own
  // StringStream too). `theme`/`page`/`component` read as variables and state.theme is never
  // set. Marked failing so it flips to a plain test once token() checks the start before
  // matching (e.g. `const atStart = stream.sol()` ahead of the word match).
  test("declarations are keywords at the start of a line, and `theme` opens a theme", () => {
    expect(tokens("page Home {")).toEqual([
      ["page", "keyword"],
      ["Home", "typeName"],
      ["{", "punctuation"],
    ]);
    expect(styleOf("component Lamp", "component")).toBe("keyword");
    expect(styleOf("automation HallLight", "automation")).toBe("keyword");
    expect(styleOf("sensor KitchenDoor", "sensor")).toBe("keyword");
    expect(styleOf("  input door = binary_sensor.x", "input")).toBe("keyword");
    const state = startState();
    tokens("theme Dusk {", state);
    expect(state.theme).toBe(1);
  });

  test("a declaration word after the start of a line is not a keyword", () => {
    expect(styleOf("x page", "page")).toBe("variableName");
  });

  test("statements and screen are keywords", () => {
    expect(styleOf("if x", "if")).toBe("keyword");
    expect(styleOf("on light.hall changed", "on")).toBe("keyword");
    expect(styleOf("on light.hall changed", "changed")).toBe("keyword");
    expect(styleOf("when: screen == .Phone", "screen")).toBe("keyword");
  });

  test("`run` is a keyword before an integration, and a name elsewhere", () => {
    expect(tokens("run zwave_js.main.led_notify {").slice(0, 2)).toEqual([
      ["run", "keyword"],
      ["zwave_js", "variableName"],
    ]);
    expect(styleOf("    run  hue.2.go", "run")).toBe("keyword");
    expect(styleOf("span: run", "run")).toBe("variableName");
    expect(styleOf("x = run + 1", "run")).toBe("variableName");
    expect(styleOf("set run = 2", "run")).toBe("variableName");
    expect(styleOf("run.x", "run")).toBe("variableName");
    expect(styleOf("run", "run")).toBe("variableName");
    expect(styleOf("run: 2", "run")).toBe("propertyName");
  });

  test("a word before a colon is a property, unless it is a domain or `:=`", () => {
    expect(tokens('name: "Hall"')).toEqual([
      ["name", "propertyName"],
      [":", "punctuation"],
      ['"Hall"', "string"],
    ]);
    expect(styleOf("when : x", "when")).toBe("propertyName");
    expect(styleOf("light: x", "light")).not.toBe("propertyName");
    expect(styleOf("x := 1", "x")).toBe("variableName");
  });

  test("a domain before a dot reads as a variable, then the dot and the id", () => {
    expect(tokens("light.hall")).toEqual([
      ["light", "variableName"],
      [".", "punctuation"],
      ["hall", "variableName"],
    ]);
  });

  test("strings, including an escaped quote and an unterminated one", () => {
    expect(styleOf('"a \\"b\\" c"', '"a \\"b\\" c"')).toBe("string");
    expect(tokens('"open')).toEqual([['"open', "string"]]);
  });

  test("numbers, durations, percents and clock times", () => {
    expect(styleOf("x 21.5", "21.5")).toBe("number");
    expect(styleOf("after 5m", "5m")).toBe("number");
    expect(styleOf("after 250ms", "250ms")).toBe("number");
    expect(styleOf("x 50%", "50%")).toBe("number");
    expect(styleOf("at 07:30", "07:30")).toBe("number");
  });

  test("enum values, booleans and null are atoms; capitalised words are types", () => {
    expect(styleOf("x == .On", ".On")).toBe("atom");
    expect(styleOf("x true", "true")).toBe("atom");
    expect(styleOf("x false", "false")).toBe("atom");
    expect(styleOf("x null", "null")).toBe("atom");
    expect(styleOf("Card {", "Card")).toBe("typeName");
  });

  test("operators run together into one token", () => {
    expect(styleOf("a >= b", ">=")).toBe("operator");
    expect(styleOf("a && b", "&&")).toBe("operator");
    expect(styleOf("a ?? b", "??")).toBe("operator");
  });

  test("a character the language has no use for is invalid", () => {
    expect(styleOf("a @ b", "@")).toBe("invalid");
  });

  test("a line comment takes the rest of the line", () => {
    expect(tokens("Card // the hall")).toEqual([
      ["Card", "typeName"],
      ["// the hall", "comment"],
    ]);
  });

  test("a block comment on one line ends there", () => {
    const state = startState();
    expect(tokens("/* a */ Card", state)).toEqual([
      ["/* a */", "comment"],
      ["Card", "typeName"],
    ]);
    expect(state.inComment).toBe(false);
  });

  test("a block comment spans lines through state.inComment", () => {
    const state = startState();
    expect(tokens("Card /* starts", state)).toEqual([
      ["Card", "typeName"],
      ["/* starts", "comment"],
    ]);
    expect(state.inComment).toBe(true);
    expect(tokens("still inside", state)).toEqual([["still inside", "comment"]]);
    expect(state.inComment).toBe(true);
    expect(tokens("ends */ Text", state)).toEqual([
      ["ends */", "comment"],
      ["Text", "typeName"],
    ]);
    expect(state.inComment).toBe(false);
  });

  test("a hex colour after a space is a colour anywhere", () => {
    expect(styleOf("tone: #f2b05e", "#f2b05e")).toBe("color");
  });

  test("a hex-looking `#` glued to an identifier outside a theme is an attribute's punctuation", () => {
    expect(styleOf("of: light.hall#dead", "#dead")).toBe("punctuation");
    // Not hex at all: the `#` alone, then the attribute name.
    expect(tokens("sensor.x#humidity").slice(-2)).toEqual([
      ["#", "punctuation"],
      ["humidity", "variableName"],
    ]);
  });

  // The theme state is set by hand here, as `theme Dusk {` would leave it (see the failing test
  // above for why the tokenizer does not set it itself today).
  const inTheme = (): StreamState => ({ inComment: false, theme: 1, depth: 1 });

  test("inside a theme body a glued `#rrggbb` is a colour, and the theme ends at its `}`", () => {
    const state = inTheme();
    expect(styleOf("  palette.lamp: #f2b05e", "#f2b05e", state)).toBe("color");
    expect(styleOf("  lamp#f2b05e", "#f2b05e", state)).toBe("color");
    tokens("}", state);
    expect(state.theme).toBe(0);
    expect(state.depth).toBe(0);
    expect(styleOf("x#beef", "#beef", state)).toBe("punctuation");
  });

  test("a nested brace inside a theme does not end it", () => {
    const state = inTheme();
    tokens("  surface.card {", state);
    tokens("  }", state);
    expect(state.theme).toBe(1);
    tokens("}", state);
    expect(state.theme).toBe(0);
  });
});

// ───────── completion ─────────

const REGISTRY: Registry = {
  entities: [
    { id: "light.hall", domain: "light", name: "Hall light" },
    { id: "sensor.hall_temp", domain: "sensor" },
  ],
  areas: [{ id: "hall", name: "Hall" }],
  devices: [{ id: "dev_porch", name: "Porch switch" }],
};

describe("completions", () => {
  const all = completions(REGISTRY, ["Lamp"]);
  const find = (label: string) => all.find((c) => c.label === label);

  test("every built-in is a type that opens its body", () => {
    for (const name of BUILTIN_NAMES) {
      expect(find(name)).toMatchObject({ type: "type", apply: `${name} { ` });
    }
    expect(find("Card")?.apply?.endsWith(" { ")).toBe(true);
  });

  test("the page's own components are offered as components", () => {
    expect(find("Lamp")).toEqual({
      label: "Lamp",
      type: "type",
      detail: "component",
      apply: "Lamp { ",
    });
  });

  test("entities carry their names as detail; areas and devices are prefixed", () => {
    expect(find("light.hall")).toEqual({
      label: "light.hall",
      type: "constant",
      detail: "Hall light",
    });
    expect(find("sensor.hall_temp")).toMatchObject({ type: "constant" });
    expect(find("sensor.hall_temp")?.detail).toBeUndefined();
    expect(find("area.hall")).toEqual({ label: "area.hall", type: "constant", detail: "Hall" });
    expect(find("device.dev_porch")).toEqual({
      label: "device.dev_porch",
      type: "constant",
      detail: "Porch switch",
    });
  });

  test("closed theme groups offer their keys; open groups offer none", () => {
    expect(find("text.primary")).toEqual({
      label: "text.primary",
      type: "variable",
      detail: "theme",
    });
    expect(find("space.md")).toMatchObject({ type: "variable", detail: "theme" });
    expect(find("surface.card.background")).toMatchObject({ detail: "theme" });
    expect(all.some((c) => c.label.startsWith("palette."))).toBe(false);
  });

  test("functions open their argument list", () => {
    expect(FUNCTION_NAMES.length).toBeGreaterThan(0);
    for (const name of FUNCTION_NAMES) {
      expect(find(name)).toMatchObject({ type: "function", apply: `${name}(` });
    }
  });

  test("reserved words are keywords, but a domain name is not offered as one", () => {
    expect(find("if")).toEqual({ label: "if", type: "keyword" });
    const keywords = new Set(all.filter((c) => c.type === "keyword").map((c) => c.label));
    for (const domain of DOMAIN_NAMES) expect(keywords.has(domain)).toBe(false);
  });

  test("the house's collections and the type names are there", () => {
    for (const name of ["areas", "devices", "entities", "now"]) {
      expect(find(name)).toEqual({ label: name, type: "variable" });
    }
    expect(find("Duration")).toEqual({ label: "Duration", type: "type" });
  });

  test("`run` is offered, and each running instance's actions by the name `run` takes", () => {
    const withActions = completions({
      ...REGISTRY,
      integrations: [
        { id: "zwave-js.main", actions: [{ name: "led_notify" }, { name: "ping", schema: {} }] },
        { id: "mqtt.main" },
        { id: "hue.2", actions: [] },
      ],
    });
    expect(withActions.find((c) => c.label === "run")).toEqual({ label: "run", type: "keyword" });
    expect(withActions.filter((c) => c.label.startsWith("run "))).toEqual([
      {
        label: "run zwave_js.main.led_notify",
        type: "function",
        detail: "action",
        apply: "run zwave_js.main.led_notify { ",
      },
      {
        label: "run zwave_js.main.ping",
        type: "function",
        detail: "action",
        apply: "run zwave_js.main.ping { ",
      },
    ]);
  });

  test("with no integrations known, `run` is offered alone", () => {
    expect(find("run")).toEqual({ label: "run", type: "keyword" });
    expect(all.some((c) => c.label.startsWith("run "))).toBe(false);
    expect(all.filter((c) => c.label === "run")).toHaveLength(1);
  });

  test("with no components and an empty house, only the language is offered", () => {
    const bare = completions({ entities: [], areas: [], devices: [] });
    expect(bare.some((c) => c.detail === "component")).toBe(false);
    expect(bare.some((c) => c.type === "constant")).toBe(false);
  });
});

describe("propertiesAt", () => {
  const labels = (source: string, params?: Record<string, string[]>, offset = source.length) =>
    propertiesAt(source, offset, params).map((c) => c.label);
  const common = Object.keys(COMMON_PROPS);

  test("inside a built-in's body: its own props, then the common ones", () => {
    const card = Object.keys(BUILTINS.get("Card")?.props ?? {});
    expect(labels("Card { na")).toEqual([...card, ...common]);
    expect(common).toEqual(["when", "key", "span", "align", "valign"]);
    expect(card).toContain("accent");
    expect(propertiesAt("Card { ", 7).find((c) => c.label === "accent")).toEqual({
      label: "accent",
      type: "property",
      apply: "accent: ",
      boost: 99,
    });
  });

  test("the node's own props are boosted above the common ones, and those above the rest", () => {
    const options = propertiesAt("Card { ", 7);
    const card = Object.keys(BUILTINS.get("Card")?.props ?? {});
    for (const option of options) {
      expect(option.boost).toBe(card.includes(option.label) ? 99 : 98);
    }
  });

  test("nested bodies pick the innermost one still open", () => {
    const grid = Object.keys(BUILTINS.get("Grid")?.props ?? {});
    const card = Object.keys(BUILTINS.get("Card")?.props ?? {});
    expect(labels("Card {\n  Grid {\n    co")).toEqual([...grid, ...common]);
    // The Grid has closed, so the cursor is back in the Card.
    expect(labels("Card {\n  Grid { columns: 2 }\n  ")).toEqual([...card, ...common]);
  });

  test("the offset, not the end of the source, decides", () => {
    const source = "Card { } Grid { }";
    const grid = Object.keys(BUILTINS.get("Grid")?.props ?? {});
    expect(labels(source, {}, 7)).toContain("accent");
    expect(labels(source, {}, 16)).toEqual([...grid, ...common]);
    expect(labels(source, {}, 8)).toEqual([]);
  });

  test("inside a component instance: its params, then the common props", () => {
    expect(labels("Lamp { ", { Lamp: ["of", "dim"] })).toEqual(["of", "dim", ...common]);
    expect(labels("Unknown { ")).toEqual(common);
  });

  test("outside any node, or in a brace with no type before it, nothing", () => {
    expect(labels("")).toEqual([]);
    expect(labels("Card { } ")).toEqual([]);
    expect(labels("if x { ")).toEqual([]);
  });
});

describe("referenceAt", () => {
  const at = (source: string, needle: string, within = 0) => {
    const offset = source.indexOf(needle) + within;
    return referenceAt(source, offset);
  };

  test("an entity, a device and an area, with the text each covers", () => {
    const source =
      "Row { of: light.hall }\nArea { of: area.living }\nText { value: device.dev_1.name }";
    expect(at(source, "light.hall", 3)).toEqual({
      kind: "entity",
      id: "light.hall",
      from: source.indexOf("light.hall"),
      to: source.indexOf("light.hall") + "light.hall".length,
    });
    expect(at(source, "area.living", 6)?.id).toBe("living");
    expect(at(source, "area.living")?.kind).toBe("area");
    expect(at(source, "device.dev_1", 9)).toMatchObject({ kind: "device", id: "dev_1" });
  });

  test("the whole of the reference answers, from its first character to just past its last", () => {
    const source = "x: light.hall";
    const from = source.indexOf("light");
    expect(referenceAt(source, from)?.id).toBe("light.hall");
    expect(referenceAt(source, source.length)?.id).toBe("light.hall");
    expect(referenceAt(source, from - 1)).toBeNull();
  });

  test("a member or an attribute after the id leaves the reference as it is", () => {
    expect(at("when: light.hall.value == .On", "light.hall", 2)?.id).toBe("light.hall");
    expect(at("when: light.hall.value == .On", ".value", 2)).toBeNull();
    expect(at("text: date(switch.x#lastWateredAt.value)", "switch.x", 4)?.id).toBe("switch.x");
  });

  test("a theme path, a property, a member of something else, and the tail of a path are not references", () => {
    expect(at("color: palette.lamp", "palette.lamp", 3)).toBeNull();
    expect(at("size: section.title.size", "title.size", 2)).toBeNull();
    expect(at("Area { of: area.living }", "of:", 2)).toBeNull();
    expect(at("when: any(of.entities, (e) => e.area == null)", "e.area", 3)).toBeNull();
    expect(at("x: of.light.hall", "light.hall", 2)).toBeNull();
  });

  test("a reference in a comment or a string is passed over", () => {
    expect(at("// light.hall is the lamp", "light.hall", 2)).toBeNull();
    expect(at('label: "light.hall"', "light.hall", 2)).toBeNull();
    expect(at('label: "a" + light.hall.name', "light.hall", 2)?.id).toBe("light.hall");
  });

  test("outside any reference, or past the text, nothing", () => {
    expect(referenceAt("Card { }", 3)).toBeNull();
    expect(referenceAt("x", 5)).toBeNull();
    expect(referenceAt("", 0)).toBeNull();
  });
});

describe("referencesIn", () => {
  const source =
    "Row { of: light.hall, light.den }\n// area.attic\nArea { of: area.living }\nText { value: device.dev_1.name }";

  test("every reference in the text, in order, each with the text it covers", () => {
    const refs = referencesIn(source);
    expect(refs.map((ref) => ref.id)).toEqual(["light.hall", "light.den", "living", "dev_1"]);
    expect(refs.map((ref) => source.slice(ref.from, ref.to))).toEqual([
      "light.hall",
      "light.den",
      "area.living",
      "device.dev_1",
    ]);
    expect(refs[2]).toMatchObject({ kind: "area", id: "living" });
  });

  test("a span takes every reference on the lines it touches", () => {
    const den = source.indexOf("light.den");
    expect(referencesIn(source, den + 2, den + 3).map((ref) => ref.id)).toEqual([
      "light.hall",
      "light.den",
    ]);
    const living = source.indexOf("area.living");
    expect(referencesIn(source, den, living).map((ref) => ref.id)).toEqual([
      "light.hall",
      "light.den",
      "living",
    ]);
    expect(referencesIn(source, source.length, source.length).map((ref) => ref.id)).toEqual([
      "dev_1",
    ]);
  });

  test("a comment ends its line; a string is passed over; the rest of the line is kept", () => {
    expect(referencesIn("x: light.a // light.b").map((ref) => ref.id)).toEqual(["light.a"]);
    expect(referencesIn('x: "light.a" + light.b.name').map((ref) => ref.id)).toEqual(["light.b"]);
    expect(referencesIn("color: palette.lamp\nsize: section.title.size")).toEqual([]);
    expect(referencesIn("")).toEqual([]);
  });
});

describe("themePathsAt", () => {
  const paths = ["palette.lamp", "palette.sky", "text.primary", "surface.card.background"];

  test("the paths under the word's last dot", () => {
    expect(themePathsAt("palette.", paths).map((c) => c.label)).toEqual([
      "palette.lamp",
      "palette.sky",
    ]);
    expect(themePathsAt("palette.la", paths).map((c) => c.label)).toEqual([
      "palette.lamp",
      "palette.sky",
    ]);
    expect(themePathsAt("surface.card.b", paths)).toEqual([
      { label: "surface.card.background", type: "variable", detail: "theme" },
    ]);
  });

  test("a word without a dot, or a prefix nothing has, gives nothing", () => {
    expect(themePathsAt("palette", paths)).toEqual([]);
    expect(themePathsAt("chart.", paths)).toEqual([]);
  });
});

// ───────── diagnostics ─────────

const diag = (start: number, end: number, level: "error" | "warning" = "error"): Diagnostic => ({
  code: "E001",
  level,
  message: "something is off",
  span: { start, end, line: 1, col: start + 1 },
});

describe("marks", () => {
  test("a span inside the text is kept, with the code in the message", () => {
    expect(marks([diag(2, 5)], 10)).toEqual([
      { from: 2, to: 5, severity: "error", message: "E001: something is off", code: "E001" },
    ]);
  });

  test("the level becomes the severity", () => {
    expect(marks([diag(0, 1, "warning")], 10)[0]?.severity).toBe("warning");
  });

  test("a zero-width span is widened to one character", () => {
    expect(marks([diag(3, 3)], 10)[0]).toMatchObject({ from: 3, to: 4 });
  });

  test("a span past the text is clamped to it", () => {
    expect(marks([diag(8, 40)], 10)[0]).toMatchObject({ from: 8, to: 10 });
    // Wholly past the end: it lands at the end, where there is no character to widen over.
    expect(marks([diag(40, 50)], 10)[0]).toMatchObject({ from: 10, to: 10 });
  });

  test("an empty source and no diagnostics", () => {
    expect(marks([diag(0, 0)], 0)[0]).toMatchObject({ from: 0, to: 0 });
    expect(marks([], 10)).toEqual([]);
  });
});

describe("offsetOf", () => {
  const source = "ab\ncde\nf";

  test("lines and columns are 1-based", () => {
    expect(offsetOf(source, 1, 1)).toBe(0);
    expect(offsetOf(source, 2, 1)).toBe(3);
    expect(offsetOf(source, 2, 3)).toBe(5);
    expect(offsetOf(source, 3, 1)).toBe(7);
  });

  test("a column past the line's end stops at the end of that line", () => {
    expect(offsetOf(source, 1, 99)).toBe(2);
    expect(offsetOf(source, 3, 99)).toBe(source.length);
  });

  test("a line past the last one is the end of the text", () => {
    expect(offsetOf(source, 9, 1)).toBe(source.length);
  });

  test("a column below 1 is the line's start", () => {
    expect(offsetOf(source, 2, 0)).toBe(3);
  });
});

describe("describeTrigger", () => {
  test("every picks the largest whole unit", () => {
    expect(describeTrigger({ kind: "every", ms: 7_200_000 })).toBe("every 2h");
    expect(describeTrigger({ kind: "every", ms: 300_000 })).toBe("every 5m");
    expect(describeTrigger({ kind: "every", ms: 90_000 })).toBe("every 90s");
  });

  test("at is a zero-padded clock time", () => {
    expect(describeTrigger({ kind: "at", minutes: 7 * 60 + 5 })).toBe("at 07:05");
    expect(describeTrigger({ kind: "at", minutes: 0 })).toBe("at 00:00");
    expect(describeTrigger({ kind: "at", minutes: 23 * 60 + 59 })).toBe("at 23:59");
  });

  test("changed names the entity, the attribute, and whether to/from are given", () => {
    expect(describeTrigger({ kind: "changed", entity: "light.hall" })).toBe(
      "on light.hall changed",
    );
    expect(describeTrigger({ kind: "changed", entity: "sensor.x", attr: "humidity" })).toBe(
      "on sensor.x#humidity changed",
    );
    expect(describeTrigger({ kind: "changed", entity: "light.hall", to: {}, from: {} })).toBe(
      "on light.hall changed to … from …",
    );
    expect(describeTrigger({ kind: "changed", entity: "light.hall", from: {} })).toBe(
      "on light.hall changed from …",
    );
  });
});
