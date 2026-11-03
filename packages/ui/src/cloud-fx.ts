// Cloud with body: sheets of soft noise lit from above, thick at the top of the box and
// thinning to nothing below (or filling it, as fog does), drifting at their own paces, the
// far ones behind the words and the near ones in front. Pure, so a sheet can be tested;
// WeatherEffect draws it.

export interface CloudSpec {
  /** Where the noise turns to cloud: lower is more cloud. */
  cover: number;
  /** How soft the cloud's edge is, in noise units. */
  soft: number;
  /** How dark the thickest cloud is, 0 to 1, before the canvas's own opacity. */
  alpha: number;
  /** Sheets drifting at their own paces, the farthest first. */
  layers: number;
  /** The nearest sheet's drift, px/s; the farther ones go slower. */
  speed: number;
  /** How far down the box the cloud reaches, as a share of its height, before it has thinned to nothing. */
  reach: number;
  /** The whole box, top to bottom, as fog is; `reach` is then not used. */
  fill?: boolean;
}

export type RGB = [number, number, number];

/** How a sheet is drawn: a value from 0 to 1 at each cell, `width` across and `height` down. */
export interface CloudField {
  width: number;
  height: number;
  values: Float32Array;
}

const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
/** 0 below `from`, 1 past `to`, eased between. */
export const step = (from: number, to: number, v: number) =>
  from === to ? (v < from ? 0 : 1) : smooth(clamp((v - from) / (to - from)));

/**
 * A field of billowing noise that tiles across: several octaves of smooth lattice noise, the
 * coarse ones strongest, stretched so its values run the whole of 0 to 1.
 */
export function cloudField(
  width: number,
  height: number,
  rand: () => number,
  octaves = 4,
): CloudField {
  const values = new Float32Array(width * height);
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const cellsX = 3 * 2 ** octave;
    // A cloud is wider than it is tall, about three to one, whatever the field's shape.
    const cellsY = Math.max(2, Math.round((cellsX * height * 3) / width)) + 1;
    const lattice = new Float32Array(cellsX * cellsY);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const amplitude = 0.5 ** octave;
    total += amplitude;
    const at = (cx: number, cy: number) =>
      lattice[clamp(cy, 0, cellsY - 1) * cellsX + (((cx % cellsX) + cellsX) % cellsX)] ?? 0;
    for (let y = 0; y < height; y++) {
      const fy = (y / height) * (cellsY - 1);
      const cy = Math.floor(fy);
      const ty = smooth(fy - cy);
      for (let x = 0; x < width; x++) {
        const fx = (x / width) * cellsX;
        const cx = Math.floor(fx);
        const tx = smooth(fx - cx);
        const top = at(cx, cy) + (at(cx + 1, cy) - at(cx, cy)) * tx;
        const bottom = at(cx, cy + 1) + (at(cx + 1, cy + 1) - at(cx, cy + 1)) * tx;
        const k = y * width + x;
        values[k] = (values[k] ?? 0) + (top + (bottom - top) * ty) * amplitude;
      }
    }
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < values.length; i++)
    values[i] = ((values[i] ?? 0) / total - lo / total) / (span / total);
  return { width, height, values };
}

/**
 * A field as pixels: where the noise rises past the cover it is cloud, its colour the light
 * where the cloud faces up and the shade where it faces down, and thinner the lower it is
 * in the box until, at `reach`, there is none. RGBA, row by row, for an ImageData.
 */
export function cloudPixels(
  field: CloudField,
  light: RGB,
  shade: RGB,
  spec: CloudSpec,
  lift = 2,
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, values } = field;
  const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y++) {
    const fade = spec.fill ? 1 : 1 - step(spec.reach * 0.35, spec.reach, y / height);
    const above = Math.max(0, y - lift);
    for (let x = 0; x < width; x++) {
      const n = values[y * width + x] ?? 0;
      const up = values[above * width + x] ?? 0;
      const body = step(spec.cover - spec.soft, spec.cover + spec.soft, n);
      const lit = clamp(0.5 + (n - up) * 6);
      const i = (y * width + x) * 4;
      pixels[i] = shade[0] + (light[0] - shade[0]) * lit;
      pixels[i + 1] = shade[1] + (light[1] - shade[1]) * lit;
      pixels[i + 2] = shade[2] + (light[2] - shade[2]) * lit;
      pixels[i + 3] = body * fade * spec.alpha * 255;
    }
  }
  return pixels;
}

/**
 * A sheet's share of the whole: the farthest is faintest and slowest, the nearest full. The
 * nearer half of the sheets (the odd one out going to the back) are in front of the words.
 */
export function sheetOf(
  index: number,
  spec: CloudSpec,
): { alpha: number; speed: number; scale: number; near: boolean } {
  const depth = spec.layers <= 1 ? 1 : index / (spec.layers - 1);
  return {
    alpha: 0.45 + 0.55 * depth,
    speed: spec.speed * (0.35 + 0.65 * depth),
    scale: 1.1 + 0.7 * depth,
    near: index >= Math.ceil(spec.layers / 2),
  };
}
