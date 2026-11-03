// PillGroup and SegmentedControl: picking from a row of buttons.

import { describe, expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { PillGroup } from "./pill.tsx";
import { SegmentedControl } from "./segmented-control.tsx";

const dom = setupDom();

const OPTIONS = [
  { value: "light", label: "Lights", icon: "lightbulb", count: 4 },
  { value: "switch", label: "Switches" },
  { value: "lock", label: "Locks", disabled: true },
];
const pill = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.querySelector("span")?.textContent === label);
const pressed = (el: HTMLElement) =>
  [...el.querySelectorAll("button[aria-pressed=true]")].map(
    (b) => b.querySelector("span")?.textContent,
  );

describe("PillGroup", () => {
  test("a labelled group with All pressed while nothing is picked", async () => {
    const el = await dom.render(<PillGroup label="Kinds" options={OPTIONS} allCount={9} />);
    const group = el.querySelector("[role=group]");
    expect(group?.getAttribute("aria-label")).toBe("Kinds");
    expect(pressed(el)).toEqual(["All"]);
    expect(pill(el, "All")?.querySelector(".ca-pill-count")?.textContent).toBe("9");
    expect(pill(el, "Lights")?.querySelector(".ca-pill-count")?.textContent).toBe("4");
    expect(pill(el, "Lights")?.querySelector("svg")).not.toBeNull();
    expect(pill(el, "Locks")?.disabled).toBe(true);
  });

  test("multiple: pills toggle in and out; All clears", async () => {
    const changes: string[][] = [];
    const el = await dom.render(
      <PillGroup label="Kinds" options={OPTIONS} onChange={(v) => changes.push(v)} />,
    );
    await dom.click(pill(el, "Lights"));
    expect(pressed(el)).toEqual(["Lights"]);
    expect(pill(el, "Lights")?.className).toBe("ca-pill ca-pill-on");
    await dom.click(pill(el, "Switches"));
    expect(pressed(el)).toEqual(["Lights", "Switches"]);
    await dom.click(pill(el, "Lights"));
    expect(pressed(el)).toEqual(["Switches"]);
    await dom.click(pill(el, "All"));
    expect(pressed(el)).toEqual(["All"]);
    expect(changes).toEqual([["light"], ["light", "switch"], ["switch"], []]);
  });

  test("single: picking one replaces the other; picking it again clears", async () => {
    const changes: string[][] = [];
    const el = await dom.render(
      <PillGroup
        label="Kinds"
        options={OPTIONS}
        multiple={false}
        onChange={(v) => changes.push(v)}
      />,
    );
    await dom.click(pill(el, "Lights"));
    await dom.click(pill(el, "Switches"));
    expect(pressed(el)).toEqual(["Switches"]);
    await dom.click(pill(el, "Switches"));
    expect(pressed(el)).toEqual(["All"]);
    expect(changes).toEqual([["light"], ["switch"], []]);
  });

  test("allLabel={null} leaves out All; a string renames it", async () => {
    const none = await dom.render(<PillGroup label="Kinds" options={OPTIONS} allLabel={null} />);
    expect(pill(none, "All")).toBeUndefined();
    expect(none.querySelectorAll("button")).toHaveLength(3);
    expect(pressed(none)).toEqual([]);
    const named = await dom.render(
      <PillGroup label="Kinds" options={OPTIONS} allLabel="Every kind" />,
    );
    expect(pressed(named)).toEqual(["Every kind"]);
  });

  test("controlled: changes are reported but the pills follow `value`", async () => {
    const changes: string[][] = [];
    const el = await dom.render(
      <PillGroup
        label="Kinds"
        options={OPTIONS}
        value={["switch"]}
        onChange={(v) => changes.push(v)}
      />,
    );
    expect(pressed(el)).toEqual(["Switches"]);
    await dom.click(pill(el, "Lights"));
    expect(changes).toEqual([["switch", "light"]]);
    expect(pressed(el)).toEqual(["Switches"]);
  });

  test("defaultValue sets the first selection", async () => {
    const el = await dom.render(
      <PillGroup label="Kinds" options={OPTIONS} defaultValue={["light"]} />,
    );
    expect(pressed(el)).toEqual(["Lights"]);
  });
});

describe("SegmentedControl", () => {
  const MODES = [
    { value: "heat", label: "Heat" },
    { value: "cool", label: "Cool" },
    { value: "off", label: "Off" },
  ];
  const checked = (el: HTMLElement) =>
    [...el.querySelectorAll("[role=radio][aria-checked=true]")].map((b) => b.textContent);

  test("a labelled radio group with the first option checked by default", async () => {
    const el = await dom.render(<SegmentedControl label="Mode" options={MODES} />);
    expect(el.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Mode");
    expect(el.querySelectorAll("[role=radio]")).toHaveLength(3);
    expect(checked(el)).toEqual(["Heat"]);
  });

  test("a click checks an option and reports it", async () => {
    const changes: string[] = [];
    const el = await dom.render(
      <SegmentedControl
        label="Mode"
        options={MODES}
        defaultValue="cool"
        onChange={(v) => changes.push(v)}
      />,
    );
    expect(checked(el)).toEqual(["Cool"]);
    const off = [...el.querySelectorAll("button")].find((b) => b.textContent === "Off");
    await dom.click(off);
    expect(checked(el)).toEqual(["Off"]);
    expect(off?.className).toBe("ca-seg-opt ca-seg-on");
    expect(changes).toEqual(["off"]);
  });

  test("controlled: the checked option follows `value`", async () => {
    const changes: string[] = [];
    const el = await dom.render(
      <SegmentedControl
        label="Mode"
        options={MODES}
        value="heat"
        onChange={(v) => changes.push(v)}
      />,
    );
    await dom.click([...el.querySelectorAll("button")].find((b) => b.textContent === "Cool"));
    expect(changes).toEqual(["cool"]);
    expect(checked(el)).toEqual(["Heat"]);
  });
});
