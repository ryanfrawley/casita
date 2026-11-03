import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Combobox, type ComboboxOption, filterOptions } from "./combobox.tsx";

const OPTIONS: ComboboxOption[] = [
  { value: "light.kitchen", label: "Kitchen lamp", description: "Hue bridge" },
  { value: "switch.fan", label: "Ceiling fan" },
  { value: "lock.front", label: "Front door", description: "August" },
];

describe("filterOptions", () => {
  test("no query keeps every option, as the same array", () => {
    expect(filterOptions(OPTIONS, null)).toBe(OPTIONS);
    expect(filterOptions(OPTIONS, "")).toBe(OPTIONS);
  });

  test("matches the label anywhere, ignoring case", () => {
    expect(filterOptions(OPTIONS, "LAMP").map((o) => o.value)).toEqual(["light.kitchen"]);
    expect(filterOptions(OPTIONS, "an").map((o) => o.value)).toEqual(["switch.fan"]);
  });

  test("matches the value and the description too", () => {
    expect(filterOptions(OPTIONS, "lock.").map((o) => o.value)).toEqual(["lock.front"]);
    expect(filterOptions(OPTIONS, "bridge").map((o) => o.value)).toEqual(["light.kitchen"]);
  });

  test("keeps the options' order", () => {
    expect(filterOptions(OPTIONS, "N").map((o) => o.value)).toEqual([
      "light.kitchen",
      "switch.fan",
      "lock.front",
    ]);
  });

  test("a query nothing contains keeps nothing", () => {
    expect(filterOptions(OPTIONS, "zzz")).toEqual([]);
  });
});

describe("Combobox markup", () => {
  test("closed: a labelled combobox showing the selected option's label, with no list", () => {
    const html = renderToStaticMarkup(
      <Combobox id="ent" label="Entity" options={OPTIONS} value="switch.fan" placeholder="Pick" />,
    );
    expect(html).toContain('<label for="ent" class="ca-field-label">Entity</label>');
    expect(html).toContain('id="ent" role="combobox" aria-expanded="false"');
    expect(html).toContain('aria-controls="ent-list"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('value="Ceiling fan"');
    expect(html).toContain('placeholder="Pick"');
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toContain("aria-activedescendant");
    expect(html).not.toContain('role="listbox"');
  });

  test("no value shows an empty box", () => {
    const html = renderToStaticMarkup(<Combobox id="c" options={OPTIONS} />);
    expect(html).toContain('value=""');
    expect(html).not.toContain("<label");
  });

  test("a hint describes the input", () => {
    const html = renderToStaticMarkup(<Combobox id="c" options={OPTIONS} hint="Type to search" />);
    expect(html).toContain('aria-describedby="c-d"');
    expect(html).toContain('<div id="c-d" class="ca-field-hint">Type to search</div>');
  });

  test("an error marks it invalid and beats the hint", () => {
    const html = renderToStaticMarkup(
      <Combobox id="c" options={OPTIONS} hint="Type to search" error="Pick one" />,
    );
    expect(html).toContain("ca-field-invalid");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="c-d"');
    expect(html).toMatch(/<div id="c-d" class="ca-field-error">.*Pick one<\/div>/);
    expect(html).not.toContain("Type to search");
  });

  test("mono and disabled reach the input", () => {
    const html = renderToStaticMarkup(<Combobox id="c" options={OPTIONS} mono disabled />);
    expect(html).toContain('class="ca-input ca-combo-input ca-mono"');
    expect(html).toContain('disabled=""');
  });

  test("without an id the label still points at the input", () => {
    const html = renderToStaticMarkup(<Combobox label="Entity" options={OPTIONS} />);
    const id = html.match(/<label for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<input id="${id}"`);
    expect(html).toContain(`aria-controls="${id}-list"`);
  });
});
