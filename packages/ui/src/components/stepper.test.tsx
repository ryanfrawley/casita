import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Stepper, stepValue } from "./stepper.tsx";

describe("stepValue", () => {
  test("moves one whole step by default", () => {
    expect(stepValue(20, 1, {})).toBe(21);
    expect(stepValue(20, -1, {})).toBe(19);
    expect(stepValue(-1, -1, {})).toBe(-2);
  });

  test("half steps land on exact halves, never 20.499999", () => {
    let value = 25;
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) {
      value = stepValue(value, -1, { step: 0.5 });
      seen.push(value);
    }
    expect(seen).toEqual([24.5, 24, 23.5, 23, 22.5, 22, 21.5, 21, 20.5]);
    expect(stepValue(20, 1, { step: 0.5 })).toBe(20.5);
    expect(stepValue(-0.5, -1, { step: 0.5 })).toBe(-1);
  });

  test("tenths carry no floating-point error", () => {
    // 0.2 + 0.1 is 0.30000000000000004 in plain arithmetic.
    expect(stepValue(0.2, 1, { step: 0.1 })).toBe(0.3);
    let value = 0;
    for (let i = 0; i < 10; i++) value = stepValue(value, 1, { step: 0.1 });
    expect(value).toBe(1);
  });

  test("a value off the grid snaps onto it", () => {
    expect(stepValue(20.2, 1, { step: 0.5 })).toBe(20.5);
    expect(stepValue(18, 1, { step: 5 })).toBe(25);
    expect(stepValue(22, -1, { step: 5 })).toBe(15);
  });

  test("is kept within min and max", () => {
    expect(stepValue(30, 1, { max: 30 })).toBe(30);
    expect(stepValue(29.5, 1, { max: 30 })).toBe(30);
    expect(stepValue(10, -1, { min: 10 })).toBe(10);
    expect(stepValue(10.4, -1, { min: 10, step: 0.5 })).toBe(10);
    expect(stepValue(50, 1, { min: 0, max: 30 })).toBe(30);
  });
});

describe("Stepper markup", () => {
  const html = (node: Parameters<typeof Stepper>[0]) => renderToStaticMarkup(<Stepper {...node} />);
  const output = (markup: string) => markup.match(/<output[^>]*>([^<]*)<\/output>/)?.[1];

  test("is a labelled group of decrease, the value, and increase", () => {
    const markup = html({ value: 20, label: "Set point", unit: "°", min: 10, max: 30 });
    expect(markup).toStartWith('<div class="ca-stepper ca-stepper-md" role="group"');
    expect(markup).toContain('aria-label="Set point"');
    expect(markup).toContain('aria-label="Decrease"');
    expect(markup).toContain('aria-label="Increase"');
    expect(markup).toContain('aria-live="polite"');
    expect(output(markup)).toBe("20°");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("aria-busy");
  });

  test("a value at min disables decrease; at max, increase", () => {
    const low = html({ value: 10, min: 10, max: 30 });
    expect(low).toMatch(/aria-label="Decrease" disabled=""/);
    expect(low).not.toMatch(/aria-label="Increase" disabled/);
    const high = html({ value: 30, min: 10, max: 30 });
    expect(high).toMatch(/aria-label="Increase" disabled=""/);
    expect(high).not.toMatch(/aria-label="Decrease" disabled/);
  });

  test("a null value shows the empty text, disables both buttons, and is off", () => {
    const markup = html({ value: null });
    expect(output(markup)).toBe("—");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("ca-stepper-off");
    expect(output(html({ value: null, emptyText: "Not set" }))).toBe("Not set");
  });

  test("while pending it shows the requested value, a spinner, and is busy", () => {
    const markup = html({ value: 20, pending: true, pendingValue: 22, unit: "°" });
    expect(output(markup)).toBe("22°");
    expect(markup).toContain("ca-stepper-pending");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('title="Waiting for the device"');
    expect(markup).toContain("ca-spin");
  });

  test("pending without a pending value keeps the confirmed value", () => {
    expect(output(html({ value: 20, pending: true }))).toBe("20");
  });

  test("showSpinner={false} leaves the spinner out while pending", () => {
    const markup = html({ value: 20, pending: true, pendingValue: 22, showSpinner: false });
    expect(markup).not.toContain("ca-stepper-spin");
  });

  test("disabled turns both buttons off", () => {
    const markup = html({ value: 20, disabled: true });
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain("ca-stepper-off");
  });

  test("decimal steps show the step's precision without trailing float noise", () => {
    expect(output(html({ value: 20.5, step: 0.5, unit: "°" }))).toBe("20.5°");
    expect(output(html({ value: 0.30000000000000004, step: 0.1 }))).toBe("0.3");
  });

  test("formatValue writes the value", () => {
    expect(output(html({ value: 90, formatValue: (v) => `${v / 60}h` }))).toBe("1.5h");
  });

  test("the value box is as wide as the longest value in range", () => {
    expect(html({ value: 20, min: 10, max: 30, unit: "°" })).toContain("width:calc(3ch + 8px)");
    // With half steps the widest value is one step under max: "29.5°".
    expect(html({ value: 20, min: 10, max: 30, step: 0.5, unit: "°" })).toContain(
      "width:calc(5ch + 8px)",
    );
  });

  test("size and className add classes", () => {
    expect(html({ value: 1, size: "sm", className: "x" })).toStartWith(
      '<div class="ca-stepper ca-stepper-sm x"',
    );
  });
});
