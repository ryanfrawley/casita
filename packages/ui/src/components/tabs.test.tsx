import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { nextTab, type TabItem, Tabs } from "./tabs.tsx";

const TABS: TabItem[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
  { value: "d", label: "Delta" },
];
const next = (current: string | undefined, key: string) => nextTab(TABS, current, key)?.value;

describe("nextTab", () => {
  test("ArrowRight moves to the next enabled tab and wraps", () => {
    expect(next("a", "ArrowRight")).toBe("c");
    expect(next("c", "ArrowRight")).toBe("d");
    expect(next("d", "ArrowRight")).toBe("a");
  });

  test("ArrowLeft moves to the previous enabled tab and wraps", () => {
    expect(next("c", "ArrowLeft")).toBe("a");
    expect(next("a", "ArrowLeft")).toBe("d");
  });

  test("Home and End go to the first and last enabled tabs", () => {
    expect(next("c", "Home")).toBe("a");
    expect(next("a", "End")).toBe("d");
    const lastDisabled = [...TABS, { value: "e", label: "Eps", disabled: true }];
    expect(nextTab(lastDisabled, "a", "End")?.value).toBe("d");
  });

  test("any other key is undefined", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Tab", "a"]) {
      expect(next("a", key)).toBeUndefined();
    }
  });

  test("from no current tab, ArrowRight goes to the first enabled tab", () => {
    expect(next(undefined, "ArrowRight")).toBe("a");
    expect(next("b", "ArrowRight")).toBe("a");
  });

  test("with every tab disabled there is nowhere to go", () => {
    const none = TABS.map((tab) => ({ ...tab, disabled: true }));
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(nextTab(none, "a", key)).toBeUndefined();
    }
  });
});

describe("Tabs markup", () => {
  test("a labelled tablist whose first tab is selected and the only one in the Tab order", () => {
    const html = renderToStaticMarkup(<Tabs id="t" label="Sections" tabs={TABS} />);
    expect(html).toContain('<div role="tablist" aria-label="Sections" class="ca-tablist">');
    expect(html).toContain(
      '<button type="button" role="tab" id="t-a" data-value="a" aria-selected="true" tabindex="0" class="ca-tab ca-tab-on">',
    );
    expect(html).toContain('id="t-c" data-value="c" aria-selected="false" tabindex="-1"');
    expect(html).toMatch(/id="t-b"[^>]*disabled=""/);
  });

  test("without children there is no panel and tabs control nothing", () => {
    const html = renderToStaticMarkup(<Tabs id="t" label="Sections" tabs={TABS} />);
    expect(html).not.toContain("tabpanel");
    expect(html).not.toContain("aria-controls");
  });

  test("with children the panel is labelled by the selected tab, which controls it", () => {
    const html = renderToStaticMarkup(
      <Tabs id="t" label="Sections" tabs={TABS} defaultValue="c">
        <p>Body</p>
      </Tabs>,
    );
    expect(html).toContain('aria-controls="t-panel"');
    expect(html).toMatch(/id="t-c"[^>]*aria-selected="true"/);
    expect(html).toContain(
      '<div role="tabpanel" id="t-panel" aria-labelledby="t-c" class="ca-tabpanel" tabindex="0"><p>Body</p></div>',
    );
  });

  test("a function child is given the selected value", () => {
    const html = renderToStaticMarkup(
      <Tabs id="t" label="Sections" tabs={TABS} value="d">
        {(value) => <p>showing {value}</p>}
      </Tabs>,
    );
    expect(html).toContain("<p>showing d</p>");
  });

  test("`value` beats `defaultValue`", () => {
    const html = renderToStaticMarkup(
      <Tabs id="t" label="Sections" tabs={TABS} value="d" defaultValue="c" />,
    );
    expect(html).toMatch(/id="t-d"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="t-c"[^>]*aria-selected="false"/);
  });

  test("icons and counts", () => {
    const html = renderToStaticMarkup(
      <Tabs label="Sections" tabs={[{ value: "a", label: "Alerts", icon: "info", count: 0 }]} />,
    );
    expect(html).toContain('<svg class="ca-icon" width="18"');
    expect(html).toContain('<span class="ca-tab-count">0</span>');
  });

  test("without an id the panel still names a tab that exists", () => {
    const html = renderToStaticMarkup(
      <Tabs label="Sections" tabs={TABS}>
        x
      </Tabs>,
    );
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${labelledBy}" data-value="a"`);
  });
});
