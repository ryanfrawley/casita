import { describe, expect, test } from "bun:test";
import { WEATHER_ICON } from "./icon.tsx";
import {
  advance,
  BOUNCE,
  countOf,
  flashAlpha,
  GRAVITY,
  gustFade,
  type Layer,
  nextFlash,
  populate,
  sceneOf,
  spawn,
  tintOf,
  twinkle,
} from "./weather-fx.ts";

/** A source of chance that walks a fixed sequence, so a picture can be reproduced. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};
const half = () => 0.5;

const only = (condition: string): Layer => {
  const [layer] = sceneOf(condition).layers;
  if (!layer) throw new Error(`${condition} draws nothing`);
  return layer;
};

describe("sceneOf", () => {
  test("every condition the icons know has a scene; an unknown one draws nothing", () => {
    for (const condition of Object.keys(WEATHER_ICON)) {
      const scene = sceneOf(condition);
      expect(scene.layers.length > 0 || scene.clouds !== undefined).toBe(true);
    }
    expect(sceneOf("meteor shower")).toEqual({ layers: [] });
    expect(sceneOf("constructor")).toEqual({ layers: [] });
  });

  test("what falls and what drifts", () => {
    expect(only("rain").mark).toBe("streak");
    expect(only("snow").mark).toBe("flake");
    expect(only("clear-night").mark).toBe("star");
    expect(only("clear").mark).toBe("mote");
    expect(only("windy").mark).toBe("gust");
    expect(only("tornado")).toBe(only("windy"));
    expect(sceneOf("hail").layers.map((l) => l.mark)).toEqual(["streak", "stone"]);
    expect(sceneOf("partly-cloudy-night").layers.map((l) => l.mark)).toEqual(["star"]);
  });

  test("cloud has body: more of it, thicker and lower, the greyer the sky", () => {
    const [scattered, cloudy, overcast] = ["partly-cloudy", "cloudy", "overcast"].map(
      (condition) => sceneOf(condition).clouds,
    );
    if (!scattered || !cloudy || !overcast) throw new Error("a cloudy sky has no cloud");
    expect(sceneOf("partly-cloudy-night").clouds).toBe(scattered);
    expect(scattered.cover).toBeGreaterThan(cloudy.cover);
    expect(cloudy.cover).toBeGreaterThan(overcast.cover);
    expect(scattered.reach).toBeLessThan(cloudy.reach);
    expect(cloudy.reach).toBeLessThan(overcast.reach);
    expect(scattered.alpha).toBeLessThan(overcast.alpha);
    expect(sceneOf("cloudy").layers).toEqual([]);
    for (const dry of ["rain", "snow", "clear", "clear-night", "windy"]) {
      expect(sceneOf(dry).clouds).toBeUndefined();
    }
  });

  test("rain borrows the sky accent; snow and the rest are ink", () => {
    for (const wet of ["drizzle", "rain", "pouring", "thunderstorm"])
      expect(tintOf(wet)).toBe("sky");
    for (const dry of ["snow", "hail", "fog", "clear", "clear-night", "windy", "overcast", "?"]) {
      expect(tintOf(dry)).toBe("ink");
    }
  });

  test("only a thunderstorm flashes", () => {
    expect(sceneOf("thunderstorm").flashes).toBe(true);
    for (const condition of Object.keys(WEATHER_ICON)) {
      if (condition !== "thunderstorm") expect(sceneOf(condition).flashes).toBeUndefined();
    }
  });

  test("heavier weather is denser, faster and leans more", () => {
    const [drizzle, rain, pouring] = [only("drizzle"), only("rain"), only("pouring")];
    expect(drizzle.density).toBeLessThan(rain.density);
    expect(rain.density).toBeLessThan(pouring.density);
    expect(drizzle.speed[1]).toBeLessThan(rain.speed[0]);
    expect(rain.speed[1]).toBeLessThan(pouring.speed[0]);
    expect(drizzle.lean).toBeLessThan(rain.lean);
    expect(rain.lean).toBeLessThan(pouring.lean);
  });
});

describe("the layers", () => {
  test("every condition's layers have sane ranges", () => {
    for (const condition of Object.keys(WEATHER_ICON)) {
      for (const layer of sceneOf(condition).layers) {
        expect(layer.density).toBeGreaterThan(0);
        expect(layer.least).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(layer.least)).toBe(true);
        for (const [lo, hi] of [layer.speed, layer.size, layer.thick, layer.alpha]) {
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(lo).toBeLessThanOrEqual(hi);
        }
        expect(layer.alpha[1]).toBeLessThanOrEqual(1);
        expect(layer.size[0]).toBeGreaterThan(0);
        expect(layer.lean).toBeGreaterThanOrEqual(0);
        expect(layer.sway).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("only a star stands still; everything else moves", () => {
    for (const condition of Object.keys(WEATHER_ICON)) {
      for (const layer of sceneOf(condition).layers) {
        if (layer.mark === "star") expect(layer.speed).toEqual([0, 0]);
        else expect(layer.speed[0]).toBeGreaterThan(0);
      }
    }
  });
});

describe("countOf", () => {
  test("grows with the box and the intensity", () => {
    const rain = only("rain");
    expect(countOf(rain, 400, 250)).toBe(11);
    expect(countOf(rain, 800, 250)).toBe(22);
    expect(countOf(rain, 400, 250, 2)).toBe(22);
    expect(countOf(rain, 400, 250, 0.5)).toBe(6);
  });

  test("a tile too small for the density still holds a few", () => {
    const wind = only("windy");
    expect(countOf(wind, 160, 112)).toBe(wind.least);
    expect(countOf(only("clear-night"), 10, 10)).toBe(only("clear-night").least);
    expect(countOf(only("rain"), 1, 1)).toBe(only("rain").least);
  });

  test("no intensity or no box still holds the fewest", () => {
    const rain = only("rain");
    expect(countOf(rain, 400, 250, 0)).toBe(rain.least);
    expect(countOf(rain, 0, 0)).toBe(rain.least);
  });
});

describe("spawn", () => {
  test("a falling mark made anywhere is inside the box; one made later waits above it", () => {
    const rain = only("rain");
    const inside = spawn(rain, 300, 200, half, true);
    expect(inside.x).toBe(150);
    expect(inside.y).toBe(100);
    expect(inside.vy).toBeGreaterThan(0);
    expect(inside.vx).toBeCloseTo(inside.vy * rain.lean);
    const above = spawn(rain, 300, 200, half, false);
    expect(above.y).toBeLessThan(0);
    expect(above.x).toBe(150);
  });

  test("a mote rises from below; a gust comes in from the left; a star keeps high", () => {
    const mote = spawn(only("clear"), 300, 200, half, false);
    expect(mote.vy).toBeLessThan(0);
    expect(mote.y).toBeGreaterThan(200);
    const gust = spawn(only("windy"), 300, 200, half, false);
    expect(gust.vx).toBeGreaterThan(0);
    expect(gust.vy).toBe(0);
    expect(gust.x).toBe(-gust.size);
    const star = spawn(only("clear-night"), 300, 200, () => 0.99, true);
    expect(star.vx).toBe(0);
    expect(star.vy).toBe(0);
    expect(star.y).toBeLessThanOrEqual(200 * 0.7);
  });

  test("size, thickness and alpha come from the layer's ranges", () => {
    const rain = only("rain");
    const low = spawn(rain, 300, 200, () => 0, true);
    const high = spawn(rain, 300, 200, () => 0.999999, true);
    expect(low.size).toBe(rain.size[0]);
    expect(high.size).toBeCloseTo(rain.size[1], 3);
    expect(low.alpha).toBe(rain.alpha[0]);
    expect(high.alpha).toBeCloseTo(rain.alpha[1], 3);
    expect(low.thick).toBe(rain.thick[0]);
  });
});

describe("populate", () => {
  test("twice the intensity, about twice the marks", () => {
    const rain = sceneOf("rain");
    expect(populate(rain, 800, 500, 1, half).length).toBe(countOf(only("rain"), 800, 500));
    expect(populate(rain, 800, 500, 2, half).length).toBe(countOf(only("rain"), 800, 500, 2));
    expect(populate(rain, 800, 500, 2, half).length).toBeGreaterThan(
      populate(rain, 800, 500, 1, half).length,
    );
  });

  test("every mark belongs to a layer of its scene", () => {
    const scene = sceneOf("partly-cloudy-night");
    for (const drop of populate(scene, 400, 250, 1, half)) {
      expect(scene.layers).toContain(drop.layer);
    }
  });

  test("each layer's count, every mark somewhere in the box", () => {
    const drops = populate(sceneOf("hail"), 400, 250, 1, sequence(0.1, 0.9, 0.5));
    const [streaks, stones] = sceneOf("hail").layers;
    expect(drops.length).toBe(
      countOf(streaks as Layer, 400, 250) + countOf(stones as Layer, 400, 250),
    );
    for (const drop of drops) {
      expect(drop.x).toBeGreaterThanOrEqual(0);
      expect(drop.x).toBeLessThanOrEqual(400);
      expect(drop.y).toBeGreaterThanOrEqual(0);
      expect(drop.y).toBeLessThanOrEqual(250);
    }
    expect(populate(sceneOf("meteor shower"), 400, 250, 1, half)).toEqual([]);
  });
});

describe("advance", () => {
  test("no time passing leaves a drop where it is", () => {
    const drop = spawn(only("snow"), 300, 200, half, true);
    const before = { ...drop };
    advance(drop, 0, 1234, 300, 200, half);
    expect(drop).toEqual(before);
  });

  test("stars never move, however long they are advanced", () => {
    const star = spawn(only("clear-night"), 300, 200, sequence(0.2, 0.7, 0.4), true);
    const { x, y } = star;
    for (let time = 0; time < 60_000; time += 1000) advance(star, 1, time, 300, 200, half);
    expect(star.x).toBe(x);
    expect(star.y).toBe(y);
  });

  test("a mote that rises out keeps its layer when it comes back", () => {
    const clear = only("clear");
    const mote = spawn(clear, 300, 200, half, true);
    mote.y = 1;
    mote.vy = -1000;
    advance(mote, 0.1, 0, 300, 200, () => 0.25);
    expect(mote.layer).toBe(clear);
    expect(mote.vy).toBeLessThan(0);
  });

  test("a flake drifting off the right comes back on the left, keeping its height", () => {
    const flake = spawn(only("snow"), 300, 200, half, true);
    flake.x = 300 + flake.size + 1;
    const y = flake.y;
    advance(flake, 0, 0, 300, 200, half);
    expect(flake.x).toBeLessThan(0);
    expect(flake.y).toBe(y);
  });

  test("a drop moves by its velocity over dt", () => {
    const drop = spawn(only("rain"), 300, 200, half, true);
    const { x, y, vx, vy } = drop;
    advance(drop, 0.1, 0, 300, 200, half);
    expect(drop.x).toBeCloseTo(x + vx * 0.1);
    expect(drop.y).toBeCloseTo(y + vy * 0.1);
  });

  test("a drop that falls out of the box comes back above it, somewhere new", () => {
    const drop = spawn(only("rain"), 300, 200, half, true);
    drop.y = 199;
    drop.vy = 1000;
    advance(drop, 0.1, 0, 300, 200, () => 0.25);
    expect(drop.y).toBeLessThan(0);
    expect(drop.x).toBe(75);
    expect(drop.layer).toBe(only("rain"));
  });

  test("a mote that rises out of the box comes back below it", () => {
    const drop = spawn(only("clear"), 300, 200, half, true);
    drop.y = 1;
    drop.vy = -1000;
    advance(drop, 0.1, 0, 300, 200, half);
    expect(drop.y).toBeGreaterThan(200);
  });

  test("a drop leaving by a side comes in by the other", () => {
    const gust = spawn(only("windy"), 300, 200, half, true);
    gust.x = 299;
    gust.vx = 1000;
    advance(gust, 0.1, 0, 300, 200, half);
    expect(gust.x).toBeLessThan(0);
    const flake = spawn(only("snow"), 300, 200, half, true);
    flake.x = -flake.size - 1;
    flake.vx = 0;
    advance(flake, 0.1, 0, 300, 200, half);
    expect(flake.x).toBeGreaterThan(0);
  });

  test("a hailstone gathers speed, strikes the bottom once and bounces, then goes on down", () => {
    const [, hail] = sceneOf("hail").layers;
    if (!hail) throw new Error("hail has no stones");
    const stone = spawn(hail, 300, 200, half, true);
    stone.y = 150;
    const fall = stone.vy;
    advance(stone, 0.1, 0, 300, 200, half);
    expect(stone.vy).toBeCloseTo(fall + GRAVITY * 0.1);
    expect(stone.bounced).toBe(false);
    // Carried past the floor in one step, it comes back up with a share of its fall.
    stone.y = 200 - stone.size + 5;
    stone.vy = 400;
    advance(stone, 0.05, 0, 300, 200, half);
    expect(stone.bounced).toBe(true);
    expect(stone.y).toBeLessThan(200 - stone.size);
    expect(stone.vy).toBeLessThan(0);
    expect(stone.vy).toBeCloseTo(-(400 + GRAVITY * 0.05) * BOUNCE);
    // Falling again, it passes the floor without a second bounce, leaves the box, and is at
    // once a new stone waiting above it.
    let steps = 0;
    let highest = stone.y;
    let fellAgain = false;
    while (stone.y >= 0 && steps++ < 200) {
      advance(stone, 0.05, 0, 300, 200, half);
      if (stone.y >= 0) {
        highest = Math.min(highest, stone.y);
        if (stone.vy > 0) fellAgain = true;
      }
    }
    expect(steps).toBeLessThan(200);
    expect(highest).toBeLessThan(200 - stone.size - 5);
    expect(fellAgain).toBe(true);
    expect(stone.y).toBeLessThan(0);
    expect(stone.bounced).toBe(false);
  });

  test("some marks fall in front of the words and some behind; stars are always behind", () => {
    const rain = populate(sceneOf("rain"), 400, 250, 1, sequence(0.1, 0.9, 0.5));
    expect(rain.some((drop) => drop.near)).toBe(true);
    expect(rain.some((drop) => !drop.near)).toBe(true);
    const stars = populate(sceneOf("clear-night"), 400, 250, 1, () => 0);
    expect(stars.every((drop) => !drop.near)).toBe(true);
  });

  test("fog and haze fill the box with cloud, in front and behind; haze is thinner", () => {
    const fog = sceneOf("fog").clouds;
    const haze = sceneOf("haze").clouds;
    if (!fog || !haze) throw new Error("fog has no cloud");
    expect(fog.fill).toBe(true);
    expect(haze.fill).toBe(true);
    expect(haze.alpha).toBeLessThan(fog.alpha);
    expect(sceneOf("fog").layers).toEqual([]);
  });

  test("snow wanders from side to side; a gust bobs up and down", () => {
    const flake = spawn(only("snow"), 300, 200, half, true);
    const sideways: number[] = [];
    for (let time = 0; time < 6000; time += 500) {
      const before = flake.x;
      advance(flake, 0.1, time, 300, 200, half);
      sideways.push(flake.x - before);
    }
    expect(Math.max(...sideways)).toBeGreaterThan(Math.min(...sideways));
    const gust = spawn(only("windy"), 300, 200, half, true);
    const y = gust.y;
    advance(gust, 0.1, 1200, 300, 200, half);
    expect(gust.y).not.toBe(y);
    expect(gust.x).toBeCloseTo(150 + gust.vx * 0.1);
  });
});

describe("the beats", () => {
  test("a twinkle stays between dim and bright and differs by phase", () => {
    for (let time = 0; time < 5000; time += 97) {
      const beat = twinkle(time, 1);
      expect(beat).toBeGreaterThanOrEqual(0.3);
      expect(beat).toBeLessThanOrEqual(1);
    }
    expect(twinkle(0, 0)).not.toBeCloseTo(twinkle(0, Math.PI / 2));
  });

  test("a gust is faint at the edges and full in the middle", () => {
    const gust = spawn(only("windy"), 300, 200, half, true);
    gust.x = -gust.size;
    expect(gustFade(gust, 300)).toBeCloseTo(0);
    gust.x = 150;
    expect(gustFade(gust, 300)).toBeCloseTo(1);
    gust.x = 300 + gust.size;
    expect(gustFade(gust, 300)).toBeCloseTo(0);
    gust.x = 1000;
    expect(gustFade(gust, 300)).toBeCloseTo(0);
  });

  test("lightning: seconds apart, a flicker, then a short glow, then nothing", () => {
    expect(nextFlash(() => 0)).toBe(4000);
    expect(nextFlash(() => 1)).toBe(13000);
    expect(flashAlpha(-1)).toBe(0);
    expect(flashAlpha(0)).toBe(1);
    expect(flashAlpha(100)).toBe(0.35);
    expect(flashAlpha(200)).toBe(0.7);
    expect(flashAlpha(220)).toBeCloseTo(0.4);
    expect(flashAlpha(320)).toBeCloseTo(0.2);
    expect(flashAlpha(420)).toBe(0);
    expect(flashAlpha(10_000)).toBe(0);
  });
});
