import { useEffect, useRef } from "react";
import { cloudField, cloudPixels, type RGB, sheetOf } from "../cloud-fx.ts";
import { cx } from "../util.ts";
import {
  advance,
  type Drop,
  flashAlpha,
  gustFade,
  nextFlash,
  populate,
  sceneOf,
  tintOf,
  twinkle,
} from "../weather-fx.ts";

export interface WeatherEffectProps {
  /** The sky now: a condition the design system knows draws its weather; any other, nothing. */
  condition: string;
  /** How much falls: 1 is the usual, 0.5 a hint, 2 a downpour. */
  intensity?: number;
  /** Its colour: `auto` gives rain the sky accent and the rest the muted ink. */
  tint?: "ink" | "sky" | "auto";
  className?: string;
  /** Where chance comes from; given, for a picture that can be reproduced. */
  random?: () => number;
}

/** A flash of lightning at its brightest, before the canvas's own opacity. */
const FLASH = 0.07;
/** How many drawn pixels a cloud sheet's cell covers. */
const SHEET = 4;

/**
 * The classes for what holds a WeatherEffect: positioned and isolated, so the weather stays
 * inside it, behind its words and in front of them; and named for the condition, so fog and
 * haze can soften the words (`ca-wx-far` for large ones, `ca-wx-near` for small ones that
 * seem closer and blur less).
 */
export const weatherHost = (condition: string): string =>
  cx("ca-wx-host", `ca-wx-of-${condition.replace(/[^a-z0-9-]/gi, "")}`);

/** "rgb(106, 93, 80)" or "#6a5d50" as its channels; a colour in another form draws plain. */
const channels = (color: string): RGB | undefined => {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const wide = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(wide.slice(i, i + 2), 16)) as RGB;
  }
  const found = color.match(/[\d.]+/g);
  if (!found || found.length < 3) return undefined;
  return [Number(found[0]), Number(found[1]), Number(found[2])];
};

interface Sheet {
  canvas: HTMLCanvasElement;
  near: boolean;
  speed: number;
  scale: number;
}

/**
 * The weather over whatever it sits in, with depth: two canvases filling the positioned
 * parent, one behind its words and one in front, so cloud gathers about them, fog closes
 * in on them, rain and snow fall past them on both sides, and a hailstone bounces off the
 * bottom. Neither takes a pointer. They draw in their own `color`, pause out of view or in a
 * hidden tab, and hold still where motion is asked to be reduced.
 */
export function WeatherEffect({
  condition,
  intensity = 1,
  tint = "auto",
  className,
  random = Math.random,
}: WeatherEffectProps) {
  const back = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvases = [back.current, front.current];
    const contexts = canvases.map((canvas) => canvas?.getContext?.("2d"));
    const [backCanvas, frontCanvas] = canvases;
    const [backCtx, frontCtx] = contexts;
    if (!backCanvas || !frontCanvas || !backCtx || !frontCtx) return;
    const scene = sceneOf(condition);
    if (!scene.layers.length && !scene.clouds) return;
    const still =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let drops: Drop[] = [];
    let color = "";
    let light: RGB = [255, 255, 255];
    let shade: RGB = [0, 0, 0];
    let sheets: Sheet[] = [];
    let frame = 0;
    let frames = 0;
    let last = 0;
    let visible = true;
    let seen = true;
    let flashAt = performance.now() + nextFlash(random);

    const paint = () => {
      const style = getComputedStyle(backCanvas);
      color = style.color;
      const wasLight = light.join();
      const wasShade = shade.join();
      light = channels(style.getPropertyValue("--ca-wx-cloud-light")) ?? light;
      shade = channels(style.getPropertyValue("--ca-wx-cloud-shade")) ?? shade;
      if (scene.clouds && (light.join() !== wasLight || shade.join() !== wasShade)) weave();
    };

    /**
     * The cloud sheets, once per size and colour: noise as pixels on their own canvases, a
     * quarter the size they are drawn at, which is what makes them soft.
     */
    const weave = () => {
      const spec = scene.clouds;
      if (!spec || typeof document === "undefined" || !width) return;
      sheets = [];
      for (let i = 0; i < spec.layers; i++) {
        const { alpha, speed, scale, near } = sheetOf(i, spec);
        const canvas = document.createElement("canvas");
        const w = Math.max(32, Math.round((width * scale) / SHEET));
        const h = Math.max(8, Math.round(height / SHEET));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const pixels = cloudPixels(cloudField(w, h, random), light, shade, {
          ...spec,
          alpha: spec.alpha * alpha,
        });
        ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
        sheets.push({ canvas, near, speed, scale });
      }
    };

    const drawDrop = (ctx: CanvasRenderingContext2D, drop: Drop, time: number) => {
      const { mark } = drop.layer;
      if (mark === "streak" || mark === "gust") {
        const speed = Math.hypot(drop.vx, drop.vy) || 1;
        ctx.globalAlpha = drop.alpha * (mark === "gust" ? gustFade(drop, width) : 1);
        ctx.lineWidth = drop.thick;
        ctx.beginPath();
        ctx.moveTo(drop.x, drop.y);
        ctx.lineTo(drop.x - (drop.vx / speed) * drop.size, drop.y - (drop.vy / speed) * drop.size);
        ctx.stroke();
      } else {
        const beat = mark === "star" || mark === "mote" ? twinkle(time, drop.phase) : 1;
        ctx.globalAlpha = drop.alpha * beat;
        ctx.beginPath();
        ctx.arc(drop.x, drop.y, drop.size, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const draw = (time: number) => {
      const dpr = devicePixelRatio || 1;
      for (const [ctx, near] of [
        [backCtx, false],
        [frontCtx, true],
      ] as const) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.globalAlpha = 1;
        for (const sheet of sheets) {
          if (sheet.near !== near) continue;
          const w = width * sheet.scale;
          const shift = (((-(time / 1000) * sheet.speed) % w) + w) % w;
          for (let x = shift - w; x < width; x += w) ctx.drawImage(sheet.canvas, x, 0, w, height);
        }
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineCap = "round";
        for (const drop of drops) if (drop.near === near) drawDrop(ctx, drop, time);
        ctx.globalAlpha = 1;
      }
      if (scene.flashes) {
        const flash = flashAlpha(time - flashAt);
        if (flash > 0) {
          frontCtx.globalAlpha = flash * FLASH;
          frontCtx.fillRect(0, 0, width, height);
          frontCtx.globalAlpha = 1;
        } else if (time > flashAt) {
          flashAt = time + nextFlash(random);
        }
      }
    };

    const tick = (time: number) => {
      frame = 0;
      const dt = Math.min(0.05, last ? (time - last) / 1000 : 0);
      last = time;
      if (frames++ % 60 === 0) paint();
      for (const drop of drops) advance(drop, dt, time, width, height, random);
      draw(time);
      queue();
    };
    const queue = () => {
      if (!frame && !still && visible && seen) frame = requestAnimationFrame(tick);
    };
    const halt = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
    };

    const fit = () => {
      const rect = backCanvas.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      for (const canvas of [backCanvas, frontCanvas]) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      drops = populate(scene, width, height, intensity, random);
      paint();
      weave();
      if (still) draw(performance.now());
      else queue();
    };

    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) queue();
      else halt();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    resize?.observe(backCanvas);
    const sight =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            seen = entry?.isIntersecting ?? true;
            if (seen) queue();
            else halt();
          });
    sight?.observe(backCanvas);
    fit();
    return () => {
      halt();
      document.removeEventListener("visibilitychange", onVisibility);
      resize?.disconnect();
      sight?.disconnect();
    };
  }, [condition, intensity, random]);

  const colour = tint === "auto" ? tintOf(condition) : tint;
  const classes = cx("ca-wx", colour === "sky" && "ca-wx-sky", className);
  return (
    <>
      <canvas ref={back} className={cx(classes, "ca-wx-back")} />
      <canvas ref={front} className={cx(classes, "ca-wx-front")} />
    </>
  );
}
