// SunPath: the whole day as the sun's curve, above the horizon from sunrise to sunset and below
// it through the night, the sun where it is now, the way it has come drawn apart from the way
// ahead, and what the sun does next above it all. A pointer run along it reads the time there
// and, where the house's place is known, the sun's angle.

import { describe, expect, test } from "bun:test";
import { solarElevation } from "../sun-math.ts";
import { setupDom } from "../test-dom.ts";
import { angleWords, SunPath, type SunPathProps } from "./sun-path.tsx";

const dom = setupDom();

const HOUR = 3_600_000;
// Saturday 10 October 2026 in Seattle (UTC-7), midnight to midnight, with Open-Meteo's sunrise
// (7:20 am) and sunset (6:29 pm) for Redmond.
const DAY_START = Date.UTC(2026, 9, 10, 7);
const DAY_END = DAY_START + 24 * HOUR;
const RISE_AT = 1_791_642_027_000;
const SET_AT = 1_791_682_165_000;
const NOON = (RISE_AT + SET_AT) / 2;
const LAT = 47.74922;
const LON = -122.103131;
const ZONE = "America/Los_Angeles";

/** A moment as a share of the day, and back. */
const share = (ms: number) => (ms - DAY_START) / (DAY_END - DAY_START);
const at = (t: number) => DAY_START + t * (DAY_END - DAY_START);

const sun = (props: Partial<SunPathProps> = {}) => (
  <SunPath
    label="Sun"
    rise="7:20 am"
    set="6:29 pm"
    dayStart={DAY_START}
    dayEnd={DAY_END}
    riseAt={RISE_AT}
    setAt={SET_AT}
    now={NOON}
    timeZone={ZONE}
    headline="Sunset in 5h"
    {...props}
  />
);
/** The same day where the house's place is known. */
const placed = (props: Partial<SunPathProps> = {}) =>
  sun({ latitude: LAT, longitude: LON, ...props });

const root = (el: HTMLElement) => el.querySelector<HTMLElement>("[role=img]");
const dot = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-sun-dot");
const plot = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-sun-plot");
const times = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".ca-sun-time")];
const headline = (el: HTMLElement) => el.querySelector(".ca-sun-headline")?.textContent;
const details = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-sun-detail")].map((d) => d.textContent);
/** Each travelled segment's classes, in drawing order. */
const gone = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-sun-gone")].map((g) => g.getAttribute("class"));
/** A shape's points as [x, y] pairs. */
const pointsOf = (el: Element | null | undefined) =>
  (el?.getAttribute("points") ?? "").split(" ").map((p) => p.split(",").map(Number));
/** Where a segment starts and ends along the day, as shares: x runs 0 to 1000. */
const span = (el: Element | null | undefined) => {
  const points = pointsOf(el);
  return [(points[0]?.[0] ?? Number.NaN) / 1000, (points.at(-1)?.[0] ?? Number.NaN) / 1000];
};
const horizonY = (el: HTMLElement) =>
  Number(el.querySelector(".ca-sun-horizon")?.getAttribute("y1"));

// The plot's box on the page: 400 wide from x = 100, so a pointer at 300 is half way along.
const BOX = { left: 100, width: 400 };
function boxed(el: HTMLElement): HTMLElement {
  const target = plot(el) as HTMLElement;
  target.getBoundingClientRect = () =>
    ({
      ...BOX,
      x: BOX.left,
      y: 0,
      top: 0,
      right: BOX.left + BOX.width,
      bottom: 100,
      height: 100,
      toJSON: () => ({}),
    }) as DOMRect;
  return target;
}
/** The clientX that puts a pointer at a share of the plot. */
const x = (t: number) => BOX.left + t * BOX.width;

type Pointer = { pointerType?: string; clientX?: number; buttons?: number };
/** A pointer event on the plot, as the browser would send it. */
async function pointer(target: Element, type: string, init: Pointer = {}) {
  const View = (dom.document.defaultView as unknown as { PointerEvent: typeof PointerEvent })
    .PointerEvent;
  await dom.act(() => {
    target.dispatchEvent(
      new View(type, { bubbles: true, pointerId: 1, pointerType: "mouse", ...init }),
    );
  });
}
/** The pointer going off the plot to nowhere: React reads a leave from this. */
const leave = (target: Element, pointerType = "mouse") =>
  pointer(target, "pointerout", { pointerType });

const hovering = (el: HTMLElement) => plot(el)?.classList.contains("ca-sun-plot-hover");

describe("angleWords", () => {
  test("an angle above the horizon is so many degrees up, rounded", () => {
    expect(angleWords(28)).toBe("28° up");
    expect(angleWords(27.6)).toBe("28° up");
  });

  test("below it, so many degrees down", () => {
    expect(angleWords(-41)).toBe("41° down");
    expect(angleWords(-40.7)).toBe("41° down");
  });

  test("an angle that rounds to nothing is on the horizon, either side", () => {
    expect(angleWords(0)).toBe("On the horizon");
    expect(angleWords(0.4)).toBe("On the horizon");
    expect(angleWords(-0.4)).toBe("On the horizon");
    expect(angleWords(0.5)).toBe("1° up");
  });
});

describe("SunPath", () => {
  test("is one labelled image, with the drawing hidden from screen readers", async () => {
    const el = await dom.render(sun());
    expect(root(el)?.getAttribute("aria-label")).toBe("Sun");
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".ca-sun-horizon")).not.toBeNull();
    expect(el.querySelector(".ca-sun-ahead")).not.toBeNull();
  });

  test("shows sunrise and sunset, in that order", async () => {
    const el = await dom.render(sun());
    expect(times(el).map((t) => t.textContent)).toEqual(["7:20 am", "6:29 pm"]);
  });

  test("className is added to the image", async () => {
    const day = await dom.render(sun({ className: "wide" }));
    expect(root(day)?.className).toBe("ca-sun wide");
    const night = await dom.render(sun({ now: RISE_AT - HOUR, className: "wide" }));
    expect(root(night)?.className).toBe("ca-sun ca-sun-night wide");
  });

  describe("the heading", () => {
    test("the headline leads, and the detail follows it", async () => {
      const el = await dom.render(sun({ detail: "11h 9m of daylight" }));
      expect(headline(el)).toBe("Sunset in 5h");
      expect(details(el)).toEqual(["11h 9m of daylight"]);
    });

    test("with no detail and no place there is only the headline", async () => {
      const el = await dom.render(sun());
      expect(details(el)).toEqual([]);
      expect(el.querySelector(".ca-sun-head")?.children).toHaveLength(1);
    });

    test("where the house is known, the sun's angle now follows the detail", async () => {
      // Solar noon in Redmond in mid October: about 35° up.
      const el = await dom.render(placed({ detail: "11h 9m of daylight" }));
      expect(details(el)).toEqual(["11h 9m of daylight", "· Sun 35° up"]);
    });

    test("the angle is the sun's own at now, below the horizon by night", async () => {
      const now = NOON + 12 * HOUR - 24 * HOUR;
      const el = await dom.render(placed({ now }));
      const angle = solarElevation(now, LAT, LON);
      expect(angle).toBeLessThan(-40);
      expect(details(el)).toEqual([`· Sun ${angleWords(angle).toLowerCase()}`]);
      expect(details(el)[0]).toMatch(/^· Sun \d+° down$/);
    });

    test("with only one of latitude and longitude, no angle is shown", async () => {
      const lat = await dom.render(sun({ latitude: LAT }));
      expect(details(lat)).toEqual([]);
      const lon = await dom.render(sun({ longitude: LON }));
      expect(details(lon)).toEqual([]);
    });

    test("a place at 0° latitude and longitude is still a place", async () => {
      const el = await dom.render(sun({ latitude: 0, longitude: 0 }));
      expect(details(el)[0]).toMatch(/^· Sun (\d+° (up|down)|on the horizon)$/);
    });
  });

  describe("the sun", () => {
    test("by day it is up, placed at now along the day, and the image is day", async () => {
      const el = await dom.render(sun({ now: at(0.4) }));
      expect(dot(el)?.className).toBe("ca-sun-dot ca-sun-dot-up");
      expect(dot(el)?.style.left).toBe("40%");
      expect(root(el)?.className).toBe("ca-sun");
      // Above the horizon line.
      expect(Number.parseFloat(dot(el)?.style.top ?? "")).toBeLessThan(horizonY(el));
    });

    test("before sunrise it is down, below the horizon, and the image is night", async () => {
      const el = await dom.render(sun({ now: at(0.1) }));
      expect(dot(el)?.className).toBe("ca-sun-dot ca-sun-dot-down");
      expect(Number.parseFloat(dot(el)?.style.top ?? "")).toBeGreaterThan(horizonY(el));
      expect(root(el)?.className).toBe("ca-sun ca-sun-night");
    });

    test("after sunset it is down too", async () => {
      const el = await dom.render(sun({ now: at(0.9) }));
      expect(dot(el)?.className).toBe("ca-sun-dot ca-sun-dot-down");
      expect(dot(el)?.style.left).toBe("90%");
      expect(root(el)?.className).toBe("ca-sun ca-sun-night");
    });

    test.each([
      ["sunrise", RISE_AT],
      ["sunset", SET_AT],
    ])("at %s itself it is up, on the horizon", async (_, now) => {
      const el = await dom.render(sun({ now }));
      expect(dot(el)?.className).toBe("ca-sun-dot ca-sun-dot-up");
      expect(Number.parseFloat(dot(el)?.style.top ?? "")).toBeCloseTo(horizonY(el), 0);
      expect(root(el)?.classList.contains("ca-sun-night")).toBe(false);
    });

    test("where the house is known, it is up or down by the same sunrise and sunset", async () => {
      const day = await dom.render(placed({ now: RISE_AT + HOUR }));
      expect(dot(day)?.className).toBe("ca-sun-dot ca-sun-dot-up");
      const night = await dom.render(placed({ now: SET_AT + HOUR }));
      expect(dot(night)?.className).toBe("ca-sun-dot ca-sun-dot-down");
    });

    test("a now outside the day is kept at its ends", async () => {
      const early = await dom.render(sun({ now: DAY_START - HOUR }));
      expect(dot(early)?.style.left).toBe("0%");
      const late = await dom.render(sun({ now: DAY_END + HOUR }));
      expect(dot(late)?.style.left).toBe("100%");
    });

    test("a 25-hour day places now by its own length", async () => {
      // The day the clocks go back: noon local is 13 of 25 hours in.
      const dayStart = Date.UTC(2026, 10, 1, 7);
      const el = await dom.render(
        sun({
          dayStart,
          dayEnd: dayStart + 25 * HOUR,
          riseAt: dayStart + 7.5 * HOUR,
          setAt: dayStart + 17.5 * HOUR,
          now: dayStart + 13 * HOUR,
        }),
      );
      expect(dot(el)?.style.left).toBe("52%");
    });
  });

  describe("the curve", () => {
    test("the day is a shape from sunrise to sunset, above the horizon", async () => {
      const el = await dom.render(sun());
      const polygon = el.querySelector(".ca-sun-day");
      const [from, to] = span(polygon);
      expect(from).toBeCloseTo(share(RISE_AT), 2);
      expect(to).toBeCloseTo(share(SET_AT), 2);
      // The SVG's y runs down, so above the horizon is a smaller y.
      for (const [, y] of pointsOf(polygon)) expect(y).toBeLessThanOrEqual(horizonY(el) + 0.1);
    });

    test("where the house is known, the day is a shape from sunrise to sunset too", async () => {
      const el = await dom.render(placed());
      const polygon = el.querySelector(".ca-sun-day");
      const [from, to] = span(polygon);
      expect(from).toBeCloseTo(share(RISE_AT), 2);
      expect(to).toBeCloseTo(share(SET_AT), 2);
      // The real sun is within a hair of the horizon at the real sunrise, so the shape is too.
      for (const [, y] of pointsOf(polygon)) expect(y).toBeLessThanOrEqual(horizonY(el) + 0.5);
    });

    test("it is fitted to the drawing, with a little room above and below", async () => {
      for (const node of [sun(), placed()]) {
        const el = await dom.render(node);
        const ys = pointsOf(el.querySelector(".ca-sun-ahead")).map(([, y]) => y as number);
        const all = [...ys, ...pointsOf(el.querySelector(".ca-sun-gone")).map(([, y]) => y)];
        // The drawing is 100 tall with 8 spare at the top and the bottom.
        expect(Math.min(...(all as number[]))).toBeCloseTo(8, 0);
        expect(Math.max(...(all as number[]))).toBeCloseTo(92, 0);
      }
    });

    test("a night deeper than the day is eased, so it is drawn shallower", async () => {
      // In Redmond in October the sun is 35° up at noon but 49° down at midnight.
      const el = await dom.render(placed({ now: DAY_START }));
      const ys = pointsOf(el.querySelector(".ca-sun-ahead")).map(([, y]) => y as number);
      const horizon = horizonY(el);
      expect(Math.max(...ys) - horizon).toBeLessThan(horizon - Math.min(...ys));
    });

    test("every point is inside the drawing, however deep the night", async () => {
      // Longyearbyen at the December solstice: the sun never rises.
      const el = await dom.render(
        sun({ latitude: 78.22, longitude: 15.65, riseAt: DAY_START, setAt: DAY_START }),
      );
      for (const shape of el.querySelectorAll("polyline, polygon")) {
        for (const [px, py] of pointsOf(shape)) {
          expect(px).toBeGreaterThanOrEqual(0);
          expect(px).toBeLessThanOrEqual(1000);
          expect(py).toBeGreaterThanOrEqual(0);
          expect(py).toBeLessThanOrEqual(100);
        }
      }
    });

    test("the curve meets the horizon line at sunrise, for the model and the real sun alike", async () => {
      // The line is drawn where the sun's centre is at an official sunrise, 0.833° down.
      for (const node of [sun({ now: RISE_AT }), placed({ now: RISE_AT })]) {
        const el = await dom.render(node);
        const ahead = pointsOf(el.querySelector(".ca-sun-ahead"));
        expect(ahead[0]?.[1]).toBeCloseTo(horizonY(el), 0);
      }
    });
  });

  describe("the way the sun has come", () => {
    test("before sunrise it is only the night so far, muted", async () => {
      const el = await dom.render(sun({ now: at(0.1) }));
      expect(gone(el)).toEqual(["ca-sun-gone"]);
      const [from, to] = span(el.querySelector(".ca-sun-gone"));
      expect(from).toBe(0);
      expect(to).toBeCloseTo(0.1, 3);
    });

    test("by day it is the night muted, then the day from sunrise to now", async () => {
      const el = await dom.render(sun({ now: at(0.5) }));
      expect(gone(el)).toEqual(["ca-sun-gone", "ca-sun-gone ca-sun-gone-day"]);
      const night = span(el.querySelector(".ca-sun-gone:not(.ca-sun-gone-day)"));
      expect(night[0]).toBe(0);
      expect(night[1]).toBeCloseTo(share(RISE_AT), 3);
      const day = span(el.querySelector(".ca-sun-gone-day"));
      expect(day[0]).toBeCloseTo(share(RISE_AT), 3);
      expect(day[1]).toBeCloseTo(0.5, 3);
    });

    test("after sunset it is the night, the whole day, and the evening muted again", async () => {
      const el = await dom.render(sun({ now: at(0.9) }));
      expect(gone(el)).toEqual(["ca-sun-gone", "ca-sun-gone ca-sun-gone-day", "ca-sun-gone"]);
      const day = span(el.querySelector(".ca-sun-gone-day"));
      expect(day[1]).toBeCloseTo(share(SET_AT), 3);
      const evening = span(el.querySelectorAll(".ca-sun-gone")[2]);
      expect(evening[0]).toBeCloseTo(share(SET_AT), 3);
      expect(evening[1]).toBeCloseTo(0.9, 3);
    });

    test("at sunrise itself no day has gone yet", async () => {
      const el = await dom.render(sun({ now: RISE_AT }));
      expect(gone(el)).toEqual(["ca-sun-gone"]);
    });

    test("the way ahead runs from now to the end of the day", async () => {
      const el = await dom.render(sun({ now: at(0.4) }));
      const [from, to] = span(el.querySelector(".ca-sun-ahead"));
      expect(from).toBeCloseTo(0.4, 3);
      expect(to).toBe(1);
    });

    test("the way gone and the way ahead meet at now", async () => {
      const el = await dom.render(sun({ now: at(0.6) }));
      const day = pointsOf(el.querySelector(".ca-sun-gone-day"));
      const ahead = pointsOf(el.querySelector(".ca-sun-ahead"));
      expect(day.at(-1)).toEqual(ahead[0] as number[]);
    });
  });

  describe("the times' places", () => {
    test("each sits under its moment along the day", async () => {
      const el = await dom.render(sun());
      const left = times(el).map((t) => Number.parseFloat(t.style.left));
      expect(left[0]).toBeCloseTo(share(RISE_AT) * 100, 1);
      expect(left[1]).toBeCloseTo(share(SET_AT) * 100, 1);
    });

    test("near the edges they are kept between 7% and 93%", async () => {
      const el = await dom.render(sun({ riseAt: at(0.02), setAt: at(0.98) }));
      expect(times(el).map((t) => t.style.left)).toEqual(["7%", "93%"]);
    });

    test("inside the bounds they are not moved", async () => {
      const el = await dom.render(sun({ riseAt: at(0.125), setAt: at(0.875) }));
      expect(times(el).map((t) => t.style.left)).toEqual(["12.5%", "87.5%"]);
    });
  });

  describe("reading the day with a pointer", () => {
    test("at rest there is no cursor, no probe and no hover class", async () => {
      const el = await dom.render(placed());
      expect(hovering(el)).toBe(false);
      expect(el.querySelector(".ca-sun-cursor")).toBeNull();
      expect(el.querySelector(".ca-sun-probe")).toBeNull();
    });

    test("a mouse passing over reads the time there and the sun's angle", async () => {
      const el = await dom.render(placed({ detail: "11h 9m of daylight" }));
      await pointer(boxed(el), "pointermove", { clientX: x(0.5) });
      expect(hovering(el)).toBe(true);
      // Half way through the day is noon on the house's clock.
      expect(headline(el)).toBe("12:00 pm");
      const angle = solarElevation(at(0.5), LAT, LON);
      expect(details(el)).toEqual([`Sun ${angleWords(angle).toLowerCase()}`]);
      expect(details(el)[0]).toMatch(/^Sun \d+° up$/);
      expect(el.querySelector<HTMLElement>(".ca-sun-cursor")?.style.left).toBe("50%");
      expect(el.querySelector<HTMLElement>(".ca-sun-probe")?.style.left).toBe("50%");
    });

    test("the probe sits on the curve, below the horizon by night", async () => {
      const el = await dom.render(placed());
      await pointer(boxed(el), "pointermove", { clientX: x(0.05) });
      const top = Number.parseFloat(
        el.querySelector<HTMLElement>(".ca-sun-probe")?.style.top ?? "",
      );
      expect(top).toBeGreaterThan(horizonY(el));
      expect(details(el)[0]).toMatch(/^Sun \d+° down$/);
    });

    test("the reading follows the mouse along", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointermove", { clientX: x(0.25) });
      expect(headline(el)).toBe("6:00 am");
      await pointer(target, "pointermove", { clientX: x(0.75) });
      expect(headline(el)).toBe("6:00 pm");
      expect(el.querySelector<HTMLElement>(".ca-sun-cursor")?.style.left).toBe("75%");
    });

    test("a pointer off either end of the plot reads the day's ends", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointermove", { clientX: BOX.left - 50 });
      expect(headline(el)).toBe("12:00 am");
      expect(el.querySelector<HTMLElement>(".ca-sun-cursor")?.style.left).toBe("0%");
      await pointer(target, "pointermove", { clientX: BOX.left + BOX.width + 50 });
      expect(el.querySelector<HTMLElement>(".ca-sun-cursor")?.style.left).toBe("100%");
    });

    test("where the house is not known, only the time is read", async () => {
      const el = await dom.render(sun({ detail: "11h 9m of daylight" }));
      await pointer(boxed(el), "pointermove", { clientX: x(0.5) });
      expect(headline(el)).toBe("12:00 pm");
      expect(details(el)).toEqual([]);
      expect(el.querySelector(".ca-sun-probe")).not.toBeNull();
    });

    test("the time is read in the house's zone", async () => {
      // The same moment, noon in Seattle, is 8 pm in London's summer time.
      const el = await dom.render(sun({ timeZone: "Europe/London" }));
      await pointer(boxed(el), "pointermove", { clientX: x(0.5) });
      expect(headline(el)).toBe("8:00 pm");
    });

    test("an unknown zone falls back to the browser's instead of throwing", async () => {
      const el = await dom.render(sun({ timeZone: "Mars/Olympus_Mons" }));
      await pointer(boxed(el), "pointermove", { clientX: x(0.5) });
      expect(headline(el)).toMatch(/^\d{1,2}:\d\d [ap]m$/);
    });

    test("a plot with no width reads nothing", async () => {
      // Not laid out yet: happy-dom's own box is all zeros.
      const el = await dom.render(placed());
      await pointer(plot(el) as HTMLElement, "pointermove", { clientX: 300 });
      expect(hovering(el)).toBe(false);
      expect(headline(el)).toBe("Sunset in 5h");
    });

    test("the mouse leaving puts the heading back", async () => {
      const el = await dom.render(placed({ detail: "11h 9m of daylight" }));
      const target = boxed(el);
      await pointer(target, "pointermove", { clientX: x(0.5) });
      await leave(target);
      expect(hovering(el)).toBe(false);
      expect(headline(el)).toBe("Sunset in 5h");
      expect(details(el)).toEqual(["11h 9m of daylight", "· Sun 35° up"]);
      expect(el.querySelector(".ca-sun-cursor")).toBeNull();
      expect(el.querySelector(".ca-sun-probe")).toBeNull();
    });

    test("letting go of the mouse button keeps the reading: it is still over the plot", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { clientX: x(0.5), buttons: 1 });
      await pointer(target, "pointerup", { clientX: x(0.5) });
      expect(hovering(el)).toBe(true);
      expect(headline(el)).toBe("12:00 pm");
    });

    test("a finger reads from where it touches down", async () => {
      const el = await dom.render(placed());
      await pointer(boxed(el), "pointerdown", {
        pointerType: "touch",
        clientX: x(0.25),
        buttons: 1,
      });
      expect(hovering(el)).toBe(true);
      expect(headline(el)).toBe("6:00 am");
    });

    test("a finger dragging along reads as it goes", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { pointerType: "touch", clientX: x(0.25), buttons: 1 });
      await pointer(target, "pointermove", { pointerType: "touch", clientX: x(0.5), buttons: 1 });
      expect(headline(el)).toBe("12:00 pm");
    });

    test("a pen moving with no button down reads nothing", async () => {
      const el = await dom.render(placed());
      await pointer(boxed(el), "pointermove", { pointerType: "pen", clientX: x(0.5), buttons: 0 });
      expect(hovering(el)).toBe(false);
      expect(headline(el)).toBe("Sunset in 5h");
    });

    test("lifting a finger puts the heading back", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { pointerType: "touch", clientX: x(0.5), buttons: 1 });
      await pointer(target, "pointerup", { pointerType: "touch", clientX: x(0.5) });
      expect(hovering(el)).toBe(false);
      expect(headline(el)).toBe("Sunset in 5h");
    });

    test("a finger sliding off the plot keeps reading until it lifts", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { pointerType: "touch", clientX: x(0.5), buttons: 1 });
      await leave(target, "touch");
      expect(hovering(el)).toBe(true);
      expect(headline(el)).toBe("12:00 pm");
    });

    test.each(["mouse", "touch"])("a cancelled %s pointer puts the heading back", async (type) => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { pointerType: type, clientX: x(0.5), buttons: 1 });
      await pointer(target, "pointercancel", { pointerType: type });
      expect(hovering(el)).toBe(false);
      expect(headline(el)).toBe("Sunset in 5h");
    });

    test("pressing down takes the pointer, so a drag off the plot still reaches it", async () => {
      const el = await dom.render(placed());
      const target = boxed(el);
      await pointer(target, "pointerdown", { pointerType: "touch", clientX: x(0.5), buttons: 1 });
      expect(target.hasPointerCapture(1)).toBe(true);
    });
  });
});
