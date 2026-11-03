import { describe, expect, test } from "bun:test";
import {
  type CloudField,
  type CloudSpec,
  cloudField,
  cloudPixels,
  type RGB,
  sheetOf,
  step,
} from "./cloud-fx.ts";

/** A seeded source of chance (a small LCG), so a field can be reproduced. */
const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};
const half = () => 0.5;

const spec = (overrides: Partial<CloudSpec> = {}): CloudSpec => ({
  cover: 0,
  soft: 0.1,
  alpha: 0.6,
  layers: 3,
  speed: 10,
  reach: 0.5,
  ...overrides,
});

/** A field one column wide, each row its own value. */
const rows = (values: number[]): CloudField => ({
  width: 1,
  height: values.length,
  values: Float32Array.from(values),
});
const flat = (value: number, width: number, height: number): CloudField => ({
  width,
  height,
  values: new Float32Array(width * height).fill(value),
});

const alphaAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) =>
  pixels[(y * width + x) * 4 + 3] ?? Number.NaN;
const rgbAt = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => {
  const i = (y * width + x) * 4;
  return [pixels[i] ?? Number.NaN, pixels[i + 1] ?? Number.NaN, pixels[i + 2] ?? Number.NaN];
};

describe("step", () => {
  test("is 0 below from and 1 past to", () => {
    expect(step(0.2, 0.6, -1)).toBe(0);
    expect(step(0.2, 0.6, 0.2)).toBe(0);
    expect(step(0.2, 0.6, 0.6)).toBe(1);
    expect(step(0.2, 0.6, 5)).toBe(1);
  });

  test("eases between, rising all the way, half way at the midpoint", () => {
    expect(step(0.2, 0.6, 0.4)).toBeCloseTo(0.5, 10);
    let last = 0;
    for (let v = 0.2; v <= 0.6; v += 0.01) {
      const now = step(0.2, 0.6, v);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    // Eased, not linear: slow off the start.
    expect(step(0, 1, 0.1)).toBeLessThan(0.1);
  });

  test("with from and to the same, it is a hard edge at that point", () => {
    expect(step(0.5, 0.5, 0.49)).toBe(0);
    expect(step(0.5, 0.5, 0.5)).toBe(1);
    expect(step(0.5, 0.5, 0.51)).toBe(1);
  });
});

describe("cloudField", () => {
  test("is width by height", () => {
    const field = cloudField(40, 12, seeded(1));
    expect(field.width).toBe(40);
    expect(field.height).toBe(12);
    expect(field.values.length).toBe(40 * 12);
  });

  test("is stretched to run the whole of 0 to 1, however many octaves", () => {
    for (const octaves of [1, 4, 7]) {
      const { values } = cloudField(64, 24, seeded(7), octaves);
      expect(Math.min(...values)).toBeCloseTo(0, 5);
      expect(Math.max(...values)).toBeCloseTo(1, 5);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(-1e-6);
        expect(v).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  test("the same chance draws the same field, and other chance another", () => {
    expect(cloudField(32, 16, seeded(42)).values).toEqual(cloudField(32, 16, seeded(42)).values);
    expect(cloudField(32, 16, seeded(42)).values).not.toEqual(
      cloudField(32, 16, seeded(43)).values,
    );
  });

  test("tiles across: the right edge runs on into the left as smoothly as any step within", () => {
    const width = 256;
    const height = 16;
    const { values } = cloudField(width, height, seeded(3));
    for (let y = 0; y < height; y++) {
      const at = (x: number) => values[y * width + x] ?? Number.NaN;
      let widest = 0;
      for (let x = 1; x < width; x++) widest = Math.max(widest, Math.abs(at(x) - at(x - 1)));
      expect(Math.abs(at(0) - at(width - 1))).toBeLessThanOrEqual(widest + 1e-6);
    }
  });

  test("a chance that never changes gives a flat field, not NaN", () => {
    const { values } = cloudField(20, 10, half);
    const first = values[0] ?? Number.NaN;
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeCloseTo(first, 6);
    }
  });
});

describe("cloudPixels", () => {
  const light: RGB = [200, 200, 200];
  const shade: RGB = [100, 50, 0];

  test("is four bytes a cell", () => {
    expect(cloudPixels(flat(1, 7, 5), light, shade, spec()).length).toBe(7 * 5 * 4);
  });

  test("thick cloud at the top is the spec's alpha, thinning to nothing at reach", () => {
    const height = 100;
    const pixels = cloudPixels(flat(1, 2, height), light, shade, spec({ alpha: 0.6, reach: 0.5 }));
    expect(alphaAt(pixels, 2, 0, 0)).toBe(153);
    // Full down to a third of the reach, thinning after, gone from reach on.
    for (let y = 0; y <= 17; y++) expect(alphaAt(pixels, 2, 1, y)).toBe(153);
    const middle = alphaAt(pixels, 2, 0, 35);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(153);
    for (let y = 50; y < height; y++) expect(alphaAt(pixels, 2, 0, y)).toBe(0);
  });

  test("fog fills the whole box, the bottom row as thick as the top", () => {
    const height = 20;
    const pixels = cloudPixels(flat(1, 1, height), light, shade, spec({ fill: true, reach: 0.1 }));
    expect(alphaAt(pixels, 1, 0, 0)).toBe(153);
    expect(alphaAt(pixels, 1, 0, height - 1)).toBe(153);
  });

  test("noise that never rises past the cover is no cloud at all", () => {
    const pixels = cloudPixels(flat(0, 4, 6), light, shade, spec({ cover: 1, fill: true }));
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(0);
  });

  test("cloud level with what is above it is half lit: the midpoint of light and shade", () => {
    const pixels = cloudPixels(flat(0.7, 3, 6), light, shade, spec());
    expect(rgbAt(pixels, 3, 1, 4)).toEqual([150, 125, 100]);
    // The top rows have nothing above, so they are measured against the top row itself.
    expect(rgbAt(pixels, 3, 0, 0)).toEqual([150, 125, 100]);
  });

  test("cloud rising above what is over it faces up and takes the light", () => {
    const pixels = cloudPixels(rows([0, 0, 0.5, 0.5]), light, shade, spec(), 2);
    expect(rgbAt(pixels, 1, 0, 2)).toEqual([...light]);
  });

  test("cloud falling below what is over it faces down and takes the shade", () => {
    const pixels = cloudPixels(rows([0.5, 0.5, 0, 0]), light, shade, spec(), 2);
    expect(rgbAt(pixels, 1, 0, 2)).toEqual([...shade]);
  });

  test("a small rise leans toward the light without reaching it", () => {
    const pixels = cloudPixels(rows([0.5, 0.5, 0.52]), light, shade, spec(), 2);
    const [r, g, b] = rgbAt(pixels, 1, 0, 2);
    expect(r).toBeGreaterThan(150);
    expect(r).toBeLessThan(200);
    expect(g).toBeGreaterThan(125);
    expect(b).toBeGreaterThan(100);
  });
});

describe("sheetOf", () => {
  test("a single sheet is the whole cloud, full, and as the odd one out it goes to the back", () => {
    expect(sheetOf(0, spec({ layers: 1, speed: 12 }))).toEqual({
      alpha: 1,
      speed: 12,
      scale: 1.8,
      near: false,
    });
  });

  test("the farthest of three is faintest, slowest and smallest, the nearest full", () => {
    const s = spec({ layers: 3, speed: 20 });
    const [far, middle, near] = [0, 1, 2].map((i) => sheetOf(i, s));
    if (!far || !middle || !near) throw new Error("no sheet");
    expect(far.alpha).toBeCloseTo(0.45);
    expect(far.speed).toBeCloseTo(20 * 0.35);
    expect(far.scale).toBeCloseTo(1.1);
    expect(near.alpha).toBeCloseTo(1);
    expect(near.speed).toBeCloseTo(20);
    expect(near.scale).toBeCloseTo(1.8);
    for (const key of ["alpha", "speed", "scale"] as const) {
      expect(middle[key]).toBeGreaterThan(far[key]);
      expect(middle[key]).toBeLessThan(near[key]);
    }
  });

  test("the nearer half goes in front of the words, the odd one out to the back", () => {
    const near = (layers: number) =>
      Array.from({ length: layers }, (_, i) => sheetOf(i, spec({ layers })).near);
    expect(near(2)).toEqual([false, true]);
    expect(near(3)).toEqual([false, false, true]);
    expect(near(4)).toEqual([false, false, true, true]);
  });
});
