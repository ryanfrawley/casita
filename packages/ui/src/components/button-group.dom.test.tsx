// ButtonGroup: a row of independent buttons, some of which ask for a second press.

import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { ButtonGroup, type ButtonGroupItem } from "./button-group.tsx";

const dom = setupDom();

const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")];
/** The segment at `index`, as a string so the calls read like the others'. */
const segment = (el: HTMLElement, index: string) => buttons(el)[Number(index)];
const labels = (el: HTMLElement) =>
  buttons(el).map((b) => b.querySelector(".ca-bgroup-label")?.textContent);
const armed = (el: HTMLElement) =>
  buttons(el)
    .filter((b) => b.classList.contains("ca-bgroup-armed"))
    .map((b) => b.querySelector(".ca-bgroup-label")?.textContent);

/** Items that record their presses into `presses` by key. */
function itemsWith(presses: string[], overrides: Partial<ButtonGroupItem>[]): ButtonGroupItem[] {
  return overrides.map((extra, i) => {
    const key = extra.key ?? `k${i}`;
    return { key, label: `Item ${i}`, onPress: () => presses.push(key), ...extra };
  });
}

describe("ButtonGroup", () => {
  test("a labelled group with one button per item, pressed as each item is active", async () => {
    const el = await dom.render(
      <ButtonGroup
        label="Doors"
        items={itemsWith(
          [],
          [
            { label: "Left", active: true, icon: "garage" },
            { label: "Right" },
            { label: "Side", active: false },
          ],
        )}
      />,
    );
    const group = el.querySelector("[role=group]");
    expect(group?.getAttribute("aria-label")).toBe("Doors");
    expect(labels(el)).toEqual(["Left", "Right", "Side"]);
    expect(buttons(el).map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(buttons(el)[0]?.className).toBe("ca-bgroup-opt ca-bgroup-on");
    expect(buttons(el)[1]?.className).toBe("ca-bgroup-opt");
    expect(buttons(el)[0]?.querySelector("svg")).not.toBeNull();
    expect(buttons(el)[1]?.querySelector("svg")).toBeNull();
    expect(buttons(el).every((b) => b.getAttribute("type") === "button")).toBe(true);
  });

  test("className is added to the track", async () => {
    const el = await dom.render(<ButtonGroup label="G" className="wide" items={[]} />);
    expect(el.querySelector("[role=group]")?.className).toBe("ca-bgroup wide");
    expect(buttons(el)).toHaveLength(0);
  });

  test("an item without confirm acts on every press", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup label="G" items={itemsWith(presses, [{ key: "a" }, { key: "b" }])} />,
    );
    await dom.click(segment(el, "0"));
    await dom.click(segment(el, "0"));
    await dom.click(segment(el, "1"));
    expect(presses).toEqual(["a", "a", "b"]);
    expect(armed(el)).toEqual([]);
  });

  test("an item with confirm arms on the first press and acts only on the second", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [{ key: "door", label: "Left", confirm: "Close?" }])}
      />,
    );
    const button = segment(el, "0");
    expect(button?.getAttribute("aria-label")).toBeNull();

    await dom.click(button);
    expect(presses).toEqual([]);
    expect(labels(el)).toEqual(["Close?"]);
    expect(button?.classList.contains("ca-bgroup-armed")).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Close? Left");

    await dom.click(button);
    expect(presses).toEqual(["door"]);
    // Acting disarms it: the label is back and a third press only arms again.
    expect(labels(el)).toEqual(["Left"]);
    expect(button?.getAttribute("aria-label")).toBeNull();
    await dom.click(button);
    expect(presses).toEqual(["door"]);
    expect(armed(el)).toEqual(["Close?"]);
  });

  test("pressing another segment moves the arming to it, and acts if it needs no confirm", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [
          { key: "left", label: "Left", confirm: "Close?" },
          { key: "right", label: "Right", confirm: "Open?" },
          { key: "light", label: "Light" },
        ])}
      />,
    );
    await dom.click(segment(el, "0"));
    expect(armed(el)).toEqual(["Close?"]);
    await dom.click(segment(el, "1"));
    expect(armed(el)).toEqual(["Open?"]);
    expect(labels(el)).toEqual(["Left", "Open?", "Light"]);
    expect(presses).toEqual([]);
    // The first segment's arming is gone: pressing it arms it afresh rather than acting.
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
    expect(armed(el)).toEqual(["Close?"]);
    // A one-press segment acts and disarms the others.
    await dom.click(segment(el, "2"));
    expect(presses).toEqual(["light"]);
    expect(armed(el)).toEqual([]);
  });

  test("Escape disarms without acting", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [{ key: "door", label: "Left", confirm: "Close?" }])}
      />,
    );
    const button = segment(el, "0");
    await dom.click(button);
    expect(armed(el)).toEqual(["Close?"]);
    await dom.key("Escape", button);
    expect(armed(el)).toEqual([]);
    expect(labels(el)).toEqual(["Left"]);
    await dom.click(button);
    expect(presses).toEqual([]);
  });

  test("other keys leave the arming alone", async () => {
    const el = await dom.render(
      <ButtonGroup label="G" items={itemsWith([], [{ label: "Left", confirm: "Close?" }])} />,
    );
    await dom.click(segment(el, "0"));
    await dom.key("Enter", segment(el, "0"));
    await dom.key("a", segment(el, "0"));
    expect(armed(el)).toEqual(["Close?"]);
  });

  test("an armed segment disarms after armedMs", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        armedMs={20}
        items={itemsWith(presses, [{ key: "door", label: "Left", confirm: "Close?" }])}
      />,
    );
    await dom.click(segment(el, "0"));
    expect(armed(el)).toEqual(["Close?"]);
    await dom.act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(armed(el)).toEqual([]);
    expect(labels(el)).toEqual(["Left"]);
    // The press after the timeout is a first press again.
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
    expect(armed(el)).toEqual(["Close?"]);
  });

  test("a second press before armedMs still acts", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        armedMs={200}
        items={itemsWith(presses, [{ key: "door", confirm: "Close?" }])}
      />,
    );
    await dom.click(segment(el, "0"));
    await dom.act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await dom.click(segment(el, "0"));
    expect(presses).toEqual(["door"]);
  });

  /** A group whose one item's props the test can change after it is drawn. */
  async function changeable(presses: string[]) {
    let change: (extra: Partial<ButtonGroupItem>) => void = () => {};
    function Harness() {
      const [extra, setExtra] = useState<Partial<ButtonGroupItem>>({});
      change = setExtra;
      return (
        <ButtonGroup
          label="G"
          items={itemsWith(presses, [{ key: "door", label: "Left", confirm: "Close?", ...extra }])}
        />
      );
    }
    const el = await dom.render(<Harness />);
    return { el, change: (extra: Partial<ButtonGroupItem>) => dom.act(() => change(extra)) };
  }

  test("an armed item that becomes disabled is armed no longer", async () => {
    const presses: string[] = [];
    const { el, change } = await changeable(presses);
    await dom.click(segment(el, "0"));
    expect(armed(el)).toEqual(["Close?"]);
    await change({ disabled: true });
    expect(armed(el)).toEqual([]);
    expect(labels(el)).toEqual(["Left"]);
    expect(segment(el, "0")?.getAttribute("aria-label")).toBeNull();
  });

  test("an item disarmed by being disabled stays disarmed once enabled again", async () => {
    const presses: string[] = [];
    const { el, change } = await changeable(presses);
    await dom.click(segment(el, "0"));
    await change({ disabled: true });
    await change({ disabled: false });
    expect(armed(el)).toEqual([]);
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
  });

  test("an item disarmed by losing confirm stays disarmed once it has one again", async () => {
    const presses: string[] = [];
    const { el, change } = await changeable(presses);
    await dom.click(segment(el, "0"));
    await change({ confirm: undefined });
    await change({ confirm: "Open?" });
    expect(armed(el)).toEqual([]);
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
  });

  test("an armed item that loses confirm is armed no longer, and then acts on one press", async () => {
    const presses: string[] = [];
    const { el, change } = await changeable(presses);
    await dom.click(segment(el, "0"));
    expect(armed(el)).toEqual(["Close?"]);
    await change({ confirm: undefined });
    expect(armed(el)).toEqual([]);
    expect(segment(el, "0")?.getAttribute("aria-label")).toBeNull();
    await dom.click(segment(el, "0"));
    expect(presses).toEqual(["door"]);
  });

  test("an armed item whose question changes is disarmed, and the new one asked anew", async () => {
    const presses: string[] = [];
    const { el, change } = await changeable(presses);
    await dom.click(segment(el, "0"));
    await change({ confirm: "Open?" });
    expect(armed(el)).toEqual([]);
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
    expect(armed(el)).toEqual(["Open?"]);
    expect(segment(el, "0")?.getAttribute("aria-label")).toBe("Open? Left");
  });

  test("a disabled item does not call onPress", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [
          { key: "plain", disabled: true },
          { key: "door", disabled: true, confirm: "Close?" },
        ])}
      />,
    );
    expect(buttons(el).map((b) => b.disabled)).toEqual([true, true]);
    await dom.click(segment(el, "0"));
    await dom.click(segment(el, "1"));
    await dom.click(segment(el, "1"));
    expect(presses).toEqual([]);
    expect(armed(el)).toEqual([]);
  });

  test("a pending item spins and is busy, but is still pressable", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [
          { key: "busy", label: "Busy", pending: true, icon: "lightbulb" },
          { key: "idle", label: "Idle", icon: "lightbulb" },
        ])}
      />,
    );
    const [busy, idle] = buttons(el);
    expect(busy?.getAttribute("aria-busy")).toBe("true");
    expect(busy?.classList.contains("ca-bgroup-pending")).toBe(true);
    expect(busy?.querySelector("svg.ca-spin")).not.toBeNull();
    expect(idle?.getAttribute("aria-busy")).toBeNull();
    expect(idle?.querySelector("svg.ca-spin")).toBeNull();
    expect(busy?.disabled).toBe(false);
    await dom.click(busy);
    expect(presses).toEqual(["busy"]);
  });

  test("a pending item that is also disabled is not pressable", async () => {
    const presses: string[] = [];
    const el = await dom.render(
      <ButtonGroup
        label="G"
        items={itemsWith(presses, [{ key: "busy", pending: true, disabled: true }])}
      />,
    );
    await dom.click(segment(el, "0"));
    expect(presses).toEqual([]);
  });
});
