import { expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { type TabItem, Tabs } from "./tabs.tsx";

const dom = setupDom();

const TABS: TabItem[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
  { value: "d", label: "Delta" },
];

const tab = (el: HTMLElement, value: string) =>
  el.querySelector<HTMLElement>(`[role=tab][data-value="${value}"]`);
const selected = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.dataset.value;
const tabIndexes = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("[role=tab]")].map((t) => t.getAttribute("tabindex"));

test("uncontrolled: arrows, Home and End move the selection and the focus, skipping disabled", async () => {
  const changes: string[] = [];
  const el = await dom.render(
    <Tabs id="u" label="Sections" tabs={TABS} onChange={(v) => changes.push(v)}>
      {(value) => <p>panel {value}</p>}
    </Tabs>,
  );
  const panel = el.querySelector("[role=tabpanel]");
  tab(el, "a")?.focus();
  expect(selected(el)).toBe("a");
  expect(tabIndexes(el)).toEqual(["0", "-1", "-1", "-1"]);

  await dom.key("ArrowRight");
  expect(selected(el)).toBe("c");
  expect(document.activeElement).toBe(tab(el, "c"));
  expect(tabIndexes(el)).toEqual(["-1", "-1", "0", "-1"]);
  expect(panel?.getAttribute("aria-labelledby")).toBe("u-c");
  expect(panel?.textContent).toBe("panel c");

  await dom.key("ArrowLeft");
  expect(selected(el)).toBe("a");
  await dom.key("ArrowLeft");
  expect(selected(el)).toBe("d");
  expect(document.activeElement).toBe(tab(el, "d"));
  await dom.key("ArrowRight");
  expect(selected(el)).toBe("a");
  await dom.key("End");
  expect(selected(el)).toBe("d");
  await dom.key("Home");
  expect(selected(el)).toBe("a");
  expect(changes).toEqual(["c", "a", "d", "a", "d", "a"]);
});

test("other keys change nothing and are not swallowed", async () => {
  const changes: string[] = [];
  const el = await dom.render(
    <Tabs label="Sections" tabs={TABS} onChange={(v) => changes.push(v)} />,
  );
  tab(el, "a")?.focus();
  const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  await dom.act(() => {
    tab(el, "a")?.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(selected(el)).toBe("a");
  expect(changes).toEqual([]);
});

test("a click selects a tab", async () => {
  const changes: string[] = [];
  const el = await dom.render(
    <Tabs id="k" label="Sections" tabs={TABS} onChange={(v) => changes.push(v)}>
      body
    </Tabs>,
  );
  await dom.click(tab(el, "d"));
  expect(selected(el)).toBe("d");
  expect(el.querySelector("[role=tabpanel]")?.getAttribute("aria-labelledby")).toBe("k-d");
  expect(changes).toEqual(["d"]);
});

test("controlled: changes are reported but the selection follows `value`", async () => {
  const changes: string[] = [];
  const el = await dom.render(
    <Tabs label="Sections" tabs={TABS} value="a" onChange={(v) => changes.push(v)} />,
  );
  tab(el, "a")?.focus();
  await dom.key("ArrowRight");
  expect(changes).toEqual(["c"]);
  expect(selected(el)).toBe("a");
  await dom.click(tab(el, "d"));
  expect(changes).toEqual(["c", "d"]);
  expect(selected(el)).toBe("a");
});

test("controlled by a parent's state, the selection moves when the parent agrees", async () => {
  function Parent() {
    const [value, setValue] = useState("c");
    return <Tabs label="Sections" tabs={TABS} value={value} onChange={setValue} />;
  }
  const el = await dom.render(<Parent />);
  expect(selected(el)).toBe("c");
  tab(el, "c")?.focus();
  await dom.key("ArrowRight");
  expect(selected(el)).toBe("d");
  expect(document.activeElement).toBe(tab(el, "d"));
});
