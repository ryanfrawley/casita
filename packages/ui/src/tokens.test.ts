import { expect, test } from "bun:test";
import {
  CASA_TOKENS_TS,
  casaName,
  casaTokensTs,
  TOKENS_CSS,
  TOKENS_JSON,
  type Tokens,
  tokensCss,
  valueIn,
} from "../scripts/tokens.ts";

const STYLES = `${import.meta.dir}/styles`;
const APP_CSS = `${import.meta.dir}/../../web/src/app.css`;

const tokens: Tokens = await Bun.file(TOKENS_JSON).json();
const css = await Bun.file(TOKENS_CSS).text();

test("tokens.css is what tokens.json generates", () => {
  // If this fails, run `bun run ui:tokens`.
  expect(css).toBe(tokensCss(tokens));
});

test("the Casa compiler's copy of the tokens is what tokens.json generates", async () => {
  // If this fails, run `bun run ui:tokens`.
  expect(await Bun.file(CASA_TOKENS_TS).text()).toBe(casaTokensTs(tokens));
});

test("a Casa palette name is the token name in camel case", () => {
  expect(casaName("surface-raised")).toBe("surfaceRaised");
  expect(casaName("series-1")).toBe("series1");
  expect(casaName("ink")).toBe("ink");
});

test("every token is declared for Day, and every colour and shadow again for Night", () => {
  const day = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
  const night = css.slice(css.indexOf(':root[data-theme="dark"]'));
  for (const family of [tokens.color, tokens.spacing, tokens.radius, tokens.shadow]) {
    for (const token of family.tokens) expect(day).toContain(`--${token.name}: `);
  }
  for (const token of [...tokens.color.tokens, ...tokens.shadow.tokens]) {
    expect(night).toContain(`--${token.name}: ${valueIn(token, "dark", "light")};`);
  }
});

test("a token with one value holds in every theme; a missing theme falls back to the first", () => {
  expect(valueIn({ name: "a", value: "4px" }, "dark", "light")).toBe("4px");
  expect(valueIn({ name: "a", value: { light: "#fff" } }, "dark", "light")).toBe("#fff");
  expect(() => valueIn({ name: "a", value: {} }, "dark", "light")).toThrow("no value");
});

test("anything but light then dark is refused rather than half-written", () => {
  const themes = [{ id: "dark", name: "Night" }];
  expect(() => tokensCss({ ...tokens, color: { ...tokens.color, themes } })).toThrow();
});

test("a type size in anything but px is refused, naming the value", () => {
  const [group, ...groups] = tokens.type.groups;
  if (!group) throw new Error("no type groups");
  const [style, ...styles] = group.styles;
  if (!style) throw new Error("no type styles");
  const rem = { ...style, fontSize: "1.2rem" };
  const type = { ...tokens.type, groups: [{ ...group, styles: [rem, ...styles] }, ...groups] };
  expect(() => tokensCss({ ...tokens, type })).toThrow("type sizes are in px, not 1.2rem");
});

test("every reference to a theme's surface variables has a fallback for before the theme loads", async () => {
  const files = [
    ...[...new Bun.Glob("**/*.css").scanSync(STYLES)].map((path) => `${STYLES}/${path}`),
    APP_CSS,
  ];
  const bare: string[] = [];
  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(
      /var\(\s*(--surface-(?:card|raised|control)-[\w-]+)\s*([,)])/g,
    )) {
      if (match[2] === ")") bare.push(`${file}: ${match[1]}`);
    }
  }
  expect(files.length).toBeGreaterThan(1);
  expect(bare).toEqual([]);
});

// ───────── contrast ─────────

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const colour = (name: string, theme: string): string => {
  const token = tokens.color.tokens.find((candidate) => candidate.name === name);
  if (!token) throw new Error(`No colour token ${name}`);
  return valueIn(token, theme, "light");
};

const SURFACES = ["plaster", "surface-raised", "surface-sunken"];
/** Text on its ground, as each token's usage note names it: 4.5:1. */
const TEXT: [text: string, ground: string][] = [
  ...SURFACES.flatMap((ground): [string, string][] => [
    ["ink", ground],
    ["ink-muted", ground],
  ]),
  ["terracotta-ink", "plaster"],
  ["terracotta-ink", "surface-raised"],
  ["on-terracotta", "terracotta"],
  ["ink-on-lamp", "lamp"],
  ["on-sky", "sky"],
  ["on-danger", "danger"],
  ["danger", "plaster"],
  ["danger", "surface-raised"],
  ["sage", "plaster"],
  ["sage", "surface-raised"],
];
/** Control borders, focus rings and chart marks: 3:1. */
const MARKS: [mark: string, ground: string][] = [
  ["line-strong", "plaster"],
  ["line-strong", "surface-raised"],
  ...SURFACES.map((ground): [string, string] => ["sky", ground]),
  ["series-1", "surface-raised"],
  ["series-2", "surface-raised"],
  ["series-3", "surface-raised"],
];

for (const theme of ["light", "dark"]) {
  test.each(TEXT)(`${theme}: %s on %s reads at 4.5:1`, (text, ground) => {
    expect(contrast(colour(text, theme), colour(ground, theme))).toBeGreaterThanOrEqual(4.5);
  });
  test.each(MARKS)(`${theme}: %s on %s shows at 3:1`, (mark, ground) => {
    expect(contrast(colour(mark, theme), colour(ground, theme))).toBeGreaterThanOrEqual(3);
  });
}

// ───────── generator details, on a small fixture ─────────

const fixture: Tokens = {
  color: {
    themes: [
      { id: "light", name: "Day" },
      { id: "dark", name: "Night" },
    ],
    tokens: [{ name: "ink", value: { light: "#111111", dark: "#eeeeee" } }],
  },
  type: {
    families: { sans: '"Figtree", sans-serif', mono: "monospace" },
    groups: [
      {
        family: "sans",
        styles: [
          { name: "big", fontSize: "40px", lineHeight: "44px", fontWeight: 600 },
          {
            name: "tight",
            fontSize: "12px",
            lineHeight: "16px",
            fontWeight: 400,
            letterSpacing: "-0.01em",
          },
        ],
      },
      {
        family: "mono",
        styles: [{ name: "code", fontSize: "13px", lineHeight: "18px", fontWeight: 400 }],
      },
    ],
  },
  spacing: { tokens: [{ name: "space-1", value: "4px" }] },
  grid: { tokens: [{ name: "grid-unit", value: "64px" }] },
  radius: { tokens: [{ name: "radius-1", value: "6px" }] },
  shadow: { tokens: [{ name: "shadow-1", value: { light: "0 1px #000", dark: "0 1px #fff" } }] },
};
const out = tokensCss(fixture);
const section = (from: string, to?: string) =>
  out.slice(out.indexOf(from), to === undefined ? undefined : out.indexOf(to, out.indexOf(from)));

test("Day declares light colour-scheme, its values, the fixed scales and the font families", () => {
  expect(section(":root {", "}")).toBe(
    [
      ":root {",
      "  color-scheme: light;",
      "  --ink: #111111;",
      "  --shadow-1: 0 1px #000;",
      "  --space-1: 4px;",
      "  --grid-unit: 64px;",
      "  --radius-1: 6px;",
      '  --font-sans: "Figtree", sans-serif;',
      "  --font-mono: monospace;",
      "",
    ].join("\n"),
  );
});

test("the system's dark preference applies Night unless the page asks for light by name", () => {
  expect(section("@media", ":root[data-theme")).toBe(
    [
      "@media (prefers-color-scheme: dark) {",
      '  :root:not([data-theme="light"]) {',
      "    color-scheme: dark;",
      "    --ink: #eeeeee;",
      "    --shadow-1: 0 1px #fff;",
      "  }",
      "}",
      "",
      "",
    ].join("\n"),
  );
});

test("asking for dark by name applies Night with a dark colour-scheme and no fixed scales", () => {
  const night = section(':root[data-theme="dark"]', "}");
  expect(night).toContain("color-scheme: dark;");
  expect(night).toContain("--ink: #eeeeee;");
  expect(night).not.toContain("--space-1");
  expect(night).not.toContain("--font-");
});

test("text styles use their group's family, sized by a theme variable that keeps the lead", () => {
  expect(out).toContain(
    ".ca-text-big {\n  font: 600 var(--text-big-size, 40px)/calc(var(--text-big-size, 40px) + 4px) var(--font-sans);\n}\n",
  );
  expect(out).toContain(
    ".ca-text-tight {\n  font: 400 var(--text-tight-size, 12px)/calc(var(--text-tight-size, 12px) + 4px) var(--font-sans);\n  letter-spacing: -0.01em;\n}\n",
  );
  expect(out).toContain(
    ".ca-text-code {\n  font: 400 var(--text-code-size, 13px)/calc(var(--text-code-size, 13px) + 5px) var(--font-mono);\n}\n",
  );
});

test("every text style's family is a declared font family", () => {
  for (const group of tokens.type.groups)
    expect(Object.keys(tokens.type.families)).toContain(group.family);
});
