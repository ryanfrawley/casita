import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { Area } from "./area.tsx";
import { Badge } from "./badge.tsx";

// The masonry hook is a layout effect, which the server renderer warns about; that warning is
// expected here and only clutters the output.
const consoleError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
    consoleError(...args);
  };
});
afterAll(() => {
  console.error = consoleError;
});

describe("Area", () => {
  test("a section named by the area: arch icon, name, subtitle, id as tooltip", () => {
    const html = renderToStaticMarkup(
      <Area name="Kitchen" subtitle="2 devices · 5 entities" areaId="kitchen">
        <div>card</div>
      </Area>,
    );
    expect(html).toMatch(/^<section class="ca-area" aria-label="Kitchen" title="kitchen">/);
    expect(html).toContain(
      `<span class="ca-area-icon">${renderToStaticMarkup(<Icon name="house" size={22} />)}</span>`,
    );
    expect(html).toContain('<h2 class="ca-area-name">Kitchen</h2>');
    expect(html).toContain('<span class="ca-area-sub">2 devices · 5 entities</span>');
    expect(html).toMatch(/<div id="[^"]+" class="ca-area-grid"><div>card<\/div><\/div>/);
  });

  test("active lights the icon", () => {
    expect(renderToStaticMarkup(<Area name="x" icon="warehouse" active />)).toContain(
      `<span class="ca-area-icon ca-area-icon-on">${renderToStaticMarkup(<Icon name="warehouse" size={22} />)}</span>`,
    );
  });

  test("facts are badges, each tone mapped and alert drawn as error", () => {
    const html = renderToStaticMarkup(
      <Area
        name="x"
        facts={[
          { label: "2 lights on", tone: "on" },
          { label: "Window open", tone: "alert" },
          { label: "All locked", tone: "ok", icon: "lock" },
          { label: "Sensor offline", tone: "unavailable" },
          { label: "21 °C", icon: "thermometer" },
        ]}
      />,
    );
    const badges = [
      <Badge key="a" tone="on">
        2 lights on
      </Badge>,
      <Badge key="b" tone="error">
        Window open
      </Badge>,
      <Badge key="c" tone="ok" icon="lock">
        All locked
      </Badge>,
      <Badge key="d" tone="unavailable">
        Sensor offline
      </Badge>,
      <Badge key="e" tone="neutral" icon="thermometer">
        21 °C
      </Badge>,
    ].map((badge) => `<li>${renderToStaticMarkup(badge)}</li>`);
    expect(html).toContain(`<ul class="ca-area-facts">${badges.join("")}</ul>`);
    expect(renderToStaticMarkup(<Area name="x" facts={[]} />)).not.toContain("ca-area-facts");
  });

  test("a menu sits at the end of the title line, after any actions", () => {
    const html = renderToStaticMarkup(
      <Area name="x" actions={<button type="button">Off</button>} menu={<span>…</span>} />,
    );
    expect(html).toContain(
      '<div class="ca-area-actions"><button type="button">Off</button></div><div class="ca-area-menu"><span>…</span></div>',
    );
    expect(renderToStaticMarkup(<Area name="x" />)).not.toContain("ca-area-menu");
  });

  test("with nothing in it, the empty line names the area", () => {
    expect(renderToStaticMarkup(<Area name="Attic" />)).toContain(
      '<p class="ca-area-empty">Nothing in Attic yet. Assign devices to this area from the Devices page.</p>',
    );
    // Children that render nothing count as nothing.
    expect(renderToStaticMarkup(<Area name="Attic">{null}</Area>)).toContain("ca-area-empty");
    expect(renderToStaticMarkup(<Area name="Attic">{false}</Area>)).toContain("ca-area-empty");
  });

  test("a custom empty line replaces the default", () => {
    const html = renderToStaticMarkup(<Area name="Attic" empty="No devices here." />);
    expect(html).toContain('<p class="ca-area-empty">No devices here.</p>');
    expect(html).not.toContain("Nothing in Attic");
  });

  test("children replace the empty line", () => {
    expect(
      renderToStaticMarkup(
        <Area name="x">
          <div>card</div>
        </Area>,
      ),
    ).not.toContain("ca-area-empty");
  });

  test("minColumnWidth sets --area-col on the grid", () => {
    expect(renderToStaticMarkup(<Area name="x" minColumnWidth={280} />)).toMatch(
      /class="ca-area-grid" style="--area-col:280px"/,
    );
    expect(renderToStaticMarkup(<Area name="x" />)).not.toContain("--area-col");
  });

  test("not collapsible: a static heading and no button", () => {
    const html = renderToStaticMarkup(<Area name="x" defaultOpen={false} />);
    expect(html).toContain('<div class="ca-area-toggle ca-area-static">');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("ca-area-chevron");
    expect(html).toContain("ca-area-grid");
  });

  test("collapsible: a button with a chevron that controls the grid", () => {
    const html = renderToStaticMarkup(<Area name="x" collapsible />);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain('<button type="button" class="ca-area-toggle" aria-expanded="true"');
    expect(html).toContain(`id="${controls}" class="ca-area-grid"`);
    expect(html).toContain(
      renderToStaticMarkup(<Icon name="chevron-down" size={18} className="ca-area-chevron" />),
    );
  });

  test("bare: no heading row at all, so no title, facts, actions or menu; the grid stays", () => {
    const html = renderToStaticMarkup(
      <Area
        name="Kitchen"
        bare
        facts={[{ label: "Window open", tone: "alert" }]}
        actions={<button type="button">All off</button>}
        menu={<span>…</span>}
      >
        <div>card</div>
      </Area>,
    );
    expect(html).toMatch(/^<section class="ca-area ca-area-bare" aria-label="Kitchen">/);
    expect(html).not.toContain("<header");
    expect(html).not.toContain("ca-area-name");
    expect(html).not.toContain("Window open");
    expect(html).not.toContain("All off");
    expect(html).not.toContain("ca-area-menu");
    expect(html).toMatch(/<div id="[^"]+" class="ca-area-grid"><div>card<\/div><\/div>/);
  });

  test("bare cannot be closed: collapsible and closed, its contents still show", () => {
    const html = renderToStaticMarkup(
      <Area name="x" bare collapsible defaultOpen={false}>
        <div>card</div>
      </Area>,
    );
    expect(html).not.toContain("ca-area-closed");
    expect(html).not.toContain("<button");
    expect(html).toContain("<div>card</div>");
  });

  test("an icon of null draws no icon box; the title stays", () => {
    const html = renderToStaticMarkup(<Area name="Kitchen" icon={null} subtitle="2 devices" />);
    expect(html).not.toContain("ca-area-icon");
    expect(html).toContain('<h2 class="ca-area-name">Kitchen</h2>');
    expect(html).toContain('<span class="ca-area-sub">2 devices</span>');
  });

  test("an empty name draws no title or subtitle and labels nothing; the icon stays", () => {
    const html = renderToStaticMarkup(<Area name="" icon="warehouse" subtitle="2 devices" />);
    expect(html).toMatch(/^<section class="ca-area">/);
    expect(html).not.toContain("aria-label");
    expect(html).not.toContain("ca-area-titles");
    expect(html).not.toContain("2 devices");
    expect(html).toContain(
      `<span class="ca-area-icon">${renderToStaticMarkup(<Icon name="warehouse" size={22} />)}</span>`,
    );
    // The empty line, with no name to give, speaks of the area.
    expect(html).toContain(
      '<p class="ca-area-empty">Nothing in this area yet. Assign devices to this area from the Devices page.</p>',
    );
  });

  test("an empty name keeps the chevron of a collapsible area, to open and close it by", () => {
    const html = renderToStaticMarkup(<Area name="" icon={null} collapsible />);
    expect(html).toContain('<button type="button" class="ca-area-toggle" aria-expanded="true"');
    expect(html).toContain(
      renderToStaticMarkup(<Icon name="chevron-down" size={18} className="ca-area-chevron" />),
    );
  });

  test("collapsible and closed: no grid, but facts and actions stay", () => {
    const html = renderToStaticMarkup(
      <Area
        name="x"
        collapsible
        defaultOpen={false}
        facts={[{ label: "Window open", tone: "alert" }]}
        actions={<button type="button">All off</button>}
        className="y"
      >
        <div>card</div>
      </Area>,
    );
    expect(html).toMatch(/^<section class="ca-area ca-area-closed y"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("ca-area-grid");
    expect(html).not.toContain("<div>card</div>");
    expect(html).toContain("Window open");
    expect(html).toContain(
      '<div class="ca-area-actions"><button type="button">All off</button></div>',
    );
  });
});
