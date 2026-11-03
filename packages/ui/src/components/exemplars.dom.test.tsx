// SceneButton and Thermostat: what a press reports.

import { describe, expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { SceneButton } from "./scene-button.tsx";
import { Thermostat } from "./thermostat.tsx";

const dom = setupDom();

describe("SceneButton", () => {
  test("a press runs the scene, with the click event", async () => {
    const runs: string[] = [];
    const el = await dom.render(
      <SceneButton name="Movie night" onRun={(e) => runs.push(e.type)} />,
    );
    await dom.click(el.querySelector("button"));
    expect(runs).toEqual(["click"]);
  });

  test("while running a press does nothing; it is busy", async () => {
    let runs = 0;
    const el = await dom.render(
      <SceneButton name="Movie night" state="running" onRun={() => runs++} />,
    );
    const button = el.querySelector("button");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    // Still focusable, so it is not natively disabled.
    expect(button?.disabled).toBe(false);
    await dom.click(button);
    expect(runs).toBe(0);
  });

  test("after an error a press runs it again", async () => {
    let runs = 0;
    const el = await dom.render(<SceneButton name="x" state="error" onRun={() => runs++} />);
    await dom.click(el.querySelector("button"));
    expect(runs).toBe(1);
  });

  test("disabled does not run", async () => {
    let runs = 0;
    const el = await dom.render(<SceneButton name="x" disabled onRun={() => runs++} />);
    await dom.click(el.querySelector("button"));
    expect(runs).toBe(0);
  });
});

describe("Thermostat", () => {
  const button = (el: HTMLElement, name: string) =>
    el.querySelector<HTMLButtonElement>(`[aria-label=${name}]`);

  test("stepping reports the stepped target", async () => {
    const targets: number[] = [];
    const el = await dom.render(
      <Thermostat
        name="Living room"
        current={20}
        target={21.5}
        mode="heat"
        onTargetChange={(next) => targets.push(next)}
      />,
    );
    await dom.click(button(el, "Increase"));
    await dom.click(button(el, "Decrease"));
    await dom.key("ArrowUp", el.querySelector("[role=group]"));
    // Controlled: the shown target stays the confirmed one, so each step is from 21.5.
    expect(targets).toEqual([22, 21, 22]);
  });

  test("a step counts from a target in flight", async () => {
    const targets: number[] = [];
    const el = await dom.render(
      <Thermostat
        name="x"
        current={20}
        target={21}
        pendingTarget={23}
        mode="heat"
        step={1}
        onTargetChange={(next) => targets.push(next)}
      />,
    );
    await dom.click(button(el, "Increase"));
    expect(targets).toEqual([24]);
  });

  test("the target stops at max and min", async () => {
    const targets: number[] = [];
    const el = await dom.render(
      <Thermostat
        name="x"
        current={20}
        target={30}
        mode="heat"
        onTargetChange={(next) => targets.push(next)}
      />,
    );
    expect(button(el, "Increase")?.disabled).toBe(true);
    await dom.click(button(el, "Increase"));
    expect(targets).toEqual([]);
  });

  test("choosing a mode reports it", async () => {
    const modes: string[] = [];
    const el = await dom.render(
      <Thermostat
        name="x"
        current={20}
        target={21}
        mode="heat"
        onModeChange={(mode) => modes.push(mode)}
      />,
    );
    const options = [...el.querySelectorAll("[role=radio]")];
    await dom.click(options.find((o) => o.textContent === "Cool"));
    await dom.click(options.find((o) => o.textContent === "Off"));
    expect(modes).toEqual(["cool", "off"]);
  });

  test("read level has nothing to press", async () => {
    const el = await dom.render(
      <Thermostat name="x" current={20} target={21} mode="heat" level="read" />,
    );
    expect(el.querySelector("button")).toBeNull();
  });
});
