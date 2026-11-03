import { describe, expect, test } from "bun:test";
import { clampSplit, DEFAULT_SPLIT } from "./split.tsx";

describe("clampSplit", () => {
  test("with no width, a share is kept between 15% and 85%", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.15)).toBe(0.15);
    expect(clampSplit(0.85)).toBe(0.85);
    expect(clampSplit(0)).toBe(0.15);
    expect(clampSplit(-1)).toBe(0.15);
    expect(clampSplit(1)).toBe(0.85);
    expect(clampSplit(7)).toBe(0.85);
  });

  test("with a width, the source keeps 280px and the preview 320px", () => {
    // At 1000px: the source at least 0.28, the preview at least 0.32, so the line at most 0.68.
    expect(clampSplit(0.1, 1000)).toBeCloseTo(0.28);
    expect(clampSplit(0.9, 1000)).toBeCloseTo(0.68);
    expect(clampSplit(0.5, 1000)).toBe(0.5);
    // 280px of 1000 is the lowest the line can sit; 680px leaves the preview exactly 320.
    expect(clampSplit(0.1, 1000) * 1000).toBeCloseTo(280);
    expect((1 - clampSplit(0.9, 1000)) * 1000).toBeCloseTo(320);
  });

  test("on a wide screen the share bounds are the tighter ones", () => {
    // At 4000px the pixel minimums are 7% and 8%, looser than 15% and 85%.
    expect(clampSplit(0.01, 4000)).toBe(0.15);
    expect(clampSplit(0.99, 4000)).toBe(0.85);
    // At 2000px the preview's 320px (16%) binds before 85% does; the source's 14% does not.
    expect(clampSplit(0.99, 2000)).toBeCloseTo(0.84);
    expect(clampSplit(0.01, 2000)).toBe(0.15);
  });

  test("a width too narrow for both minimums, or none at all, falls back to the share bounds", () => {
    expect(clampSplit(0.01, 600)).toBe(0.15);
    expect(clampSplit(0.99, 500)).toBe(0.85);
    expect(clampSplit(0.01, 0)).toBe(0.15);
    expect(clampSplit(0.99, undefined)).toBe(0.85);
  });

  test("a share that is not a finite number is the default", () => {
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.NaN, 1000)).toBe(DEFAULT_SPLIT);
  });

  test("the default sits at 45%", () => {
    expect(DEFAULT_SPLIT).toBe(0.45);
  });
});
