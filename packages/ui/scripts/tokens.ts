// Turns design/tokens.json into src/styles/tokens.css: `bun run ui:tokens`.

import { join } from "node:path";

type Themed = string | Record<string, string>;
interface Token {
  name: string;
  value: Themed;
}
interface TextStyle {
  name: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
}
export interface Tokens {
  color: { themes: { id: string; name: string }[]; tokens: Token[] };
  type: {
    families: Record<string, string>;
    groups: { family: string; styles: TextStyle[] }[];
  };
  spacing: { tokens: Token[] };
  grid: { tokens: Token[] };
  radius: { tokens: Token[] };
  shadow: { tokens: Token[] };
}

/** A token's value in a theme; one given for a single theme holds in all of them. */
export function valueIn(token: Token, theme: string, first: string): string {
  if (typeof token.value === "string") return token.value;
  const value = token.value[theme] ?? token.value[first];
  if (value === undefined) throw new Error(`Token ${token.name} has no value for ${theme}`);
  return value;
}

const px = (value: string): number => {
  if (!/^\d+(\.\d+)?px$/.test(value)) throw new Error(`type sizes are in px, not ${value}`);
  return Number.parseFloat(value);
};

const block = (selector: string, lines: string[], indent = "") =>
  `${indent}${selector} {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}\n`;

export function tokensCss(tokens: Tokens): string {
  const [first, ...others] = tokens.color.themes.map((theme) => theme.id);
  if (first !== "light" || others.join() !== "dark") {
    throw new Error("tokens.css is written for exactly two themes: light, then dark");
  }
  const themed = [...tokens.color.tokens, ...tokens.shadow.tokens];
  const declare = (theme: string) =>
    themed.map((token) => `--${token.name}: ${valueIn(token, theme, first)};`);
  const fixed = [...tokens.spacing.tokens, ...tokens.grid.tokens, ...tokens.radius.tokens].map(
    (token) => `--${token.name}: ${valueIn(token, first, first)};`,
  );
  const families = Object.entries(tokens.type.families).map(
    ([name, stack]) => `--font-${name}: ${stack};`,
  );
  // A theme may resize a style through `--text-<name>-size`; the line height keeps its lead.
  const styles = tokens.type.groups.flatMap((group) =>
    group.styles.map((style) => {
      const size = `var(--text-${style.name}-size, ${style.fontSize})`;
      const lead = px(style.lineHeight) - px(style.fontSize);
      return block(`.ca-text-${style.name}`, [
        `font: ${style.fontWeight} ${size}/calc(${size} + ${lead}px) var(--font-${group.family});`,
        ...(style.letterSpacing ? [`letter-spacing: ${style.letterSpacing};`] : []),
      ]);
    }),
  );

  return [
    "/* Generated from design/tokens.json by scripts/tokens.ts. Do not edit. */\n",
    block(":root", ["color-scheme: light;", ...declare("light"), ...fixed, ...families]),
    "/* Night follows the system unless the page asks for a theme by name. */",
    `@media (prefers-color-scheme: dark) {\n${block(
      ':root:not([data-theme="light"])',
      ["color-scheme: dark;", ...declare("dark")],
      "  ",
    )}}\n`,
    block(':root[data-theme="dark"]', ["color-scheme: dark;", ...declare("dark")]),
    ...styles,
  ].join("\n");
}

/** `surface-raised` → `surfaceRaised`, `series-1` → `series1`: a Casa palette name. */
export const casaName = (token: string): string =>
  token.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The same tokens as data for the Casa compiler in `packages/core`, which builds the Day and
 * Night themes from them and may import nothing from this package.
 */
export function casaTokensTs(tokens: Tokens): string {
  const colours = tokens.color.tokens.map(
    (token) =>
      `  { name: ${JSON.stringify(casaName(token.name))}, token: ${JSON.stringify(token.name)}, light: ${JSON.stringify(valueIn(token, "light", "light"))}, dark: ${JSON.stringify(valueIn(token, "dark", "light"))} },`,
  );
  const shadows = tokens.shadow.tokens.map(
    (token) =>
      `  { name: ${JSON.stringify(token.name)}, light: ${JSON.stringify(valueIn(token, "light", "light"))}, dark: ${JSON.stringify(valueIn(token, "dark", "light"))} },`,
  );
  const families = Object.entries(tokens.type.families).map(
    ([name, stack]) => `  ${name}: ${JSON.stringify(stack)},`,
  );
  return [
    "// Generated from packages/ui/design/tokens.json by packages/ui/scripts/tokens.ts. Do not edit.",
    "",
    "export const COLORS = [",
    ...colours,
    "] as const;",
    "",
    "export const SHADOWS = [",
    ...shadows,
    "] as const;",
    "",
    "export const FAMILIES = {",
    ...families,
    "} as const;",
    "",
  ].join("\n");
}

export const TOKENS_JSON = join(import.meta.dir, "..", "design", "tokens.json");
export const TOKENS_CSS = join(import.meta.dir, "..", "src", "styles", "tokens.css");
export const CASA_TOKENS_TS = join(
  import.meta.dir,
  "..",
  "..",
  "core",
  "src",
  "casa",
  "tokens.gen.ts",
);

if (import.meta.main) {
  const tokens: Tokens = await Bun.file(TOKENS_JSON).json();
  await Bun.write(TOKENS_CSS, tokensCss(tokens));
  await Bun.write(CASA_TOKENS_TS, casaTokensTs(tokens));
  console.log(TOKENS_CSS);
  console.log(CASA_TOKENS_TS);
}
