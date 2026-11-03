import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { DeviceCard, DeviceSection } from "./device-card.tsx";
import { StatusDot } from "./status-dot.tsx";

describe("DeviceCard", () => {
  test("a section named by the device, with its id as the tooltip", () => {
    const html = renderToStaticMarkup(<DeviceCard name="Sprinkler" deviceId="dev_12" />);
    expect(html).toMatch(/^<section class="ca-device" aria-label="Sprinkler" title="dev_12">/);
    expect(html).toContain('<h3 class="ca-device-name">Sprinkler</h3>');
    expect(html).toContain('<div class="ca-device-body"></div>');
  });

  test("the meta line joins manufacturer, model and area", () => {
    expect(
      renderToStaticMarkup(
        <DeviceCard name="x" manufacturer="Rachio" model="Gen 3" area="Garden" />,
      ),
    ).toContain('<div class="ca-device-meta">Rachio · Gen 3 · Garden</div>');
    expect(renderToStaticMarkup(<DeviceCard name="x" model="Gen 3" />)).toContain(
      '<div class="ca-device-meta">Gen 3</div>',
    );
    expect(renderToStaticMarkup(<DeviceCard name="x" />)).not.toContain("ca-device-meta");
  });

  test("a StatusDot only with a status, below, with its word and detail", () => {
    expect(renderToStaticMarkup(<DeviceCard name="x" />)).not.toContain("ca-status");
    const html = renderToStaticMarkup(
      <DeviceCard
        name="x"
        status="unavailable"
        statusText="Offline"
        statusDetail="Last seen 2 h ago"
      />,
    );
    expect(html).toContain(
      renderToStaticMarkup(
        <StatusDot
          status="unavailable"
          label="Offline"
          detail="Last seen 2 h ago"
          placement="bottom"
        />,
      ),
    );
  });

  test("the status is a class on the card", () => {
    for (const status of ["online", "unavailable", "error", "disabled"] as const) {
      expect(renderToStaticMarkup(<DeviceCard name="x" status={status} />)).toMatch(
        new RegExp(`^<section class="ca-device ca-device-${status}"`),
      );
    }
  });

  test("the icon is plug by default, and active lights it", () => {
    expect(renderToStaticMarkup(<DeviceCard name="x" />)).toContain(
      `<span class="ca-device-icon">${renderToStaticMarkup(<Icon name="plug" size={22} />)}</span>`,
    );
    expect(renderToStaticMarkup(<DeviceCard name="x" icon="irrigation" active />)).toContain(
      `<span class="ca-device-icon ca-device-icon-on">${renderToStaticMarkup(<Icon name="irrigation" size={22} />)}</span>`,
    );
  });

  test("stats are a description list of label and value", () => {
    const html = renderToStaticMarkup(
      <DeviceCard
        name="x"
        stats={[
          { label: "Battery", value: "64%", icon: "battery" },
          { label: "Signal", value: "Good" },
        ]}
      />,
    );
    expect(html).toContain(
      '<dl class="ca-device-stats">' +
        `<div class="ca-device-stat"><dt>${renderToStaticMarkup(<Icon name="battery" size={14} />)}Battery</dt><dd>64%</dd></div>` +
        '<div class="ca-device-stat"><dt>Signal</dt><dd>Good</dd></div></dl>',
    );
    expect(renderToStaticMarkup(<DeviceCard name="x" stats={[]} />)).not.toContain("<dl");
  });

  test("the error line is announced as an alert", () => {
    const html = renderToStaticMarkup(<DeviceCard name="x" error="Valve stuck. Check the hose." />);
    expect(html).toContain(
      `<div class="ca-device-msg" role="alert">${renderToStaticMarkup(<Icon name="triangle-alert" size={16} />)}Valve stuck. Check the hose.</div>`,
    );
    expect(renderToStaticMarkup(<DeviceCard name="x" />)).not.toContain('role="alert"');
  });

  test("actions, children and footer each have their place", () => {
    const html = renderToStaticMarkup(
      <DeviceCard
        name="x"
        actions={<button type="button">Stop all</button>}
        footer={<span>Updated</span>}
        className="y"
      >
        <p>row</p>
      </DeviceCard>,
    );
    expect(html).toContain(
      '<div class="ca-device-actions"><button type="button">Stop all</button></div></header>',
    );
    expect(html).toContain('<div class="ca-device-body"><p>row</p></div>');
    expect(html).toContain('<footer class="ca-device-foot"><span>Updated</span></footer>');
    expect(html).toMatch(/^<section class="ca-device y"/);
  });
});

describe("DeviceSection", () => {
  test("not collapsible: a static heading with no button, and the body shown", () => {
    const html = renderToStaticMarkup(
      <DeviceSection title="Zone 1">
        <p>row</p>
      </DeviceSection>,
    );
    expect(html).not.toContain("<button");
    expect(html).toContain(
      '<div class="ca-dsec-toggle ca-dsec-static"><span class="ca-dsec-titles"><span class="ca-dsec-title">Zone 1</span></span></div>',
    );
    expect(html).toMatch(/<div id="[^"]+" class="ca-dsec-body"><p>row<\/p><\/div>/);
  });

  test("defaultOpen={false} has no effect when not collapsible", () => {
    const html = renderToStaticMarkup(
      <DeviceSection title="Zone 1" defaultOpen={false}>
        <p>row</p>
      </DeviceSection>,
    );
    expect(html).toContain("<p>row</p>");
    expect(html).not.toContain("ca-dsec-closed");
  });

  test("collapsible: a button that controls the body and says it is expanded", () => {
    const html = renderToStaticMarkup(
      <DeviceSection title="Zone 1" collapsible>
        <p>row</p>
      </DeviceSection>,
    );
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain('<button type="button" class="ca-dsec-toggle" aria-expanded="true"');
    expect(controls).toBeTruthy();
    expect(html).toContain(`<div id="${controls}" class="ca-dsec-body"><p>row</p></div>`);
    expect(html).toContain(
      renderToStaticMarkup(<Icon name="chevron-down" size={16} className="ca-dsec-chevron" />),
    );
  });

  test("collapsible with defaultOpen={false} starts closed, with no body", () => {
    const html = renderToStaticMarkup(
      <DeviceSection title="Zone 1" collapsible defaultOpen={false}>
        <p>row</p>
      </DeviceSection>,
    );
    expect(html).toMatch(/^<div class="ca-dsec ca-dsec-closed">/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("ca-dsec-body");
    expect(html).not.toContain("<p>row</p>");
  });

  test("the summary and aside are shown, and stay when closed", () => {
    const html = renderToStaticMarkup(
      <DeviceSection
        title="Zone 1"
        summary="Watering · 8 min left"
        aside={<button type="button">Skip</button>}
        collapsible
        defaultOpen={false}
        className="x"
      />,
    );
    expect(html).toContain(
      '<span class="ca-dsec-title">Zone 1</span><span class="ca-dsec-summary">Watering · 8 min left</span>',
    );
    expect(html).toContain('<div class="ca-dsec-aside"><button type="button">Skip</button></div>');
    expect(html).toMatch(/^<div class="ca-dsec ca-dsec-closed x">/);
  });
});
