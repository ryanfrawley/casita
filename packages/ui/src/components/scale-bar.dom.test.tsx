// ScaleBar: a reading on a banded scale, one track running through the bands' colours, each band
// an equal share of it, a marker where the reading is, and the band's word in its colour.

import { describe, expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { gradientOf, type ScaleBand, ScaleBar } from "./scale-bar.tsx";

const dom = setupDom();

const BANDS: ScaleBand[] = [
  { label: "Good", tone: 1 },
  { label: "Moderate", tone: 2 },
  { label: "Sensitive groups", tone: 3 },
  { label: "Unhealthy", tone: 4 },
];

const meter = (el: HTMLElement) => el.querySelector<HTMLElement>("[role=meter]");
const track = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-scale-track");
const mark = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-scale-mark");
const word = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-scale-word");
const text = (el: HTMLElement, selector: string) => el.querySelector(selector)?.textContent;

describe("ScaleBar", () => {
  test("a labelled meter from 0 to 1, valued at the reading's position", async () => {
    const el = await dom.render(
      <ScaleBar
        label="PM2.5"
        value="21 µg/m³"
        bands={BANDS}
        placed={{ band: 1, position: 0.375 }}
      />,
    );
    expect(meter(el)?.getAttribute("aria-label")).toBe("PM2.5");
    expect(meter(el)?.getAttribute("aria-valuemin")).toBe("0");
    expect(meter(el)?.getAttribute("aria-valuemax")).toBe("1");
    expect(meter(el)?.getAttribute("aria-valuenow")).toBe("0.375");
    // The value text is the reading and its band's word, for a screen reader to say.
    expect(meter(el)?.getAttribute("aria-valuetext")).toBe("21 µg/m³, Moderate");
    expect(meter(el)?.className).toBe("ca-scale");
  });

  test("the label, value and word head the track", async () => {
    const el = await dom.render(
      <ScaleBar label="PM2.5" value="21 µg/m³" bands={BANDS} placed={{ band: 1, position: 0.3 }} />,
    );
    expect(text(el, ".ca-scale-label")).toBe("PM2.5");
    expect(text(el, ".ca-scale-value")).toBe("21 µg/m³");
    expect(word(el)?.textContent).toBe("Moderate");
  });

  test("the track is one gradient through the bands, with no element per band", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="160" bands={BANDS} placed={{ band: 3, position: 0.8 }} />,
    );
    expect(el.querySelector(".ca-scale-band")).toBeNull();
    expect(track(el)?.getAttribute("style")).toContain(gradientOf(BANDS));
    // The only thing on the track is the marker.
    expect([...(track(el)?.children ?? [])].map((c) => c.className)).toEqual(["ca-scale-mark"]);
  });

  test("the word takes its band's tone", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="120" bands={BANDS} placed={{ band: 2, position: 0.6 }} />,
    );
    expect(word(el)?.className).toBe("ca-scale-word ca-scale-tone-3");
    expect(word(el)?.textContent).toBe("Sensitive groups");
  });

  test.each([
    [0, "0%"],
    [0.375, "37.5%"],
    [1, "100%"],
  ])("a position of %p puts the marker at %s", async (position, left) => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="1" bands={BANDS} placed={{ band: 0, position }} />,
    );
    expect(mark(el)?.style.left).toBe(left);
  });

  test("with no placed reading there is no marker and no word, but the track is drawn", async () => {
    const el = await dom.render(<ScaleBar label="PM2.5" value="—" bands={BANDS} />);
    expect(mark(el)).toBeNull();
    expect(word(el)).toBeNull();
    expect(track(el)?.children).toHaveLength(0);
    expect(track(el)?.getAttribute("style")).toContain(gradientOf(BANDS));
    expect(text(el, ".ca-scale-value")).toBe("—");
    expect(meter(el)?.className).toBe("ca-scale ca-scale-none");
    expect(meter(el)?.getAttribute("aria-valuenow")).toBe("0");
    expect(meter(el)?.getAttribute("aria-valuetext")).toBe("—");
  });

  test("a band past the list has no word, but the marker still shows", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="9" bands={BANDS} placed={{ band: 9, position: 0.5 }} />,
    );
    expect(word(el)).toBeNull();
    expect(mark(el)?.style.left).toBe("50%");
    expect(meter(el)?.getAttribute("aria-valuetext")).toBe("9");
  });

  test("the track carries the reading's position for the stretch up to it", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="120" bands={BANDS} placed={{ band: 2, position: 0.625 }} />,
    );
    expect(track(el)?.style.getPropertyValue("--scale-at")).toBe("62.5%");
  });

  test("with no placed reading the track carries no position", async () => {
    const el = await dom.render(<ScaleBar label="PM2.5" value="—" bands={BANDS} />);
    expect(track(el)?.style.getPropertyValue("--scale-at")).toBe("");
    expect(track(el)?.getAttribute("style")).not.toContain("--scale-at");
  });

  test("the marker takes its band's tone", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="160" bands={BANDS} placed={{ band: 3, position: 0.8 }} />,
    );
    expect(mark(el)?.style.getPropertyValue("--scale-tone")).toBe("var(--scale-4)");
  });

  test("a band past the list leaves the marker without a tone", async () => {
    const el = await dom.render(
      <ScaleBar label="AQI" value="9" bands={BANDS} placed={{ band: 9, position: 0.5 }} />,
    );
    expect(mark(el)?.style.getPropertyValue("--scale-tone")).toBe("");
    expect(mark(el)?.getAttribute("style")).not.toContain("--scale-tone");
    // The position is the reading's own, so it is still given.
    expect(track(el)?.style.getPropertyValue("--scale-at")).toBe("50%");
  });

  test("className is added to the meter", async () => {
    const el = await dom.render(<ScaleBar label="UV" value="3" bands={BANDS} className="wide" />);
    expect(meter(el)?.className).toBe("ca-scale ca-scale-none wide");
  });
});

describe("gradientOf", () => {
  test("each band's colour is at the middle of its equal share, left to right", () => {
    expect(gradientOf(BANDS)).toBe(
      "linear-gradient(to right, var(--scale-1) 12.5%, var(--scale-2) 37.5%, " +
        "var(--scale-3) 62.5%, var(--scale-4) 87.5%)",
    );
  });

  test("a share that does not divide evenly is given to a tenth of a percent", () => {
    const three = BANDS.slice(0, 3);
    expect(gradientOf(three)).toBe(
      "linear-gradient(to right, var(--scale-1) 16.7%, var(--scale-2) 50.0%, var(--scale-3) 83.3%)",
    );
  });

  test("the colour is the band's tone, not its place in the list", () => {
    const skipping: ScaleBand[] = [
      { label: "Low", tone: 1 },
      { label: "Very high", tone: 5 },
    ];
    expect(gradientOf(skipping)).toBe(
      "linear-gradient(to right, var(--scale-1) 25.0%, var(--scale-5) 75.0%)",
    );
  });

  test("a single band is its colour end to end, and no bands is no gradient", () => {
    // A gradient needs two stops to be valid CSS.
    expect(gradientOf([{ label: "Good", tone: 1 }])).toBe(
      "linear-gradient(to right, var(--scale-1), var(--scale-1))",
    );
    expect(gradientOf([])).toBe("none");
  });
});
