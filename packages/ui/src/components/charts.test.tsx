// Charts as markup, at their fallback widths: the server renderer has no layout to measure.
// The arithmetic (ticks, paths, time in state) is tested in chart-math.test.ts; these test what
// the components draw from it. Times are built from local-time parts and read back through the
// same formatters the charts use, so the tests hold in any zone and locale.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatClock } from "../time.ts";
import {
  ChartFrame,
  ChartLegend,
  StateHistoryCard,
  StateTimeline,
  TimeAxis,
  type TimeSeries,
  TimeSeriesCard,
  TimeSeriesChart,
  timeSeriesLegend,
} from "./charts.tsx";

// The width hook is a layout effect, which the server renderer warns about; expected here.
const consoleError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
    consoleError(...args);
  };
});
afterAll(() => {
  console.error = consoleError;
});

/** A mid-July day (no daylight-saving change in either hemisphere), at a local hour. */
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

const paths = (html: string) =>
  [...html.matchAll(/<path d="([^"]*)" class="ca-line" style="stroke:([^"]*)"/g)].map((m) => ({
    d: m[1] ?? "",
    stroke: m[2],
  }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("ChartLegend", () => {
  test("a list of keys, line by default, with the colour as --key", () => {
    expect(
      renderToStaticMarkup(
        <ChartLegend
          className="x"
          items={[
            { label: "Temperature", fill: "var(--series-1)" },
            { label: "Offline", fill: "var(--unavailable)", shape: "hatch" },
          ]}
        />,
      ),
    ).toBe(
      '<ul class="ca-legend x">' +
        '<li><span class="ca-key ca-key-line" style="--key:var(--series-1)"></span>Temperature</li>' +
        '<li><span class="ca-key ca-key-hatch" style="--key:var(--unavailable)"></span>Offline</li></ul>',
    );
  });
});

describe("ChartFrame", () => {
  test("a figure with title, subtitle, legend, then the chart", () => {
    expect(
      renderToStaticMarkup(
        <ChartFrame title="Living room" subtitle="Last 24 hours" legend={[{ label: "A" }]}>
          <svg />
        </ChartFrame>,
      ),
    ).toBe(
      '<figure class="ca-chart"><figcaption class="ca-chart-head"><div class="ca-chart-titles">' +
        '<div class="ca-chart-title">Living room</div><div class="ca-chart-sub">Last 24 hours</div>' +
        '</div></figcaption><ul class="ca-legend"><li><span class="ca-key ca-key-line"></span>A</li></ul>' +
        "<svg></svg></figure>",
    );
  });

  test("no legend when it is empty or null, and no titles when not given", () => {
    const html = renderToStaticMarkup(<ChartFrame legend={[]} className="y" />);
    expect(html).not.toContain("ca-legend");
    expect(html).not.toContain('class="ca-chart-title"');
    expect(html).not.toContain('class="ca-chart-sub"');
    expect(html).toContain('<figure class="ca-chart y">');
    expect(renderToStaticMarkup(<ChartFrame legend={null} />)).not.toContain("ca-legend");
  });
});

describe("TimeSeriesChart", () => {
  test("a focusable image named by its label, telling the keyboard what to do", () => {
    const html = renderToStaticMarkup(<TimeSeriesChart label="Living room" series={[temp]} />);
    expect(html).toContain(
      '<svg width="640" height="240" tabindex="0" role="img" aria-label="Living room. Use left and right arrows to read values.">',
    );
    expect(html).toMatch(/^<div class="ca-plot ca-tsc" style="height:240px">/);
    expect(renderToStaticMarkup(<TimeSeriesChart series={[temp]} />)).toContain(
      'aria-label="Chart. Use left and right arrows to read values."',
    );
  });

  test("draws at most three series", () => {
    const four = [1, 2, 3, 4].map(
      (n): TimeSeries => ({
        label: `S${n}`,
        points: [
          [at(6), n * 10],
          [at(8), n * 10 + 1],
        ],
      }),
    );
    const html = renderToStaticMarkup(<TimeSeriesChart series={four} directLabels={false} />);
    expect(paths(html).map((p) => p.stroke)).toEqual([
      "var(--series-1)",
      "var(--series-2)",
      "var(--series-3)",
    ]);
    // The fourth series' values are not drawn and do not stretch the y range.
    expect(html).not.toContain(">40<");
  });

  test("a measured line is drawn with L, a stepped one with H and V, carried to the right edge", () => {
    const [measured, stepped] = paths(
      renderToStaticMarkup(<TimeSeriesChart series={[temp, target]} />),
    );
    expect(measured?.d).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){2}$/);
    expect(stepped?.d).toMatch(/^M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+$/);
    // The step runs on to where the measured line ends: the last time on the axis.
    const lastX = measured?.d.match(/L([\d.]+) [\d.]+$/)?.[1];
    expect(stepped?.d.endsWith(`H${lastX}`)).toBe(true);
  });

  test("a series' own colour is used over its place", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart series={[{ ...temp, color: "series-3" }]} />,
    );
    expect(paths(html)[0]?.stroke).toBe("var(--series-3)");
  });

  test("a null value breaks the line: a second M, not a line across the gap", () => {
    const gappy: TimeSeries = {
      label: "Humidity",
      points: [
        [at(6), 40],
        [at(7), 42],
        [at(8), null],
        [at(9), 45],
        [at(10), 46],
      ],
    };
    const d = paths(renderToStaticMarkup(<TimeSeriesChart series={[gappy]} />))[0]?.d ?? "";
    expect(count(d, "M")).toBe(2);
    expect(count(d, "L")).toBe(2);
    expect(d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  });

  test("points are drawn in time order whatever order they came in", () => {
    const shuffled: TimeSeries = {
      label: "x",
      points: [
        { t: at(8), v: 3 },
        { t: at(6), v: 1 },
        { t: at(7), v: 2 },
      ],
    };
    const d = paths(renderToStaticMarkup(<TimeSeriesChart series={[shuffled]} />))[0]?.d ?? "";
    const xs = [...d.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  test("bands are shaded in their tone; an unavailable band is filled with the hatch", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        series={[temp]}
        bands={[
          { from: at(6), to: at(7), tone: "heat", label: "Heating" },
          { from: at(7, 30), tone: "unavailable", label: "Offline" },
        ]}
      />,
    );
    expect(count(html, 'class="ca-band"')).toBe(2);
    expect(html).toContain('class="ca-band" style="fill:var(--ember)"');
    const hatch = html.match(/<pattern id="([^"]+)"/)?.[1];
    expect(hatch).toBeTruthy();
    expect(html).toContain(`class="ca-band" style="fill:url(#${hatch})"`);
  });

  test("an open band runs to the right edge; a band outside the range has no width", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        series={[temp]}
        directLabels={false}
        bands={[
          { from: at(7), tone: "cool" },
          { from: at(1), to: at(2), tone: "heat" },
        ]}
      />,
    );
    const rects = [...html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)];
    const right = html.match(/class="ca-baseline"/) && html.match(/<line x1="44" x2="([\d.]+)"/);
    const [open, outside] = rects;
    expect(Number(open?.[1]) + Number(open?.[2])).toBeCloseTo(Number(right?.[1]), 5);
    expect(Number(outside?.[2])).toBe(0);
  });

  test("each line's last value and name sit at its end, unless they would collide", () => {
    const low: TimeSeries = { label: "Target", step: true, points: [[at(6), 19]] };
    const apart = renderToStaticMarkup(<TimeSeriesChart series={[temp, low]} unit="°" />);
    expect(apart).toContain(
      '<text class="ca-endval" dominant-baseline="middle" y="-6">21.0°</text>',
    );
    expect(apart).toContain(
      '<text class="ca-endval" dominant-baseline="middle" y="-6">19.0°</text>',
    );
    expect(apart).toContain(
      '<text class="ca-endlab" dominant-baseline="middle" y="9">Target</text>',
    );
    expect(count(apart, "ca-endlab")).toBe(2);

    // temp and target both end at 21: their labels would overlap.
    expect(renderToStaticMarkup(<TimeSeriesChart series={[temp, target]} />)).not.toContain(
      "ca-endval",
    );
    expect(
      renderToStaticMarkup(<TimeSeriesChart series={[temp]} directLabels={false} />),
    ).not.toContain("ca-endval");
  });

  test("a measured line ends with a dot; a stepped line does not", () => {
    expect(count(renderToStaticMarkup(<TimeSeriesChart series={[temp]} />), "ca-dot")).toBe(1);
    expect(count(renderToStaticMarkup(<TimeSeriesChart series={[target]} />), "ca-dot")).toBe(0);
  });

  test("formatValue writes the end labels", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart series={[temp]} formatValue={(v) => `${v} degrees`} />,
    );
    expect(html).toContain(">21 degrees</text>");
  });

  test("a flat series gets a usable y range, drawn mid-plot", () => {
    const flat: TimeSeries = {
      label: "Flat",
      points: [
        [at(6), 20],
        [at(8), 20],
      ],
    };
    const html = renderToStaticMarkup(<TimeSeriesChart series={[flat]} directLabels={false} />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    const ys = [...(paths(html)[0]?.d ?? "").matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    // Not on the baseline (212) nor the top (12).
    for (const y of ys) {
      expect(y).toBeGreaterThan(12);
      expect(y).toBeLessThan(212);
    }
  });

  test("an empty series, or none, still draws a chart", () => {
    for (const series of [[], [{ label: "Nothing", points: [] }]]) {
      const html = renderToStaticMarkup(<TimeSeriesChart series={series} />);
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
      expect(html).toContain('role="img"');
    }
  });

  test("yDomain fixes the range and its ticks stay inside it", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart series={[temp]} yDomain={[15, 25]} directLabels={false} />,
    );
    const ticks = [...html.matchAll(/text-anchor="end" dominant-baseline="middle">([^<]+)</g)].map(
      (m) => Number(m[1]),
    );
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(15);
      expect(tick).toBeLessThanOrEqual(25);
    }
  });

  test("a short unit is written on the y axis; a long one is not", () => {
    expect(renderToStaticMarkup(<TimeSeriesChart series={[temp]} unit="°" />)).toMatch(
      /dominant-baseline="middle">20°</,
    );
    expect(renderToStaticMarkup(<TimeSeriesChart series={[temp]} unit=" kWh" />)).toMatch(
      /dominant-baseline="middle">20</,
    );
  });

  test("no tooltip until it is asked for", () => {
    const html = renderToStaticMarkup(<TimeSeriesChart series={[temp]} />);
    expect(html).not.toContain("ca-tip");
    expect(html).not.toContain("ca-crosshair");
  });
});

describe("timeSeriesLegend", () => {
  test("a key per series, at most three, step or line by kind", () => {
    const four = [temp, target, { label: "C", points: [] }, { label: "D", points: [] }];
    expect(timeSeriesLegend(four)).toEqual([
      { label: "Temperature", fill: "var(--series-1)", shape: "line" },
      { label: "Target", fill: "var(--series-2)", shape: "step" },
      { label: "C", fill: "var(--series-3)", shape: "line" },
    ]);
  });

  test("labelled bands follow, once per label; unavailable is a hatch", () => {
    expect(
      timeSeriesLegend(
        [temp],
        [
          { from: at(6), to: at(7), tone: "heat", label: "Heating" },
          { from: at(7), to: at(8), tone: "unavailable", label: "Offline" },
          { from: at(8), to: at(9), tone: "heat", label: "Heating" },
          { from: at(9), tone: "cool" },
        ],
      ),
    ).toEqual([
      { label: "Temperature", fill: "var(--series-1)", shape: "line" },
      { label: "Heating", fill: "var(--ember)", shape: "band" },
      { label: "Offline", fill: "var(--unavailable)", shape: "hatch" },
    ]);
  });

  test("a band labelled like a series adds no second key", () => {
    expect(
      timeSeriesLegend([temp], [{ from: at(6), tone: "heat", label: "Temperature" }]),
    ).toHaveLength(1);
  });
});

describe("TimeSeriesCard", () => {
  test("a single key has no legend", () => {
    const html = renderToStaticMarkup(<TimeSeriesCard title="Living room" series={[temp]} />);
    expect(html).not.toContain("ca-legend");
    expect(html).toContain('<div class="ca-chart-title">Living room</div>');
  });

  test("two or more keys, from series or bands, have a legend", () => {
    expect(renderToStaticMarkup(<TimeSeriesCard series={[temp, target]} />)).toContain(
      'class="ca-legend"',
    );
    expect(
      renderToStaticMarkup(
        <TimeSeriesCard
          series={[temp]}
          bands={[{ from: at(6), tone: "heat", label: "Heating" }]}
        />,
      ),
    ).toContain('class="ca-legend"');
  });

  test("the chart is named by the title unless it has its own label", () => {
    expect(renderToStaticMarkup(<TimeSeriesCard title="Living room" series={[temp]} />)).toContain(
      'aria-label="Living room. Use left and right arrows',
    );
    expect(
      renderToStaticMarkup(<TimeSeriesCard title="Living room" label="Temp" series={[temp]} />),
    ).toContain('aria-label="Temp. Use left and right arrows');
  });

  test("className goes on the card, not the chart", () => {
    const html = renderToStaticMarkup(<TimeSeriesCard series={[temp]} className="x" />);
    expect(html).toContain('<figure class="ca-chart x">');
    expect(html).toContain('<div class="ca-plot ca-tsc" style=');
  });
});

describe("TimeAxis", () => {
  test("is hidden from assistive technology and labels the range", () => {
    const html = renderToStaticMarkup(<TimeAxis xDomain={[at(6), at(12)]} className="x" />);
    expect(html).toMatch(
      /^<div class="ca-taxis x" aria-hidden="true"><svg width="480" height="20">/,
    );
    expect(count(html, 'class="ca-axis"')).toBeGreaterThan(1);
    // The edge labels are anchored so they stay inside.
    expect(html).toContain('x="0" y="14" class="ca-axis" text-anchor="start"');
    expect(html).toContain('x="480" y="14" class="ca-axis" text-anchor="end"');
  });
});

describe("StateTimeline", () => {
  const segments = [
    { from: at(6), to: at(7, 30), state: "on" },
    { from: at(7, 30), to: at(9), state: "off" },
    { from: at(9), state: "on" },
  ];

  test("a group named by its label; each segment a focusable image saying when", () => {
    const html = renderToStaticMarkup(
      <StateTimeline segments={segments} xDomain={[at(6), at(12)]} label="Porch light" />,
    );
    expect(html).toContain('role="group" aria-label="Porch light state history"');
    const labels = [
      ...html.matchAll(/tabindex="0" role="img" class="ca-seg-hit" aria-label="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(labels).toEqual([
      `On from ${formatClock(at(6))} to ${formatClock(at(7, 30))}`,
      `Off from ${formatClock(at(7, 30))} to ${formatClock(at(9))}`,
      `On from ${formatClock(at(9))} to now`,
    ]);
  });

  test("with no label the group is just 'state history'", () => {
    expect(
      renderToStaticMarkup(<StateTimeline segments={segments} xDomain={[at(6), at(12)]} />),
    ).toContain('aria-label="state history"');
  });

  test("each state is drawn in its tone; unavailable with the hatch and an edge", () => {
    const html = renderToStaticMarkup(
      <StateTimeline
        segments={[
          { from: at(6), to: at(8), state: "on" },
          { from: at(8), state: "unavailable" },
        ]}
        xDomain={[at(6), at(12)]}
      />,
    );
    const hatch = html.match(/<pattern id="([^"]+)"/)?.[1];
    expect(html).toContain('class="ca-seg-bar" style="fill:var(--lamp)"');
    expect(html).toContain(`class="ca-seg-bar" style="fill:url(#${hatch})"`);
    expect(count(html, "ca-seg-edge")).toBe(1);
    expect(html).toContain(`aria-label="Unavailable from ${formatClock(at(8))} to now"`);
  });

  test("an unknown state is labelled by its key and drawn as off", () => {
    const html = renderToStaticMarkup(
      <StateTimeline segments={[{ from: at(6), state: "jammed" }]} xDomain={[at(6), at(12)]} />,
    );
    expect(html).toContain(`aria-label="jammed from ${formatClock(at(6))} to now"`);
    expect(html).toContain('class="ca-seg-bar" style="fill:var(--line)"');
  });

  test("custom states add to the known ones and can rename them", () => {
    const html = renderToStaticMarkup(
      <StateTimeline
        segments={[
          { from: at(6), to: at(8), state: "locked" },
          { from: at(8), to: at(9), state: "unlocked" },
          { from: at(9), state: "on" },
        ]}
        states={{
          locked: { label: "Locked", tone: "ok" },
          unlocked: { label: "Unlocked", tone: "alert" },
          on: { label: "Running", tone: "series-1" },
        }}
        xDomain={[at(6), at(12)]}
      />,
    );
    expect(html).toContain(`aria-label="Locked from ${formatClock(at(6))}`);
    expect(html).toContain(`aria-label="Unlocked from ${formatClock(at(8))}`);
    expect(html).toContain(`aria-label="Running from ${formatClock(at(9))} to now"`);
    expect(html).toContain("fill:var(--sage)");
    expect(html).toContain("fill:var(--danger)");
    expect(html).toContain("fill:var(--series-1)");
  });

  test("segments leave a gap between neighbours, and are clamped to the range", () => {
    const html = renderToStaticMarkup(
      <StateTimeline
        segments={[
          { from: at(3), to: at(9), state: "on" },
          { from: at(9), state: "off" },
        ]}
        xDomain={[at(6), at(12)]}
      />,
    );
    const bars = [
      ...html.matchAll(
        /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="20" rx="[\d.]+" class="ca-seg-bar"/g,
      ),
    ].map((m) => [Number(m[1]), Number(m[2])]);
    // 480px for six hours: the first starts at the left edge and ends 2px short of 9:00.
    expect(bars).toEqual([
      [0, 238],
      [240, 240],
    ]);
  });

  test("grid draws tick lines behind a taller row; axis adds the time labels", () => {
    const plain = renderToStaticMarkup(
      <StateTimeline segments={segments} xDomain={[at(6), at(12)]} />,
    );
    expect(plain).not.toContain("ca-grid");
    expect(plain).not.toContain("ca-taxis");
    const both = renderToStaticMarkup(
      <StateTimeline segments={segments} xDomain={[at(6), at(12)]} grid axis />,
    );
    expect(both).toContain('class="ca-grid"');
    expect(both).toContain('style="height:32px"');
    expect(both).toContain('class="ca-taxis"');
  });
});

describe("StateHistoryCard", () => {
  const rows = [
    {
      label: "Porch light",
      segments: [
        { from: at(6), to: at(7, 30), state: "on" },
        { from: at(7, 30), to: at(9), state: "off" },
        { from: at(9), state: "on" },
      ],
    },
    { id: "hall", label: "Hall light", segments: [{ from: at(6), state: "unavailable" }] },
  ];

  test("a row per entity with its label and time in the summary state, on by default", () => {
    const html = renderToStaticMarkup(
      <StateHistoryCard title="Lights" rows={rows} xDomain={[at(6), at(12)]} />,
    );
    expect(html).toContain('<div class="ca-chart-title">Lights</div>');
    expect(html).toContain('<div class="ca-shc-label">Porch light</div>');
    expect(html).toContain('<div class="ca-shc-label">Hall light</div>');
    // 6:00–7:30 and 9:00 to the range's end at 12:00.
    expect(html).toContain('<div class="ca-shc-sum">On 4h 30m</div>');
    expect(html).toContain('<div class="ca-shc-sum">On 0 min</div>');
    expect(html).toContain("grid-template-columns:152px minmax(0, 1fr) 96px");
    expect(html).toContain('aria-label="Porch light state history"');
  });

  test("summaryState picks the state totalled, by its label", () => {
    const html = renderToStaticMarkup(
      <StateHistoryCard
        rows={rows}
        xDomain={[at(6), at(12)]}
        summaryState="open"
        states={{ open: { label: "Open", tone: "alert" } }}
      />,
    );
    expect(html).toContain('<div class="ca-shc-sum">Open 0 min</div>');
    expect(
      renderToStaticMarkup(
        <StateHistoryCard rows={rows} xDomain={[at(6), at(12)]} summaryState="off" />,
      ),
    ).toContain('<div class="ca-shc-sum">Off 1h 30m</div>');
  });

  test("summaryState={null} shows no totals and no column for them", () => {
    const html = renderToStaticMarkup(
      <StateHistoryCard
        rows={rows}
        xDomain={[at(6), at(12)]}
        summaryState={null}
        labelWidth={120}
      />,
    );
    expect(html).not.toContain("ca-shc-sum");
    expect(html).toContain("grid-template-columns:120px minmax(0, 1fr)");
    expect(html).not.toContain("96px");
  });

  test("the legend lists each state used, once, in order of first use", () => {
    const html = renderToStaticMarkup(<StateHistoryCard rows={rows} xDomain={[at(6), at(12)]} />);
    expect(html).toContain(
      '<ul class="ca-legend">' +
        '<li><span class="ca-key ca-key-rect" style="--key:var(--lamp)"></span>On</li>' +
        '<li><span class="ca-key ca-key-rect" style="--key:var(--line)"></span>Off</li>' +
        '<li><span class="ca-key ca-key-hatch" style="--key:var(--unavailable)"></span>Unavailable</li></ul>',
    );
  });

  test("one shared time axis under the rows", () => {
    const html = renderToStaticMarkup(<StateHistoryCard rows={rows} xDomain={[at(6), at(12)]} />);
    expect(count(html, 'class="ca-taxis"')).toBe(1);
  });
});
