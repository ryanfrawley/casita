import { expect, test } from "bun:test";
import { PICKABLE_ICONS } from "../icon.tsx";
import { setupDom } from "../test-dom.ts";
import { IconPicker } from "./icon-picker.tsx";

const dom = setupDom();

test("the default is the first choice and is checked when nothing is chosen", async () => {
  const el = await dom.render(<IconPicker label="Icon" fallback="light" onChange={() => {}} />);
  const options = el.querySelectorAll('[role="radio"]');
  expect(options).toHaveLength(PICKABLE_ICONS.length + 1);
  expect(options[0]?.getAttribute("aria-checked")).toBe("true");
  expect(options[0]?.getAttribute("title")).toBe("Default");
  expect(el.querySelector(".ca-field-hint")?.textContent).toBe("The default, lightbulb");
});

test("a chosen icon is checked and named; choosing the default again hands back undefined", async () => {
  const chosen: (string | undefined)[] = [];
  const el = await dom.render(
    <IconPicker label="Icon" value="fan" fallback="light" onChange={(icon) => chosen.push(icon)} />,
  );
  const fan = el.querySelector('[title="fan"]');
  expect(fan?.getAttribute("aria-checked")).toBe("true");
  expect(el.querySelector('[title="Default"]')?.getAttribute("aria-checked")).toBe("false");
  expect(el.querySelector(".ca-field-hint")?.textContent).toBe("fan");
  await dom.click(el.querySelector('[title="car"]'));
  await dom.click(el.querySelector('[title="Default"]'));
  expect(chosen).toEqual(["car", undefined]);
});

test("a value the icon set does not know counts as the default, and the chrome is not offered", async () => {
  const el = await dom.render(
    <IconPicker label="Icon" value="unicorn" fallback="garage_door" onChange={() => {}} />,
  );
  expect(el.querySelector('[title="Default"]')?.getAttribute("aria-checked")).toBe("true");
  expect(el.querySelector(".ca-field-hint")?.textContent).toBe("The default, warehouse");
  expect(el.querySelector('[title="chevron-right"]')).toBeNull();
  expect(el.querySelector('[title="x"]')).toBeNull();
  expect(el.querySelector('[title="trash-2"]')).toBeNull();
  expect(el.querySelector('[title="fan"]')).not.toBeNull();
});

test("a word narrows the grid by name, keeping the chosen icon, and says when nothing matches", async () => {
  const el = await dom.render(
    <IconPicker label="Icon" value="fan" fallback="light" onChange={() => {}} />,
  );
  const search = el.querySelector<HTMLInputElement>(".ca-icons-search");
  await dom.type(search, "lamp");
  const names = [...el.querySelectorAll('[role="radio"]')].map((o) => o.getAttribute("title"));
  expect(names[0]).toBe("Default");
  expect(names).toContain("lamp-desk");
  expect(names).toContain("fan");
  expect(names).not.toContain("sofa");
  await dom.type(search, "zzz");
  expect(el.querySelectorAll('[role="radio"]')).toHaveLength(2);
  expect(el.querySelector(".ca-icons-none")?.textContent).toBe("No icon named that.");
});

test("a word also finds icons Lucide tags with it, after those named by it", async () => {
  const el = await dom.render(
    <IconPicker label="Icon" value="fan" fallback="light" onChange={() => {}} />,
  );
  const search = el.querySelector<HTMLInputElement>(".ca-icons-search");
  await dom.type(search, "sofa");
  const names = [...el.querySelectorAll('[role="radio"]')].map((o) => o.getAttribute("title"));
  // sofa by name, then armchair by its "sofa" tag, then the chosen fan.
  expect(names.slice(0, 3)).toEqual(["Default", "sofa", "armchair"]);
  expect(names.at(-1)).toBe("fan");
  await dom.type(search, "couch");
  expect(el.querySelector('[title="armchair"]')).not.toBeNull();
  expect(el.querySelector('[title="bed"]')).toBeNull();
});
