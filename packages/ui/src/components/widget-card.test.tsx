import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { type WidgetBlock, WidgetCard } from "./widget-card.tsx";

const render = (blocks: WidgetBlock[], props: Partial<Parameters<typeof WidgetCard>[0]> = {}) =>
  renderToStaticMarkup(<WidgetCard name="Model Y" blocks={blocks} {...props} />);

describe("WidgetCard", () => {
  test("a section named by the card, lamp and medium unless told, with its id as the tooltip", () => {
    const html = render([], { deviceId: "dev_12" });
    expect(html).toMatch(
      /^<section class="ca-widget ca-widget-lamp ca-widget-size-md" aria-label="Model Y" title="dev_12">/,
    );
    expect(html).toContain('<div class="ca-widget-name">Model Y</div>');
    expect(html).toContain('<div class="ca-widget-status"></div>');
    expect(html).toContain('<p class="ca-widget-empty">Nothing chosen for this card yet.</p>');
    expect(html).not.toContain("ca-widget-body");
  });

  test("accent, size and active are classes; the status line and actions sit in the header", () => {
    const html = render([], {
      accent: "sky",
      size: "lg",
      active: true,
      status: "Parked · Locked",
      actions: <button type="button">more</button>,
      emptyText: "Pick something.",
    });
    expect(html).toContain('class="ca-widget ca-widget-sky ca-widget-size-lg ca-widget-active"');
    expect(html).toContain('<div class="ca-widget-status">Parked · Locked</div>');
    expect(html).toMatch(/<\/div><button type="button">more<\/button><\/header>/);
    expect(html).toContain("Pick something.");
  });

  test("emptyText null is a card that is its heading alone: no body, no empty line", () => {
    const html = renderToStaticMarkup(<WidgetCard name="Door" emptyText={null} />);
    expect(html).toContain('<div class="ca-widget-name">Door</div>');
    expect(html).not.toContain("ca-widget-body");
    expect(html).not.toContain("ca-widget-empty");
    expect(html).toContain("ca-widget-headonly");
  });

  test("a card with a body, or one saying it is empty, is not its heading alone", () => {
    expect(renderToStaticMarkup(<WidgetCard name="Door" />)).not.toContain("ca-widget-headonly");
    expect(
      renderToStaticMarkup(
        <WidgetCard name="Door" emptyText={null}>
          <p>Open</p>
        </WidgetCard>,
      ),
    ).not.toContain("ca-widget-headonly");
    expect(
      renderToStaticMarkup(<WidgetCard name="Door" header={false} emptyText={null} />),
    ).not.toContain("ca-widget-headonly");
  });

  test("a headline is the big number, its unit trimmed, and a caption", () => {
    const html = render([
      { kind: "headline", key: "h", value: "348", unit: " km", caption: "Range" },
    ]);
    expect(html).toContain(
      '<div class="ca-widget-headline"><span class="ca-widget-big">348</span><span class="ca-widget-unit">km</span><span class="ca-widget-caption">Range</span></div>',
    );
    expect(render([{ kind: "headline", key: "h", value: "—", caption: "Range" }])).not.toContain(
      "ca-widget-unit",
    );
  });

  test("stats are one definition list, each with an optional icon", () => {
    const html = render([
      {
        kind: "stats",
        key: "s",
        stats: [
          { key: "a", label: "Battery", value: "72%", icon: "battery" },
          { key: "b", label: "Odometer", value: "18,204 km" },
        ],
      },
    ]);
    expect(html.match(/<dl class="ca-widget-stats">/g)).toHaveLength(1);
    expect(html).toContain(
      `<dt>${renderToStaticMarkup(<Icon name="battery" size={14} />)}Battery</dt><dd>72%</dd>`,
    );
    expect(html).toContain("<dt>Odometer</dt><dd>18,204 km</dd>");
  });

  test("without a header the blocks stand on their own; actions get a strip", () => {
    const bare = renderToStaticMarkup(<WidgetCard name="x" header={false} blocks={[]} />);
    expect(bare).toContain('class="ca-widget ca-widget-lamp ca-widget-size-md ca-widget-bare"');
    expect(bare).not.toContain("ca-widget-head");
    expect(bare).not.toContain("ca-widget-strip");
    const strip = renderToStaticMarkup(
      <WidgetCard name="x" header={false} blocks={[]} actions={<button type="button">m</button>} />,
    );
    expect(strip).toContain('<div class="ca-widget-strip"><button type="button">m</button></div>');
  });

  test("a figure holds a drawing under the reading's name", () => {
    const html = render([{ kind: "figure", key: "f", label: "Porch", children: <svg /> }]);
    expect(html).toContain(
      '<figure class="ca-widget-figure"><figcaption class="ca-widget-figure-head">Porch</figcaption><svg></svg></figure>',
    );
    expect(render([{ kind: "figure", key: "f", children: <svg /> }])).not.toContain("figcaption");
  });

  test("a bar names its reading, draws the value and a marker, and warns when low", () => {
    const fine = render([
      {
        kind: "bar",
        key: "b",
        label: "Battery",
        value: "72%",
        percent: 72,
        tone: "accent",
        marker: { percent: 80, text: "charge limit 80%" },
      },
    ]);
    expect(fine).toContain('<div class="ca-widget-bar">');
    expect(fine).toContain(
      '<span class="ca-widget-bar-val">72%<span class="ca-widget-muted"> · charge limit 80%</span></span>',
    );
    expect(fine).toContain('class="ca-rangebar ca-rangebar-accent"');
    expect(fine).toContain('aria-label="Battery 72%"');
    expect(fine).toContain('class="ca-rangebar-mark" style="left:80%"');
    expect(fine).toContain("width:72%");

    const low = render([
      {
        kind: "bar",
        key: "b",
        label: "Battery",
        value: "12%",
        percent: 12,
        tone: "sky",
        low: true,
      },
    ]);
    expect(low).toContain('<div class="ca-widget-bar ca-widget-low">');
    expect(low).toContain(renderToStaticMarkup(<Icon name="triangle-alert" size={14} />));
    expect(low).toContain('class="ca-rangebar ca-rangebar-danger"');
    expect(low).toContain('aria-label="Battery 12%, low"');
    expect(low).not.toContain("ca-rangebar-mark");
  });

  test("a row is whatever it is given, in order with the rest", () => {
    const html = render([
      { kind: "row", key: "r", children: <div className="row">Charging</div> },
      { kind: "headline", key: "h", value: "1", caption: "One" },
    ]);
    expect(html).toMatch(
      /<div class="ca-widget-body"><div class="row">Charging<\/div><div class="ca-widget-headline">/,
    );
  });
});
