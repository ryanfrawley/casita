import { describe, expect, test } from "bun:test";
import type { CNode } from "@casita/core/casa";
import { gridColumnsOf, onAccentOf } from "./builtins.tsx";

/** A Grid with `count` Text children, as the compiler emits it. */
const grid = (count: number): CNode => ({
  t: "node",
  type: "Grid",
  props: {},
  children: Array.from({ length: count }, (_, i) => ({
    t: "node" as const,
    type: "Text",
    props: { value: { e: ["lit", String(i)] } },
    children: [],
    at: [1, 1] as [number, number],
  })),
  at: [1, 1],
});

describe("gridColumnsOf", () => {
  test("a numeric columns is rounded and clamped to 1 to 3, whatever the children", () => {
    expect(gridColumnsOf(grid(0), 2)).toBe(2);
    expect(gridColumnsOf(grid(5), 1)).toBe(1);
    expect(gridColumnsOf(grid(1), 3)).toBe(3);
    expect(gridColumnsOf(grid(1), 9)).toBe(3);
    expect(gridColumnsOf(grid(3), 0)).toBe(1);
    expect(gridColumnsOf(grid(3), -2)).toBe(1);
    expect(gridColumnsOf(grid(1), 2.6)).toBe(3);
    expect(gridColumnsOf(grid(3), 1.4)).toBe(1);
    expect(gridColumnsOf(grid(1), 2.5)).toBe(3);
  });

  test("a columns that is not a finite number counts the children instead", () => {
    // `screen.width / 0`, or a sensor that is Unavailable: never `repeat(NaN, …)`.
    expect(gridColumnsOf(grid(2), Number.NaN)).toBe(2);
    expect(gridColumnsOf(grid(2), Number.POSITIVE_INFINITY)).toBe(2);
  });

  test("left out, one column per child, at least one and at most three", () => {
    expect(gridColumnsOf(grid(0), undefined)).toBe(1);
    expect(gridColumnsOf(grid(1), undefined)).toBe(1);
    expect(gridColumnsOf(grid(2), undefined)).toBe(2);
    expect(gridColumnsOf(grid(3), undefined)).toBe(3);
    expect(gridColumnsOf(grid(7), undefined)).toBe(3);
  });

  test("a columns that is not a number counts the children instead", () => {
    // An unavailable or null value from a computed `columns` falls back like a missing one.
    expect(gridColumnsOf(grid(2), null)).toBe(2);
    expect(gridColumnsOf(grid(2), "3")).toBe(2);
    expect(gridColumnsOf(grid(0), null)).toBe(1);
  });
});

describe("onAccentOf", () => {
  test("an accent's ink is its on-colour; any other colour takes the text role's", () => {
    expect(onAccentOf("accents.sky")).toBe("accents.onSky");
    expect(onAccentOf("accents.lamp")).toBe("accents.onLamp");
    expect(onAccentOf("accents.ember")).toBe("accents.onEmber");
    expect(onAccentOf("palette.warn")).toBe("text.onAccent");
  });
});
