import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { LevelMeter } from "./level-meter.tsx";

const alertIcon = renderToStaticMarkup(<Icon name="triangle-alert" size={14} />);
const offlineIcon = renderToStaticMarkup(<Icon name="wifi-off" size={14} />);

describe("LevelMeter", () => {
  test("a meter with its range, value and label", () => {
    const html = renderToStaticMarkup(
      <LevelMeter label="Battery" value={64} entityId="sensor.car_battery" status="Charging" />,
    );
    expect(html).toMatch(
      /^<div class="ca-meter ca-meter-ok" role="meter" aria-label="Battery" aria-valuemin="0" aria-valuemax="100" aria-valuenow="64" aria-valuetext="64%">/,
    );
    expect(html).toContain('<div class="ca-meter-label">Battery</div>');
    expect(html).toContain('<code class="ca-mono ca-meter-id">sensor.car_battery</code>');
    expect(html).toContain('<div class="ca-meter-value">64<span>%</span></div>');
    expect(html).toContain('<div class="ca-meter-fill" style="width:64%"></div>');
    expect(html).toContain('<span class="ca-meter-status">Charging</span>');
    expect(html).not.toContain("ca-meter-target");
  });

  test("a null value is unavailable: the word, a dash, no fill, no aria-valuenow", () => {
    const html = renderToStaticMarkup(<LevelMeter label="Battery" value={null} target={80} />);
    expect(html).toContain('class="ca-meter ca-meter-unavailable"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('aria-valuetext="Unavailable"');
    expect(html).toContain('<div class="ca-meter-value">—</div>');
    expect(html).not.toContain("ca-meter-fill");
    expect(html).toContain(`<span class="ca-meter-status">${offlineIcon}Unavailable</span>`);
    // The target still has its tick: it is a setting, not a reading.
    expect(html).toContain("ca-meter-target");
  });

  test("zero is a reading, not unavailable", () => {
    const html = renderToStaticMarkup(<LevelMeter label="Tank" value={0} />);
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('<div class="ca-meter-value">0<span>%</span></div>');
    expect(html).toContain('style="width:0%"');
  });

  test("at or below the low threshold it reads Low with the alert icon", () => {
    for (const value of [20, 12]) {
      const html = renderToStaticMarkup(
        <LevelMeter label="Battery" value={value} low={20} status="Charging" tone="sky" />,
      );
      expect(html).toContain('class="ca-meter ca-meter-low"');
      expect(html).toContain(`<span class="ca-meter-status">${alertIcon}Low</span>`);
      expect(html).not.toContain("Charging");
    }
  });

  test("above the low threshold it keeps its tone and status", () => {
    const html = renderToStaticMarkup(
      <LevelMeter label="Battery" value={21} low={20} status="Charging" tone="sky" />,
    );
    expect(html).toContain('class="ca-meter ca-meter-sky"');
    expect(html).toContain('<span class="ca-meter-status">Charging</span>');
    expect(html).not.toContain(alertIcon);
  });

  test("no status leaves an empty spacer in the foot", () => {
    expect(renderToStaticMarkup(<LevelMeter label="x" value={50} />)).toContain(
      '<div class="ca-meter-foot"><span></span></div>',
    );
  });

  test("the target is a tick at its place on the scale, labelled, and in the value text", () => {
    const html = renderToStaticMarkup(
      <LevelMeter label="Battery" value={64} target={80} targetLabel="Charge limit" />,
    );
    expect(html).toContain('<div class="ca-meter-target" style="left:80%"></div>');
    expect(html).toContain('<span class="ca-meter-tlabel">Charge limit 80%</span>');
    expect(html).toContain('aria-valuetext="64%, Charge limit 80%"');
  });

  test('the target label defaults to "Target"', () => {
    expect(renderToStaticMarkup(<LevelMeter label="x" value={40} target={55} />)).toContain(
      '<span class="ca-meter-tlabel">Target 55%</span>',
    );
  });

  test("a custom range and unit place the fill and tick on that range", () => {
    const html = renderToStaticMarkup(
      <LevelMeter label="Tank" value={150} min={100} max={300} target={250} unit=" L" />,
    );
    expect(html).toContain('aria-valuemin="100" aria-valuemax="300" aria-valuenow="150"');
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('style="left:75%"');
    expect(html).toContain('aria-valuetext="150 L, Target 250 L"');
  });

  test("the fill and tick are kept within the track", () => {
    const html = renderToStaticMarkup(<LevelMeter label="x" value={140} target={-10} />);
    expect(html).toContain('class="ca-meter-fill" style="width:100%"');
    expect(html).toContain('class="ca-meter-target" style="left:0%"');
  });

  test("className is added", () => {
    expect(renderToStaticMarkup(<LevelMeter label="x" value={1} className="y" />)).toContain(
      'class="ca-meter ca-meter-ok y"',
    );
  });
});
