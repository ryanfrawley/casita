import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RangeBar } from "./range-bar.tsx";
import { type DeviceStatus, StatusDot } from "./status-dot.tsx";

describe("StatusDot", () => {
  test("an image named by its status word, focusable so the tooltip can be reached", () => {
    expect(renderToStaticMarkup(<StatusDot status="online" />)).toBe(
      '<span class="ca-status ca-status-online ca-status-md ca-status-tip-top ca-status-align-center" role="img" aria-label="Online" tabindex="0">' +
        '<span class="ca-status-dot" aria-hidden="true"></span>' +
        '<span class="ca-status-tip" aria-hidden="true"><strong>Online</strong></span></span>',
    );
  });

  test("each status has its word", () => {
    for (const [status, word] of [
      ["unavailable", "Unavailable"],
      ["error", "Error"],
      ["disabled", "Disabled"],
    ] as const) {
      const html = renderToStaticMarkup(<StatusDot status={status} />);
      expect(html).toContain(`ca-status-${status} `);
      expect(html).toContain(`aria-label="${word}"`);
    }
  });

  test("a detail joins the accessible name and the tooltip's second line", () => {
    const html = renderToStaticMarkup(<StatusDot status="online" detail="Last seen just now" />);
    expect(html).toContain('aria-label="Online. Last seen just now"');
    expect(html).toContain("<strong>Online</strong><span>Last seen just now</span>");
  });

  test("a label replaces the word", () => {
    const html = renderToStaticMarkup(<StatusDot status="online" label="Asleep" detail="2 h" />);
    expect(html).toContain('aria-label="Asleep. 2 h"');
    expect(html).toContain("<strong>Asleep</strong>");
  });

  test("an unknown status falls back to unavailable", () => {
    for (const status of ["rebooting", "toString"]) {
      const html = renderToStaticMarkup(<StatusDot status={status as DeviceStatus} />);
      expect(html).toContain("ca-status-unavailable");
      expect(html).toContain('aria-label="Unavailable"');
    }
  });

  test("focusable={false} takes it out of the Tab order", () => {
    expect(renderToStaticMarkup(<StatusDot status="online" focusable={false} />)).not.toContain(
      "tabindex",
    );
  });

  test("size, placement, align and className become classes", () => {
    const html = renderToStaticMarkup(
      <StatusDot status="error" size="lg" placement="bottom" align="end" className="x" />,
    );
    expect(html).toContain(
      'class="ca-status ca-status-error ca-status-lg ca-status-tip-bottom ca-status-align-end x"',
    );
  });
});

describe("RangeBar", () => {
  const fill = (html: string) => html.match(/class="ca-rangebar-fill" style="([^"]*)"/)?.[1];
  const mark = (html: string) => html.match(/class="ca-rangebar-mark" style="([^"]*)"/)?.[1];

  test("the fill spans from and to as percentages of the scale", () => {
    const html = renderToStaticMarkup(<RangeBar from={20} to={60} />);
    expect(html).toStartWith('<span class="ca-rangebar ca-rangebar-neutral" role="img"');
    expect(html).toContain('aria-label="20 to 60"');
    expect(fill(html)).toBe("left:20%;width:40%");
    expect(mark(html)).toBeUndefined();
  });

  test("from and to may come in either order", () => {
    expect(fill(renderToStaticMarkup(<RangeBar from={60} to={20} />))).toBe("left:20%;width:40%");
  });

  test("min and max set the scale", () => {
    const html = renderToStaticMarkup(<RangeBar from={15} to={20} min={10} max={30} />);
    expect(fill(html)).toBe("left:25%;width:25%");
  });

  test("the fill is never narrower than 2%", () => {
    expect(fill(renderToStaticMarkup(<RangeBar from={50} to={50} />))).toBe("left:50%;width:2%");
    expect(fill(renderToStaticMarkup(<RangeBar from={50} to={51} />))).toBe("left:50%;width:2%");
  });

  test("values off the scale are clamped to it", () => {
    expect(fill(renderToStaticMarkup(<RangeBar from={-10} to={150} />))).toBe("left:0%;width:100%");
  });

  test("a marker is a tick at its own percentage, clamped too", () => {
    expect(mark(renderToStaticMarkup(<RangeBar from={0} to={10} marker={75} />))).toBe("left:75%");
    expect(mark(renderToStaticMarkup(<RangeBar from={0} to={10} marker={200} />))).toBe(
      "left:100%",
    );
    expect(mark(renderToStaticMarkup(<RangeBar from={0} to={10} marker={0} />))).toBe("left:0%");
  });

  test("a scale with no span does not divide by zero", () => {
    expect(fill(renderToStaticMarkup(<RangeBar from={5} to={5} min={5} max={5} />))).toBe(
      "left:0%;width:2%",
    );
  });

  test("label, tone and className", () => {
    const html = renderToStaticMarkup(
      <RangeBar from={1} to={2} label="Low 1°, high 2°" tone="ember" className="x" />,
    );
    expect(html).toContain('class="ca-rangebar ca-rangebar-ember x"');
    expect(html).toContain('aria-label="Low 1°, high 2°"');
  });
});
