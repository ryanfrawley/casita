import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyChip } from "./copy-chip.tsx";
import { Slider } from "./slider.tsx";

describe("Slider markup", () => {
  test("a labelled range input with its value in the head", () => {
    const html = renderToStaticMarkup(<Slider label="Brightness" defaultValue={40} />);
    const id = html.match(/<label for="([^"]+)"/)?.[1];
    expect(html).toStartWith('<div class="ca-slider ca-slider-lamp"><div class="ca-slider-head">');
    expect(html).toContain('<span class="ca-slider-value">40%</span>');
    expect(html).toContain(`<input id="${id}" type="range" min="0" max="100" step="1"`);
    expect(html).toContain('value="40"');
    expect(html).toContain('aria-valuetext="40%"');
    expect(html).toContain("--pct:40%");
    // The label names it, so it carries no aria-label of its own.
    expect(html).not.toContain("aria-label");
    expect(html).not.toContain("disabled");
  });

  test("without a label it has no head and takes ariaLabel", () => {
    const html = renderToStaticMarkup(<Slider ariaLabel="Volume" defaultValue={10} />);
    expect(html).not.toContain("ca-slider-head");
    expect(html).toContain('aria-label="Volume"');
  });

  test("starts at min when there is no value", () => {
    const html = renderToStaticMarkup(<Slider label="Position" min={10} max={30} />);
    expect(html).toContain('value="10"');
    expect(html).toContain("--pct:0%");
  });

  test("the fill percentage is measured from min to max", () => {
    expect(renderToStaticMarkup(<Slider value={20} min={10} max={30} />)).toContain("--pct:50%");
  });

  test("unit and formatValue write the value, marks included", () => {
    const unit = renderToStaticMarkup(<Slider label="Fan" value={3} unit=" speed" />);
    expect(unit).toContain(">3 speed</span>");
    const html = renderToStaticMarkup(
      <Slider label="Warmth" value={50} marks={[0, 100]} formatValue={(v) => `${v / 10}k`} />,
    );
    expect(html).toContain(">5k</span>");
    expect(html).toContain('<div class="ca-slider-marks"><span>0k</span><span>10k</span></div>');
  });

  test("pending spins and says what it is setting, or the pending text", () => {
    const html = renderToStaticMarkup(<Slider label="Brightness" value={40} pending />);
    expect(html).toContain("ca-slider-pending");
    expect(html).toMatch(
      /<span class="ca-slider-value"><svg[^>]*ca-spin[\s\S]*<\/svg>Setting 40%…<\/span>/,
    );
    expect(
      renderToStaticMarkup(<Slider label="B" value={40} pending pendingText="Waiting" />),
    ).toContain("</svg>Waiting</span>");
  });

  test("unavailable says so, disables the input, and its value text is Unavailable", () => {
    const html = renderToStaticMarkup(<Slider label="Brightness" value={40} unavailable pending />);
    expect(html).toContain("ca-slider-unavailable");
    expect(html).toContain('<span class="ca-slider-value">Unavailable</span>');
    expect(html).toContain('aria-valuetext="Unavailable"');
    expect(html).toContain('disabled=""');
  });

  test("disabled disables the input", () => {
    expect(renderToStaticMarkup(<Slider ariaLabel="x" disabled />)).toContain('disabled=""');
  });

  test("level read draws a meter, with no input and a plain-text label", () => {
    const html = renderToStaticMarkup(
      <Slider label="Battery" value={64} level="read" tone="sky" />,
    );
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<label");
    expect(html).toContain('<span class="ca-slider-label">Battery</span>');
    expect(html).toMatch(
      /<div id="[^"]+" role="meter" class="ca-range-read" style="--pct:64%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="64" aria-valuetext="64%" aria-label="Battery"><span><\/span><\/div>/,
    );
    expect(html).toContain("ca-slider-sky");
  });

  test("a read-only meter without a label is named by ariaLabel", () => {
    expect(renderToStaticMarkup(<Slider ariaLabel="Level" value={1} level="read" />)).toContain(
      'aria-label="Level"',
    );
  });

  test("an unavailable read-only level falls back to a disabled input", () => {
    const html = renderToStaticMarkup(
      <Slider label="Battery" value={64} level="read" unavailable />,
    );
    expect(html).not.toContain('role="meter"');
    expect(html).toContain('type="range"');
    expect(html).toContain('disabled=""');
  });
});

describe("CopyChip markup", () => {
  test("monospace text with a copy button named for the value", () => {
    expect(renderToStaticMarkup(<CopyChip value="light.kitchen" />)).toBe(
      '<span class="ca-copy ca-mono"><span class="ca-copy-text" title="light.kitchen">light.kitchen</span>' +
        `<button type="button" class="ca-copy-btn" aria-label="Copy light.kitchen" title="Copy">${
          renderToStaticMarkup(<CopyChip value="x" />).match(/<svg[\s\S]*<\/svg>/)?.[0]
        }</button><span class="ca-copy-done" role="status"></span></span>`,
    );
  });

  test("children replace the shown text, not what is copied", () => {
    const html = renderToStaticMarkup(<CopyChip value="abc123">Token</CopyChip>);
    expect(html).toContain('<span class="ca-copy-text" title="abc123">Token</span>');
    expect(html).toContain('aria-label="Copy abc123"');
  });

  test("mono={false}, label and className", () => {
    const html = renderToStaticMarkup(
      <CopyChip value="v" mono={false} label="Copy the id" className="x" />,
    );
    expect(html).toStartWith('<span class="ca-copy x">');
    expect(html).toContain('aria-label="Copy the id"');
  });
});
