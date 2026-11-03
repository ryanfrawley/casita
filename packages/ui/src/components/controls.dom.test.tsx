// Toggle, Stepper, Slider and Checkbox: the controls that report a value.

import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { Checkbox } from "./checkbox.tsx";
import { Slider } from "./slider.tsx";
import { Stepper } from "./stepper.tsx";
import { Toggle } from "./toggle.tsx";

const dom = setupDom();

describe("Toggle", () => {
  test("a click reports the opposite of `checked`, after onClick", async () => {
    const calls: string[] = [];
    const el = await dom.render(
      <>
        <Toggle
          id="off"
          checked={false}
          onClick={() => calls.push("click")}
          onChange={(v) => calls.push(`off→${v}`)}
        />
        <Toggle id="on" checked onChange={(v) => calls.push(`on→${v}`)} />
      </>,
    );
    const off = el.querySelector("#off");
    expect(off?.getAttribute("role")).toBe("switch");
    expect(off?.getAttribute("aria-checked")).toBe("false");
    expect(off?.className).toBe("ca-toggle ca-toggle-off");
    expect(el.querySelector("#on")?.getAttribute("aria-checked")).toBe("true");

    await dom.click(off);
    await dom.click(el.querySelector("#on"));
    expect(calls).toEqual(["click", "off→true", "on→false"]);
  });

  test("while pending a click does nothing; it is busy and spins", async () => {
    const calls: unknown[] = [];
    const el = await dom.render(
      <Toggle
        checked
        pending
        onClick={() => calls.push("click")}
        onChange={(v) => calls.push(v)}
      />,
    );
    const button = el.querySelector("button");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.className).toBe("ca-toggle ca-toggle-pending");
    expect(button?.querySelector(".ca-spin")).not.toBeNull();
    // Pending shows the confirmed state, not the requested one.
    expect(button?.getAttribute("aria-checked")).toBe("true");
    await dom.click(button);
    expect(calls).toEqual([]);
  });

  test("unavailable is disabled and reports nothing", async () => {
    const calls: unknown[] = [];
    const el = await dom.render(<Toggle unavailable onChange={(v) => calls.push(v)} />);
    const button = el.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.className).toBe("ca-toggle ca-toggle-unavailable");
    await dom.click(button);
    expect(calls).toEqual([]);
  });

  test("disabled is disabled", async () => {
    const el = await dom.render(<Toggle disabled />);
    expect(el.querySelector("button")?.disabled).toBe(true);
  });

  test("a label is tied to the switch and takes the className", async () => {
    const el = await dom.render(<Toggle label="Porch light" className="x" />);
    const field = el.firstElementChild;
    expect(field?.className).toBe("ca-toggle-field x");
    const button = el.querySelector("button");
    expect(button?.className).toBe("ca-toggle ca-toggle-off");
    expect(button?.id).toBeTruthy();
    expect(el.querySelector("label")?.getAttribute("for")).toBe(button?.id ?? "");
  });
});

describe("Stepper", () => {
  function Thermostat({ log, initial = 20 }: { log: number[]; initial?: number }) {
    const [value, setValue] = useState(initial);
    return (
      <Stepper
        label="Set point"
        value={value}
        min={18}
        max={22}
        step={0.5}
        unit="°"
        onChange={(next) => {
          log.push(next);
          setValue(next);
        }}
      />
    );
  }
  const shown = (el: HTMLElement) => el.querySelector("output")?.textContent;
  const button = (el: HTMLElement, name: string) =>
    el.querySelector<HTMLButtonElement>(`[aria-label=${name}]`);

  test("the buttons step down and up", async () => {
    const log: number[] = [];
    const el = await dom.render(<Thermostat log={log} />);
    await dom.click(button(el, "Increase"));
    expect(shown(el)).toBe("20.5°");
    await dom.click(button(el, "Decrease"));
    await dom.click(button(el, "Decrease"));
    expect(shown(el)).toBe("19.5°");
    expect(log).toEqual([20.5, 20, 19.5]);
  });

  test("arrow keys step: Up and Right up, Down and Left down", async () => {
    const log: number[] = [];
    const el = await dom.render(<Thermostat log={log} />);
    const group = el.querySelector("[role=group]");
    for (const key of ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowLeft"]) {
      await dom.key(key, group);
    }
    expect(log).toEqual([20.5, 21, 20.5, 20, 19.5]);
    // A key on a button inside reaches the group too.
    await dom.key("ArrowUp", button(el, "Increase"));
    expect(log.at(-1)).toBe(20);
  });

  test("at max, increase is disabled and stepping up reports nothing", async () => {
    const log: number[] = [];
    const el = await dom.render(<Thermostat log={log} initial={21.5} />);
    await dom.click(button(el, "Increase"));
    expect(shown(el)).toBe("22°");
    expect(button(el, "Increase")?.disabled).toBe(true);
    expect(button(el, "Decrease")?.disabled).toBe(false);
    await dom.key("ArrowUp", el.querySelector("[role=group]"));
    expect(log).toEqual([22]);
  });

  test("at min, decrease is disabled and stepping down reports nothing", async () => {
    const log: number[] = [];
    const el = await dom.render(<Thermostat log={log} initial={18} />);
    expect(button(el, "Decrease")?.disabled).toBe(true);
    await dom.key("ArrowDown", el.querySelector("[role=group]"));
    expect(log).toEqual([]);
  });

  test("while pending it shows and steps from the pending value", async () => {
    const log: number[] = [];
    const el = await dom.render(
      <Stepper value={20} pending pendingValue={21} onChange={(v) => log.push(v)} />,
    );
    expect(shown(el)).toBe("21");
    await dom.click(button(el, "Increase"));
    expect(log).toEqual([22]);
  });

  test("a null value shows the empty text and does not step", async () => {
    const log: number[] = [];
    const el = await dom.render(
      <Stepper value={null} emptyText="Off" onChange={(v) => log.push(v)} />,
    );
    expect(shown(el)).toBe("Off");
    expect(button(el, "Increase")?.disabled).toBe(true);
    expect(button(el, "Decrease")?.disabled).toBe(true);
    await dom.key("ArrowUp", el.querySelector("[role=group]"));
    expect(log).toEqual([]);
  });

  test("disabled does not step by key", async () => {
    const log: number[] = [];
    const el = await dom.render(<Stepper value={5} disabled onChange={(v) => log.push(v)} />);
    await dom.key("ArrowUp", el.querySelector("[role=group]"));
    expect(log).toEqual([]);
  });
});

describe("Slider", () => {
  const fire = (el: Element | null | undefined, event: Event) =>
    dom.act(() => {
      el?.dispatchEvent(event);
    });

  test("uncontrolled: a change moves the shown value and reports it", async () => {
    const changes: number[] = [];
    const el = await dom.render(
      <Slider label="Brightness" defaultValue={40} onChange={(v) => changes.push(v)} />,
    );
    const input = el.querySelector<HTMLInputElement>("input[type=range]");
    expect(el.querySelector(".ca-slider-value")?.textContent).toBe("40%");
    await dom.type(input, "55");
    expect(changes).toEqual([55]);
    expect(el.querySelector(".ca-slider-value")?.textContent).toBe("55%");
    expect(input?.getAttribute("aria-valuetext")).toBe("55%");
    expect(input?.getAttribute("style")).toMatch(/--pct: 55(\.0*\d*)?%/);
  });

  test("controlled: a change is reported but the shown value follows `value`", async () => {
    const changes: number[] = [];
    const el = await dom.render(
      <Slider label="Brightness" value={40} onChange={(v) => changes.push(v)} />,
    );
    await dom.type(el.querySelector("input"), "70");
    expect(changes).toEqual([70]);
    expect(el.querySelector(".ca-slider-value")?.textContent).toBe("40%");
  });

  test("letting go of the thumb, by pointer or key, commits the value", async () => {
    const commits: number[] = [];
    const el = await dom.render(
      <Slider ariaLabel="Brightness" defaultValue={40} onCommit={(v) => commits.push(v)} />,
    );
    const input = el.querySelector("input");
    await dom.type(input, "62");
    expect(commits).toEqual([]);
    await fire(input, new Event("pointerup", { bubbles: true }));
    expect(commits).toEqual([62]);
    await fire(input, new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
    expect(commits).toEqual([62, 62]);
  });

  test("level read is a meter with no input to move", async () => {
    const el = await dom.render(<Slider label="Battery" value={64} level="read" />);
    expect(el.querySelector("input")).toBeNull();
    const meter = el.querySelector("[role=meter]");
    expect(meter?.getAttribute("aria-valuenow")).toBe("64");
    expect(meter?.getAttribute("aria-label")).toBe("Battery");
  });

  test("unavailable shows the word and its input cannot be used", async () => {
    const el = await dom.render(<Slider label="Brightness" value={40} unavailable />);
    expect(el.querySelector(".ca-slider-value")?.textContent).toBe("Unavailable");
    expect(el.querySelector("input")?.disabled).toBe(true);
  });
});

describe("Checkbox", () => {
  test("indeterminate is set on the input element, and cleared again", async () => {
    let setMixed: (on: boolean) => void = () => {};
    function Mixed() {
      const [mixed, set] = useState(true);
      setMixed = set;
      return <Checkbox label="All lights" indeterminate={mixed} />;
    }
    const el = await dom.render(<Mixed />);
    const input = el.querySelector("input");
    expect(input?.indeterminate).toBe(true);
    await dom.act(() => setMixed(false));
    expect(input?.indeterminate).toBe(false);
  });

  test("a click reports the new checked state and the event", async () => {
    const calls: [boolean, string | undefined][] = [];
    function Box() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          id="cb-click"
          label="Notify me"
          checked={checked}
          onChange={(next, event) => {
            calls.push([next, event.target.id]);
            setChecked(next);
          }}
        />
      );
    }
    const el = await dom.render(<Box />);
    const input = el.querySelector("input");
    await dom.click(input);
    expect(input?.checked).toBe(true);
    await dom.click(input);
    expect(input?.checked).toBe(false);
    expect(calls).toEqual([
      [true, "cb-click"],
      [false, "cb-click"],
    ]);
  });

  test("a label and hint are tied to the input", async () => {
    const el = await dom.render(<Checkbox label="Notify me" hint="By email" />);
    const input = el.querySelector("input");
    expect(el.querySelector("label")?.getAttribute("for")).toBe(input?.id ?? "");
    const hint = el.querySelector(".ca-cb-hint");
    expect(hint?.textContent).toBe("By email");
    expect(input?.getAttribute("aria-describedby")).toBe(hint?.id ?? "");
  });

  test("disabled marks the field and the input", async () => {
    const el = await dom.render(<Checkbox disabled />);
    expect(el.firstElementChild?.className).toBe("ca-cb-field ca-cb-disabled");
    expect(el.querySelector("input")?.disabled).toBe(true);
    expect(el.querySelector("label")).toBeNull();
  });
});
