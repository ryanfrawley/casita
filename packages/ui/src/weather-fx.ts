// The weather as a few faint marks over a card: what falls, how fast, where it leans, and
// where a mark goes once it has left. Pure, so the picture can be tested; WeatherEffect draws it.

import type { CloudSpec } from "./cloud-fx.ts";
import type { WeatherCondition } from "./icon.tsx";

/** What a mark is drawn as. */
export type Mark =
  | "streak" // a short line falling: rain
  | "flake" // a soft dot drifting down and side to side: snow
  | "stone" // a hard dot falling fast, bouncing off the bottom: hail
  | "star" // a still point that twinkles: a clear night
  | "mote" // a speck rising slowly in the light: a clear day
  | "gust"; // a long line blowing across, faint at each end: wind

export interface Layer {
  mark: Mark;
  /** Marks per 10 000 px² at the usual intensity. */
  density: number;
  /** The fewest marks a box holds, however small: a tile still shows its weather. */
  least: number;
  /** Speed along the mark's way, px/s, least to most. Nothing for a mark that stays. */
  speed: [number, number];
  /** A line's length or a dot's radius, px. */
  size: [number, number];
  /** A line's width, px. */
  thick: [number, number];
  /** The share of marks that fall in front of the words rather than behind them. */
  near: number;
  /** Sideways drift as a share of the fall: 0 is straight down, 0.3 leans with a wind. */
  lean: number;
  /** How dark, 0 to 1, before the canvas's own opacity. */
  alpha: [number, number];
  /** A wander across the way, px/s at its widest. */
  sway: number;
}

export interface Scene {
  layers: Layer[];
  /** Cloud with body: along the top, thinning downward, or filling the box as fog does. */
  clouds?: CloudSpec;
  /** Lightning now and then. */
  flashes?: boolean;
}

export interface Drop {
  layer: Layer;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  thick: number;
  alpha: number;
  /** Where in its wander or twinkle this mark starts, radians. */
  phase: number;
  /** In front of the words, not behind them. */
  near: boolean;
  /** A stone that has hit the bottom once goes on down past it. */
  bounced: boolean;
}

/** What pulls a stone down, px/s², and how much of its fall it keeps when it strikes. */
export const GRAVITY = 700;
export const BOUNCE = 0.42;

type Range = [number, number];
const between = (rand: () => number, [lo, hi]: Range) => lo + rand() * (hi - lo);

const layer = (
  mark: Mark,
  density: number,
  part: Partial<Omit<Layer, "mark" | "density">>,
): Layer => ({
  mark,
  density,
  least: 1,
  speed: [0, 0],
  size: [1, 1],
  thick: [1, 1],
  lean: 0,
  alpha: [0.4, 0.8],
  sway: 0,
  near: 0.4,
  ...part,
});

const RAIN = layer("streak", 1.1, {
  least: 4,
  speed: [240, 360],
  size: [9, 15],
  lean: 0.18,
  alpha: [0.35, 0.7],
});
const DRIZZLE = layer("streak", 0.8, {
  least: 3,
  speed: [110, 170],
  size: [4, 7],
  lean: 0.08,
  alpha: [0.25, 0.5],
});
const POURING = layer("streak", 2.2, {
  least: 6,
  speed: [400, 540],
  size: [14, 24],
  lean: 0.3,
  alpha: [0.4, 0.75],
});
const STORM_RAIN = layer("streak", 1.6, {
  least: 5,
  speed: [380, 520],
  size: [12, 20],
  lean: 0.28,
  alpha: [0.4, 0.75],
});
const SNOW = layer("flake", 0.9, {
  least: 4,
  speed: [26, 50],
  size: [1.2, 2.4],
  lean: 0.05,
  alpha: [0.5, 0.9],
  sway: 10,
});
const HAIL = layer("stone", 0.5, {
  least: 2,
  speed: [300, 420],
  size: [1.4, 2],
  lean: 0.12,
  alpha: [0.6, 0.9],
});
const HAIL_RAIN = layer("streak", 0.5, {
  least: 2,
  speed: [260, 360],
  size: [6, 10],
  lean: 0.12,
  alpha: [0.25, 0.45],
});
/** Fog fills the box: loose, soft, slow sheets, in front of the words and behind them. */
const FOG: CloudSpec = {
  cover: 0.3,
  soft: 0.3,
  alpha: 0.7,
  layers: 3,
  speed: 5,
  reach: 1,
  fill: true,
};
/** Haze is a thinner fog. */
const HAZE: CloudSpec = { ...FOG, cover: 0.4, alpha: 0.45, speed: 3 };
const MOTES = layer("mote", 0.14, {
  least: 3,
  speed: [5, 11],
  size: [0.6, 1.1],
  lean: 0.3,
  alpha: [0.3, 0.7],
  sway: 4,
});
const STARS = layer("star", 0.22, {
  least: 5,
  size: [0.5, 1.2],
  alpha: [0.4, 0.9],
  near: 0,
});
const FEW_STARS = { ...STARS, density: 0.12 };
/** Broken cloud: gaps of sky between, drifting at a fair pace, not far down the box. */
const SCATTERED: CloudSpec = {
  cover: 0.56,
  soft: 0.14,
  alpha: 0.55,
  layers: 2,
  speed: 10,
  reach: 0.72,
};
/** Most of the sky, thicker and slower, reaching lower. */
const CLOUDY: CloudSpec = {
  cover: 0.44,
  soft: 0.15,
  alpha: 0.62,
  layers: 3,
  speed: 8,
  reach: 0.82,
};
/** A ceiling: nearly unbroken, heavy and slow, down most of the box. */
const OVERCAST: CloudSpec = {
  cover: 0.3,
  soft: 0.17,
  alpha: 0.7,
  layers: 3,
  speed: 6,
  reach: 0.92,
};
const WIND = layer("gust", 0.08, {
  least: 2,
  speed: [160, 260],
  size: [36, 80],
  alpha: [0.25, 0.5],
  sway: 6,
});

const NONE: Scene = { layers: [] };
const SCENES: Record<WeatherCondition, Scene> = {
  clear: { layers: [MOTES] },
  "clear-night": { layers: [STARS] },
  "partly-cloudy": { layers: [], clouds: SCATTERED },
  "partly-cloudy-night": { layers: [FEW_STARS], clouds: SCATTERED },
  cloudy: { layers: [], clouds: CLOUDY },
  overcast: { layers: [], clouds: OVERCAST },
  fog: { layers: [], clouds: FOG },
  haze: { layers: [], clouds: HAZE },
  drizzle: { layers: [DRIZZLE] },
  rain: { layers: [RAIN] },
  pouring: { layers: [POURING] },
  snow: { layers: [SNOW] },
  hail: { layers: [HAIL_RAIN, HAIL] },
  thunderstorm: { layers: [STORM_RAIN], flashes: true },
  windy: { layers: [WIND] },
  tornado: { layers: [WIND] },
};

/** The scene for a condition; one the table does not know draws nothing. */
export const sceneOf = (condition: string): Scene =>
  Object.hasOwn(SCENES, condition) ? SCENES[condition as WeatherCondition] : NONE;

const WET = new Set<string>(["drizzle", "rain", "pouring", "thunderstorm"]);

/** What colours a condition's weather: rain borrows the sky accent, everything else is ink. */
export const tintOf = (condition: string): "ink" | "sky" => (WET.has(condition) ? "sky" : "ink");

/** How many of a layer's marks a box of `width` by `height` holds. */
export const countOf = (layer: Layer, width: number, height: number, intensity = 1): number =>
  Math.max(layer.least, Math.round((layer.density * width * height * intensity) / 10_000));

const falls = (mark: Mark) => mark === "streak" || mark === "flake" || mark === "stone";

/**
 * A new mark of `layer`. One made `anywhere` can be anywhere in the box, for the first frame;
 * otherwise it waits just outside the edge it comes in by.
 */
export function spawn(
  layer: Layer,
  width: number,
  height: number,
  rand: () => number,
  anywhere: boolean,
): Drop {
  const speed = between(rand, layer.speed);
  const size = between(rand, layer.size);
  const drop: Drop = {
    layer,
    x: rand() * width,
    y: rand() * height,
    vx: 0,
    vy: 0,
    size,
    thick: between(rand, layer.thick),
    alpha: between(rand, layer.alpha),
    phase: rand() * Math.PI * 2,
    near: rand() < layer.near,
    bounced: false,
  };
  if (falls(layer.mark)) {
    drop.vy = speed;
    drop.vx = speed * layer.lean;
    if (!anywhere) drop.y = -size - rand() * size * 4;
  } else if (layer.mark === "gust") {
    drop.vx = speed;
    if (!anywhere) drop.x = -size;
  } else if (layer.mark === "mote") {
    drop.vy = -speed;
    drop.vx = (rand() - 0.5) * speed * layer.lean;
    if (!anywhere) drop.y = height + size;
  } else if (layer.mark === "star") {
    drop.y = rand() * height * 0.7;
  }
  return drop;
}

/** Every mark a scene puts in a box at first, each anywhere in it. */
export function populate(
  scene: Scene,
  width: number,
  height: number,
  intensity: number,
  rand: () => number,
): Drop[] {
  const drops: Drop[] = [];
  for (const layer of scene.layers) {
    const count = countOf(layer, width, height, intensity);
    for (let i = 0; i < count; i++) drops.push(spawn(layer, width, height, rand, true));
  }
  return drops;
}

/**
 * Moves a mark on by `dt` seconds at `time` ms. One that has left the box comes back in by
 * the edge it came from, somewhere new. A stone gathers speed as it falls and strikes the
 * bottom once, bouncing up with a little of its fall and a nudge to the side, before it
 * goes on down past it.
 */
export function advance(
  drop: Drop,
  dt: number,
  time: number,
  width: number,
  height: number,
  rand: () => number,
): void {
  const { layer } = drop;
  const wander = Math.sin(time / 900 + drop.phase) * layer.sway;
  if (layer.mark === "gust") {
    drop.x += drop.vx * dt;
    drop.y += wander * dt;
  } else if (layer.mark === "stone") {
    drop.vy += GRAVITY * dt;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;
    const floor = height - drop.size;
    if (!drop.bounced && drop.vy > 0 && drop.y >= floor) {
      drop.bounced = true;
      drop.y = floor - (drop.y - floor) * BOUNCE;
      drop.vy = -drop.vy * BOUNCE;
      drop.vx += (rand() - 0.5) * 80;
    }
  } else {
    drop.x += (drop.vx + wander) * dt;
    drop.y += drop.vy * dt;
  }
  const span = width + 2 * drop.size;
  if (drop.x > width + drop.size) drop.x -= span;
  else if (drop.x < -drop.size) drop.x += span;
  if (layer.mark === "stone") {
    if (drop.y > height + drop.size) Object.assign(drop, spawn(layer, width, height, rand, false));
  } else if (drop.vy > 0 && drop.y > height + drop.size) {
    const fresh = spawn(layer, width, height, rand, false);
    Object.assign(drop, fresh);
  } else if (drop.vy < 0 && drop.y < -drop.size) {
    const fresh = spawn(layer, width, height, rand, false);
    Object.assign(drop, fresh);
  }
}

/** A star's or a mote's brightness at `time`, 0 to 1, each on its own beat. */
export const twinkle = (time: number, phase: number): number =>
  0.3 + 0.7 * (0.5 + 0.5 * Math.sin(time / 650 + phase));

/** A gust's brightness along its way: faint as it comes in and goes out. */
export const gustFade = (drop: Drop, width: number): number => {
  const progress = (drop.x + drop.size) / (width + 2 * drop.size);
  return Math.sin(Math.PI * Math.max(0, Math.min(1, progress)));
};

/** How long until the next flash of lightning, ms. */
export const nextFlash = (rand: () => number): number => 4000 + rand() * 9000;

/** A flash's brightness `since` ms after it struck, 0 to 1: a flicker, then a short glow. */
export function flashAlpha(since: number): number {
  if (since < 0) return 0;
  if (since < 90) return 1;
  if (since < 140) return 0.35;
  if (since < 220) return 0.7;
  if (since < 420) return (1 - (since - 220) / 200) * 0.4;
  return 0;
}
