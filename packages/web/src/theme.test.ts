import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { descendsFrom, isDark, resolveTheme, type ThemeInfo } from "./theme.ts";

// resolveTheme reads the device's preference through matchMedia; a stub stands in for it.
const scope = globalThis as unknown as Record<string, unknown>;
let savedMatchMedia: unknown;
let prefersDark = false;
beforeAll(() => {
  savedMatchMedia = scope.matchMedia;
  scope.matchMedia = (query: string) => ({ matches: query.includes("dark") && prefersDark });
});
afterAll(() => {
  scope.matchMedia = savedMatchMedia;
});

const theme = (id: string, extra: Partial<ThemeInfo> = {}): ThemeInfo => ({
  id,
  name: id,
  css: "",
  dark: false,
  builtin: false,
  isLightDefault: false,
  isDarkDefault: false,
  breakpoints: { tablet: 860, desktop: 1100 },
  values: {},
  ...extra,
});

const day = theme("day", { builtin: true });
const night = theme("night", { builtin: true, dark: true });
const dawn = theme("dawn", { isLightDefault: true });
const dusk = theme("dusk", { dark: true, isDarkDefault: true });

const withDark = <T>(dark: boolean, run: () => T): T => {
  prefersDark = dark;
  try {
    return run();
  } finally {
    prefersDark = false;
  }
};

describe("resolveTheme", () => {
  test("a theme by id, whatever the device prefers", () => {
    const themes = [day, night, dusk];
    expect(resolveTheme("night", themes)).toBe(night);
    expect(withDark(true, () => resolveTheme("day", themes))).toBe(day);
  });

  test("an id no theme has is undefined", () => {
    expect(resolveTheme("nope", [day, night])).toBeUndefined();
    expect(resolveTheme("day", [])).toBeUndefined();
  });

  test("system on a dark device picks the dark default", () => {
    expect(withDark(true, () => resolveTheme("system", [day, night, dawn, dusk]))).toBe(dusk);
  });

  test("system on a light device picks the light default", () => {
    expect(withDark(false, () => resolveTheme("system", [day, night, dawn, dusk]))).toBe(dawn);
  });

  test("with no default flagged, system falls back to the first theme of the right shade", () => {
    const themes = [night, day, theme("ink", { dark: true }), theme("paper")];
    expect(withDark(true, () => resolveTheme("system", themes))).toBe(night);
    expect(withDark(false, () => resolveTheme("system", themes))).toBe(day);
  });

  test("system with no theme of the shade the device wants is undefined", () => {
    expect(withDark(true, () => resolveTheme("system", [day]))).toBeUndefined();
    expect(withDark(false, () => resolveTheme("system", [night]))).toBeUndefined();
    expect(resolveTheme("system", [])).toBeUndefined();
  });

  test("system with no matchMedia at all reads as light", () => {
    const stub = scope.matchMedia;
    scope.matchMedia = undefined;
    try {
      expect(resolveTheme("system", [night, dawn])).toBe(dawn);
    } finally {
      scope.matchMedia = stub;
    }
  });
});

describe("isDark", () => {
  test("a known theme answers for itself", () => {
    expect(isDark("night", [day, night])).toBe(true);
    expect(isDark("day", [day, night])).toBe(false);
    expect(withDark(true, () => isDark("system", [day, dusk]))).toBe(true);
  });

  test("before the themes load, the built-in names and the device decide", () => {
    expect(isDark("night")).toBe(true);
    expect(isDark("dark")).toBe(true);
    expect(isDark("day")).toBe(false);
    expect(withDark(true, () => isDark("system"))).toBe(true);
    expect(withDark(false, () => isDark("system"))).toBe(false);
  });
});

describe("descendsFrom", () => {
  const october = theme("october", {
    name: "October",
    extends: "Night",
    builtin: true,
    dark: true,
  });
  const spookier = theme("spookier", { name: "Spookier", extends: "October", dark: true });
  const all = [day, night, october, spookier];

  test("a theme is its own ancestor, and follows extends up the chain", () => {
    expect(descendsFrom(october, "October", all)).toBe(true);
    expect(descendsFrom(spookier, "October", all)).toBe(true);
    expect(descendsFrom(spookier, "Night", all)).toBe(false);
    expect(descendsFrom(night, "October", all)).toBe(false);
    expect(descendsFrom(undefined, "October", all)).toBe(false);
  });

  test("a parent that is not listed, or a cycle, ends the walk", () => {
    expect(descendsFrom(spookier, "October", [spookier])).toBe(false);
    const a = theme("a", { name: "A", extends: "B" });
    const b = theme("b", { name: "B", extends: "A" });
    expect(descendsFrom(a, "October", [a, b])).toBe(false);
  });
});
