import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { EntityRow } from "./entity-row.tsx";

const icon = (name: string) => renderToStaticMarkup(<Icon name={name} size={18} />);

describe("EntityRow", () => {
  test("a row: state class, icon, name, meta, entity id as tooltip", () => {
    expect(
      renderToStaticMarkup(
        <EntityRow
          name="Porch light"
          entityId="light.porch"
          domain="light"
          state="on"
          summary="On · 40%"
          area="Front"
        />,
      ),
    ).toBe(
      '<div class="ca-row ca-row-on" title="light.porch">' +
        `<span class="ca-row-icon">${icon("light")}</span>` +
        '<div class="ca-row-text"><div class="ca-row-name">Porch light</div>' +
        '<div class="ca-row-meta">On · 40% · Front</div></div></div>',
    );
  });

  test("the state defaults to off", () => {
    expect(renderToStaticMarkup(<EntityRow name="x" />)).toContain('class="ca-row ca-row-off"');
  });

  test("the meta line joins only what is given", () => {
    const meta = (html: string) => html.match(/<div class="ca-row-meta">(.*?)<\/div>/)?.[1];
    expect(meta(renderToStaticMarkup(<EntityRow name="x" summary="Open" />))).toBe("Open");
    expect(meta(renderToStaticMarkup(<EntityRow name="x" area="Garage" />))).toBe("Garage");
    expect(renderToStaticMarkup(<EntityRow name="x" />)).not.toContain("ca-row-meta");
  });

  test('read level says "View only" in place of the area', () => {
    const html = renderToStaticMarkup(
      <EntityRow name="x" summary="Locked" area="Front door" level="read" />,
    );
    expect(html).toContain('<div class="ca-row-meta">Locked · View only</div>');
    expect(html).not.toContain("Front door");
    expect(renderToStaticMarkup(<EntityRow name="x" level="read" />)).toContain(
      '<div class="ca-row-meta">View only</div>',
    );
  });

  test("the icon falls back from icon to domain to switch", () => {
    expect(renderToStaticMarkup(<EntityRow name="x" icon="fan" domain="switch" />)).toContain(
      icon("fan"),
    );
    expect(renderToStaticMarkup(<EntityRow name="x" domain="lock" />)).toContain(icon("lock"));
    expect(renderToStaticMarkup(<EntityRow name="x" />)).toContain(icon("switch"));
  });

  test("a value is shown at the row's end, including zero", () => {
    expect(renderToStaticMarkup(<EntityRow name="x" value="21.5 °C" />)).toContain(
      '<div class="ca-row-value">21.5 °C</div>',
    );
    expect(renderToStaticMarkup(<EntityRow name="x" value={0} />)).toContain(
      '<div class="ca-row-value">0</div>',
    );
    expect(renderToStaticMarkup(<EntityRow name="x" />)).not.toContain("ca-row-value");
  });

  test("children go in the controls slot, after the value", () => {
    const html = renderToStaticMarkup(
      <EntityRow name="x" value="5">
        <button type="button">Go</button>
      </EntityRow>,
    );
    expect(html).toContain(
      '<div class="ca-row-value">5</div><div class="ca-row-controls"><button type="button">Go</button></div>',
    );
    expect(renderToStaticMarkup(<EntityRow name="x" />)).not.toContain("ca-row-controls");
  });

  test("with onOpen, the icon, text and value are one details button, and the controls stay outside it", () => {
    const html = renderToStaticMarkup(
      <EntityRow name="Porch light" value="5" onOpen={() => {}}>
        <button type="button">Go</button>
      </EntityRow>,
    );
    expect(html).toContain(
      '<button type="button" class="ca-row-open" aria-label="Porch light details"><span class="ca-row-icon">',
    );
    expect(html).toContain(
      '<div class="ca-row-value">5</div></button><div class="ca-row-controls">',
    );
    expect(renderToStaticMarkup(<EntityRow name="x" />)).not.toContain("ca-row-open");
  });

  test("className is added", () => {
    expect(renderToStaticMarkup(<EntityRow name="x" state="pending" className="y" />)).toContain(
      'class="ca-row ca-row-pending y"',
    );
  });
});
