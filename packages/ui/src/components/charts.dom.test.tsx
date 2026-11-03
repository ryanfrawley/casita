// Reading a chart by keyboard. Times are built from local-time parts and the expected text comes
// from the same formatters the charts use, so these hold in any zone and locale.

import { describe, expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { formatClock, formatDuration, formatWhen } from "../time.ts";
import { StateTimeline, type TimeSeries, TimeSeriesChart } from "./charts.tsx";

const dom = setupDom();

const at = (hour: number, minute = 0) => new Date(2026, 6, 15, hour, minute).getTime();
const temp: TimeSeries = {
  label: "Temperature",
  points: [
    [at(6), 19.5],
    [at(7), 20],
    [at(8), 21],
  ],
};
const target: TimeSeries = {
  label: "Target",
  step: true,
  points: [
    [at(6), 19],
    [at(7, 30), 21],
  ],
};

const tipRows = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-tip-row")].map((row) => [
    row.querySelector("strong")?.textContent,
    row.querySelector("span:last-child")?.textContent,
  ]);

describe("TimeSeriesChart", () => {
  async function chart() {
    const el = await dom.render(
      <TimeSeriesChart
        label="Living room"
        unit="°"
        series={[temp, target]}
        bands={[{ from: at(7), to: at(8), tone: "heat", label: "Heating" }]}
      />,
    );
    const svg = el.querySelector("svg");
    // happy-dom has no layout, so the chart draws at its fallback width.
    expect(svg?.getAttribute("width")).toBe("640");
    // Focusing this chart blurs the last test's, which updates it: so inside act.
    await dom.act(() => (svg as unknown as HTMLElement | null)?.focus());
    return { el, svg };
  }

  test("ArrowLeft from nothing reads the second-last time, listing every series", async () => {
    const { el, svg } = await chart();
    expect(el.querySelector(".ca-tip")).toBeNull();
    await dom.key("ArrowLeft", svg);
    const tip = el.querySelector(".ca-tip");
    expect(tip?.getAttribute("role")).toBe("status");
    // Times on the axis: 6:00, 7:00, 7:30, 8:00.
    expect(tip?.querySelector(".ca-tip-head")?.textContent).toBe(formatWhen(at(7, 30)));
    expect(tipRows(el)).toEqual([
      ["20.0°", "Temperature"],
      ["21.0°", "Target"],
      ["Heating", ""],
    ]);
    expect(el.querySelector(".ca-crosshair")).not.toBeNull();
  });

  test("the arrows walk the times and stop at either end", async () => {
    const { el, svg } = await chart();
    for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft"]) {
      await dom.key(key, svg);
    }
    expect(el.querySelector(".ca-tip-head")?.textContent).toBe(formatWhen(at(6)));
    // Before the band: no band row; the stepped target is the value in force.
    expect(tipRows(el)).toEqual([
      ["19.5°", "Temperature"],
      ["19.0°", "Target"],
    ]);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]) {
      await dom.key(key, svg);
    }
    expect(el.querySelector(".ca-tip-head")?.textContent).toBe(formatWhen(at(8)));
    expect(tipRows(el)).toEqual([
      ["21.0°", "Temperature"],
      ["21.0°", "Target"],
      ["Heating", ""],
    ]);
  });

  test("Escape hides the tooltip", async () => {
    const { el, svg } = await chart();
    await dom.key("ArrowRight", svg);
    expect(el.querySelector(".ca-tip")).not.toBeNull();
    await dom.key("Escape", svg);
    expect(el.querySelector(".ca-tip")).toBeNull();
    expect(el.querySelector(".ca-crosshair")).toBeNull();
  });

  test("moving focus away hides the tooltip", async () => {
    const { el, svg } = await chart();
    await dom.key("ArrowRight", svg);
    expect(el.querySelector(".ca-tip")).not.toBeNull();
    await dom.act(() => (svg as unknown as HTMLElement | null)?.blur());
    expect(el.querySelector(".ca-tip")).toBeNull();
  });

  test("other keys do nothing", async () => {
    const { el, svg } = await chart();
    await dom.key("ArrowUp", svg);
    await dom.key("Enter", svg);
    expect(el.querySelector(".ca-tip")).toBeNull();
  });

  test("an unavailable reading reads Unavailable", async () => {
    const el = await dom.render(
      <TimeSeriesChart
        series={[
          {
            label: "Humidity",
            points: [
              [at(6), 40],
              [at(7), null],
            ],
          },
        ]}
      />,
    );
    await dom.key("ArrowRight", el.querySelector("svg"));
    expect(tipRows(el)).toEqual([["Unavailable", "Humidity"]]);
  });
});

describe("StateTimeline", () => {
  test("focusing a segment shows when it ran and for how long; leaving hides it", async () => {
    const el = await dom.render(
      <StateTimeline
        label="Porch light"
        xDomain={[at(6), at(12)]}
        segments={[
          { from: at(6), to: at(7, 30), state: "on" },
          { from: at(9), state: "off" },
        ]}
      />,
    );
    const [first, open] = el.querySelectorAll(".ca-seg-hit");
    await dom.act(() => {
      first?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(el.querySelector(".ca-tip-head")?.textContent).toBe("Porch light");
    expect(tipRows(el)).toEqual([
      ["On", `${formatClock(at(6))} – ${formatClock(at(7, 30))} · ${formatDuration(90 * 6e4)}`],
    ]);
    expect(first?.querySelector(".ca-seg-ring")?.getAttribute("class")).toBe(
      "ca-seg-ring ca-seg-hover",
    );

    await dom.act(() => {
      first?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      open?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    // An open segment runs to the end of the range and says "now".
    expect(tipRows(el)).toEqual([["Off", `${formatClock(at(9))} – now · 3h`]]);

    await dom.act(() => {
      open?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(el.querySelector(".ca-tip")).toBeNull();
  });
});
