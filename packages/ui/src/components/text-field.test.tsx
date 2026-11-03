import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "./select.tsx";
import { TextField } from "./text-field.tsx";

describe("TextField", () => {
  test("the label points at the input; no hint means nothing describes it", () => {
    const html = renderToStaticMarkup(<TextField id="name" label="Name" />);
    expect(html).toBe(
      '<div class="ca-field"><label for="name" class="ca-field-label">Name</label><input id="name" class="ca-input"/></div>',
    );
  });

  test("without an id the label still points at the input", () => {
    const html = renderToStaticMarkup(<TextField label="Name" hint="Shown on tiles" />);
    const id = html.match(/<label for="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<input id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-d"`);
    expect(html).toContain(`<div id="${id}-d" class="ca-field-hint">Shown on tiles</div>`);
  });

  test("a hint describes the input", () => {
    const html = renderToStaticMarkup(<TextField id="n" label="Name" hint="Shown on tiles" />);
    expect(html).toContain('aria-describedby="n-d"');
    expect(html).toContain('<div id="n-d" class="ca-field-hint">Shown on tiles</div>');
    expect(html).not.toContain("aria-invalid");
  });

  test("an error marks the field invalid, describes the input, and beats the hint", () => {
    const html = renderToStaticMarkup(
      <TextField id="n" label="Name" hint="Shown on tiles" error="Required" />,
    );
    expect(html).toStartWith('<div class="ca-field ca-field-invalid">');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="n-d"');
    expect(html).toMatch(/<div id="n-d" class="ca-field-error"><svg[\s\S]*<\/svg>Required<\/div>/);
    expect(html).not.toContain("Shown on tiles");
  });

  test("mono, className and input attributes", () => {
    const html = renderToStaticMarkup(
      <TextField id="n" label="Topic" mono className="x" placeholder="zigbee2mqtt/#" disabled />,
    );
    expect(html).toContain('<div class="ca-field x">');
    expect(html).toContain('class="ca-input ca-mono"');
    expect(html).toContain('placeholder="zigbee2mqtt/#"');
    expect(html).toContain('disabled=""');
  });
});

describe("Select", () => {
  const OPTIONS = [
    { value: "a", label: "Kitchen" },
    { value: "b", label: "Porch", disabled: true },
  ];

  test("a labelled native select with its options and a chevron", () => {
    const html = renderToStaticMarkup(<Select id="s" label="Area" options={OPTIONS} />);
    expect(html).toContain('<label for="s" class="ca-field-label">Area</label>');
    expect(html).toContain(
      '<span class="ca-select"><select id="s" class="ca-input ca-select-input"',
    );
    expect(html).toContain('<option value="a">Kitchen</option>');
    expect(html).toContain('<option value="b" disabled="">Porch</option>');
    expect(html).toContain("ca-select-chevron");
    expect(html).not.toContain("aria-describedby");
  });

  test("no label, no label element", () => {
    expect(renderToStaticMarkup(<Select options={OPTIONS} />)).not.toContain("<label");
  });

  test("a placeholder is a disabled empty option, selected until there is a value", () => {
    const html = renderToStaticMarkup(<Select id="s" options={OPTIONS} placeholder="Pick one" />);
    expect(html).toContain('<option value="" disabled="" selected="">Pick one</option>');
    const chosen = renderToStaticMarkup(
      <Select id="s" options={OPTIONS} placeholder="Pick one" value="a" />,
    );
    expect(chosen).toContain('<option value="" disabled="">Pick one</option>');
    expect(chosen).toContain('<option value="a" selected="">Kitchen</option>');
  });

  test("defaultValue selects an option", () => {
    const html = renderToStaticMarkup(<Select options={OPTIONS} defaultValue="b" />);
    expect(html).toContain('<option value="b" disabled="" selected="">Porch</option>');
  });

  test("groups become optgroups", () => {
    const html = renderToStaticMarkup(
      <Select
        options={[
          { value: "x", label: "Anywhere" },
          { label: "Upstairs", options: [{ value: "bed", label: "Bedroom" }] },
        ]}
      />,
    );
    expect(html).toContain('<option value="x">Anywhere</option>');
    expect(html).toContain(
      '<optgroup label="Upstairs"><option value="bed">Bedroom</option></optgroup>',
    );
  });

  test("a hint describes the select", () => {
    const html = renderToStaticMarkup(<Select id="s" options={OPTIONS} hint="Where it is" />);
    expect(html).toContain('aria-describedby="s-d"');
    expect(html).toContain('<div id="s-d" class="ca-field-hint">Where it is</div>');
  });

  test("an error marks it invalid and beats the hint", () => {
    const html = renderToStaticMarkup(
      <Select id="s" options={OPTIONS} hint="Where it is" error="Pick an area" />,
    );
    expect(html).toContain("ca-field-invalid");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="s-d"');
    expect(html).toMatch(/<div id="s-d" class="ca-field-error">[\s\S]*Pick an area<\/div>/);
    expect(html).not.toContain("Where it is");
  });

  test("mono reaches the select", () => {
    expect(renderToStaticMarkup(<Select options={OPTIONS} mono />)).toContain(
      'class="ca-input ca-select-input ca-mono"',
    );
  });
});
