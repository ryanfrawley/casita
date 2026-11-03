import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityCard } from "./entity-card.tsx";

describe("EntityCard", () => {
  test("a section named by the card, its id as the tooltip, the lamp accent by default", () => {
    const html = renderToStaticMarkup(<EntityCard name="Desk lamp" deviceId="dev_12" />);
    expect(html).toMatch(
      /^<section class="ca-ecard ca-ecard-lamp" aria-label="Desk lamp" title="dev_12">/,
    );
    expect(html).toContain('<h3 class="ca-ecard-name">Desk lamp</h3>');
    expect(html).not.toContain("ca-ecard-summary");
    expect(html).not.toContain("ca-ecard-actions");
    expect(html).not.toContain("ca-ecard-body");
  });

  test("the summary, actions and body are drawn only when given", () => {
    const html = renderToStaticMarkup(
      <EntityCard name="x" summary="On · 40%" actions={<button type="button">t</button>}>
        <input type="range" />
      </EntityCard>,
    );
    expect(html).toContain('<div class="ca-ecard-summary">On · 40%</div>');
    expect(html).toContain('<div class="ca-ecard-actions"><button type="button">t</button></div>');
    expect(html).toContain('<div class="ca-ecard-body"><input type="range"/></div>');
  });

  test("with onOpen, the icon and titles are one details button, and the actions stay outside it", () => {
    const html = renderToStaticMarkup(
      <EntityCard
        name="Porch light"
        onOpen={() => {}}
        actions={<button type="button">t</button>}
      />,
    );
    expect(html).toContain(
      '<button type="button" class="ca-ecard-open" aria-label="Porch light details"><span class="ca-ecard-icon">',
    );
    expect(html).toContain('</div></button><div class="ca-ecard-actions">');
    expect(renderToStaticMarkup(<EntityCard name="x" />)).not.toContain("ca-ecard-open");
  });

  test("active and the accent light the icon; a status adds its dot and class", () => {
    const html = renderToStaticMarkup(
      <EntityCard name="x" accent="sky" active status="unavailable" />,
    );
    expect(html).toContain('class="ca-ecard ca-ecard-sky ca-ecard-active ca-ecard-unavailable"');
    expect(html).toContain("ca-status");
  });
});
