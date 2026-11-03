import { expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { Combobox, type ComboboxOption } from "./combobox.tsx";

const dom = setupDom();

const OPTIONS: ComboboxOption[] = [
  { value: "light.kitchen", label: "Kitchen lamp", description: "Hue bridge" },
  { value: "light.porch", label: "Porch light", disabled: true },
  { value: "switch.fan", label: "Ceiling fan" },
  { value: "lock.front", label: "Front door", description: "August" },
];

/** A Combobox that keeps the picked value, as a form would. */
function Picker({ picked, initial }: { picked: string[]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      id="c"
      label="Entity"
      options={OPTIONS}
      value={value}
      onChange={(next, option) => {
        expect(option.value).toBe(next);
        picked.push(next);
        setValue(next);
      }}
    />
  );
}

async function setup(initial?: string) {
  const picked: string[] = [];
  const el = await dom.render(<Picker picked={picked} initial={initial} />);
  const input = el.querySelector<HTMLInputElement>("input[role=combobox]");
  if (!input) throw new Error("no input");
  const labels = () => [...el.querySelectorAll("[role=option]")].map((o) => o.textContent);
  const active = () => input.getAttribute("aria-activedescendant");
  return { el, input, picked, labels, active };
}

test("typing opens the list and filters it by label, value or description", async () => {
  const { el, input, labels, active } = await setup();
  expect(el.querySelector("[role=listbox]")).toBeNull();

  await dom.type(input, "lamp");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(input.value).toBe("lamp");
  expect(labels()).toEqual(["Kitchen lampHue bridge"]);
  expect(active()).toBe("c-list-0");

  await dom.type(input, "light.");
  expect(labels()).toEqual(["Kitchen lampHue bridge", "Porch light"]);

  await dom.type(input, "AUGUST");
  expect(labels()).toEqual(["Front doorAugust"]);
});

test("a query that matches nothing says No matches and points at nothing", async () => {
  const { el, input, labels, active } = await setup();
  await dom.type(input, "zzz");
  expect(labels()).toEqual([]);
  const empty = el.querySelector(".ca-pop-empty");
  expect(empty?.textContent).toBe("No matches");
  expect(empty?.getAttribute("role")).toBe("presentation");
  expect(active()).toBeNull();
});

test("ArrowDown opens on the selected option; the arrows move; Enter picks", async () => {
  const { el, input, picked, active } = await setup("switch.fan");
  expect(input.value).toBe("Ceiling fan");

  await dom.key("ArrowDown", input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(active()).toBe("c-list-2");
  const current = el.querySelector("#c-list-2");
  expect(current?.classList.contains("ca-combo-active")).toBe(true);
  expect(current?.getAttribute("aria-selected")).toBe("true");
  expect(el.querySelector("#c-list-0")?.getAttribute("aria-selected")).toBe("false");

  await dom.key("ArrowDown", input);
  expect(active()).toBe("c-list-3");
  // The last option is as far as it goes.
  await dom.key("ArrowDown", input);
  expect(active()).toBe("c-list-3");

  await dom.key("ArrowUp", input);
  await dom.key("ArrowUp", input);
  await dom.key("ArrowUp", input);
  expect(active()).toBe("c-list-0");
  await dom.key("ArrowUp", input);
  expect(active()).toBe("c-list-0");

  await dom.key("Enter", input);
  expect(picked).toEqual(["light.kitchen"]);
  expect(el.querySelector("[role=listbox]")).toBeNull();
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.value).toBe("Kitchen lamp");
});

test("ArrowDown with nothing selected opens on the first option", async () => {
  const { input, active } = await setup();
  await dom.key("ArrowDown", input);
  expect(active()).toBe("c-list-0");
});

test("a disabled option cannot be picked by Enter or by mouse", async () => {
  const { el, input, picked, active } = await setup();
  await dom.key("ArrowDown", input);
  await dom.key("ArrowDown", input);
  expect(active()).toBe("c-list-1");
  expect(el.querySelector("#c-list-1")?.getAttribute("aria-disabled")).toBe("true");
  expect(el.querySelector("#c-list-1")?.classList.contains("ca-pop-disabled")).toBe(true);

  await dom.key("Enter", input);
  expect(picked).toEqual([]);
  expect(el.querySelector("[role=listbox]")).not.toBeNull();

  await dom.click(el.querySelector("#c-list-1"));
  expect(picked).toEqual([]);
  expect(el.querySelector("[role=listbox]")).not.toBeNull();
});

test("a press on an option picks it", async () => {
  const { el, input, picked } = await setup();
  await dom.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  await dom.click(el.querySelector("#c-list-3"));
  expect(picked).toEqual(["lock.front"]);
  expect(input.value).toBe("Front door");
  expect(el.querySelector("[role=listbox]")).toBeNull();
});

test("Enter picks from the filtered list", async () => {
  const { input, picked } = await setup();
  await dom.type(input, "door");
  await dom.key("Enter", input);
  expect(picked).toEqual(["lock.front"]);
});

test("Escape closes the list and puts back the selected label without picking", async () => {
  const picked: string[] = [];
  let escapes = 0;
  const el = await dom.render(
    // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a dialog listening for Escape
    <div onKeyDown={(event) => event.key === "Escape" && escapes++}>
      <Picker picked={picked} initial="switch.fan" />
    </div>,
  );
  const input = el.querySelector<HTMLInputElement>("input[role=combobox]");
  await dom.type(input, "fro");
  expect(input?.value).toBe("fro");

  await dom.key("Escape", input);
  expect(el.querySelector("[role=listbox]")).toBeNull();
  expect(input?.value).toBe("Ceiling fan");
  expect(picked).toEqual([]);
  // An open list keeps Escape to itself, so a dialog around it stays open.
  expect(escapes).toBe(0);

  // A closed one leaves Escape to whoever is listening.
  await dom.key("Escape", input);
  expect(escapes).toBe(1);
});

test("Tab and a press outside close the list and drop the query", async () => {
  const { el, input } = await setup("switch.fan");
  await dom.type(input, "kit");
  await dom.key("Tab", input);
  expect(el.querySelector("[role=listbox]")).toBeNull();
  expect(input.value).toBe("Ceiling fan");

  await dom.type(input, "kit");
  await dom.act(() => {
    dom.document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(el.querySelector("[role=listbox]")).toBeNull();
  expect(input.value).toBe("Ceiling fan");
});

test("hovering an option makes it the active one", async () => {
  const { el, input, active } = await setup();
  await dom.click(input);
  await dom.act(() => {
    // React listens for mouseover to synthesise mouseenter.
    el.querySelector("#c-list-2")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(active()).toBe("c-list-2");
});

test("the list is labelled like the field and has the id the input controls", async () => {
  const { el, input } = await setup();
  await dom.click(input);
  const list = el.querySelector("[role=listbox]");
  expect(list?.id).toBe("c-list");
  expect(input.getAttribute("aria-controls")).toBe("c-list");
  expect(list?.getAttribute("aria-label")).toBe("Entity");
});
