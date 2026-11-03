// Which theme the page is drawn in: one by id, or `system`, which follows the device between
// the house's light and dark defaults. Remembered per browser. Day and Night are the built-in
// themes; a house may add its own, written in Casa, and each arrives as a CSS rule.

import type { Resolved } from "@casita/core/casa";

export interface ThemeInfo {
  id: string;
  name: string;
  extends?: string;
  css: string;
  dark: boolean;
  builtin: boolean;
  isLightDefault: boolean;
  isDarkDefault: boolean;
  breakpoints: { tablet: number; desktop: number };
  /** Every path the theme defines, as the compiler resolved it. */
  values: Record<string, Resolved>;
  /** Its source; an admin gets it, the built-ins have none. */
  source?: string;
}

/** `system`, or a theme id. */
export type Theme = string;
const KEY = "casita.theme";
const STYLE_ID = "casa-themes";
/** What the choice was called before themes had ids. */
const LEGACY: Record<string, string> = { light: "day", dark: "night" };

export function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (!saved) return "system";
    return LEGACY[saved] ?? saved;
  } catch {
    // Storage can be blocked; the system's choice is a fine default.
    return "system";
  }
}

const prefersDark = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** The theme a choice lands on: `system` follows the device between the two defaults. */
export function resolveTheme(theme: Theme, themes: readonly ThemeInfo[]): ThemeInfo | undefined {
  if (theme !== "system") {
    return themes.find((candidate) => candidate.id === theme);
  }
  return prefersDark()
    ? (themes.find((t) => t.isDarkDefault) ?? themes.find((t) => t.dark))
    : (themes.find((t) => t.isLightDefault) ?? themes.find((t) => !t.dark));
}

/**
 * Applies a choice. Before the themes have loaded only the built-ins exist, and the design
 * tokens' own light and dark rules draw them; once loaded, every theme is a rule of its own
 * and the page is marked with the theme's id.
 */
/** The nonce the server's content security policy gave this page for the styles it makes. */
export const cspNonce = (): string =>
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";

/** A `<style>` the page may fill: it carries the response's nonce, so the policy allows it. */
export function ownStyle(id: string): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    style.setAttribute("nonce", cspNonce());
    document.head.appendChild(style);
  }
  return style;
}

export function applyTheme(theme: Theme, themes: readonly ThemeInfo[] = []): void {
  const root = document.documentElement;
  if (themes.length) {
    const style = ownStyle(STYLE_ID);
    const css = themes.map((t) => t.css).join("\n");
    if (style.textContent !== css) style.textContent = css;
    const chosen = resolveTheme(theme, themes) ?? resolveTheme("system", themes);
    if (chosen) root.dataset.theme = chosen.id;
    else delete root.dataset.theme;
  } else if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme === "night" ? "dark" : theme === "day" ? "light" : theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered, then.
  }
}

/** Whether a theme is `name` or extends it, however far up. */
export function descendsFrom(
  theme: ThemeInfo | undefined,
  name: string,
  themes: readonly ThemeInfo[],
): boolean {
  let current = theme;
  for (let hops = 0; current && hops < 16; hops++) {
    if (current.name === name) return true;
    current = themes.find((t) => t.name === current?.extends);
  }
  return false;
}

/** Whether the choice draws dark right now. */
export const isDark = (theme: Theme, themes: readonly ThemeInfo[] = []): boolean => {
  const chosen = resolveTheme(theme, themes);
  if (chosen) return chosen.dark;
  return theme === "night" || theme === "dark" || (theme === "system" && prefersDark());
};
