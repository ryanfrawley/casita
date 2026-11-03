import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";

describe("Button", () => {
  test("a secondary, medium button of type button by default", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toBe(
      '<button type="button" class="ca-btn ca-btn-secondary ca-btn-md">Save</button>',
    );
  });

  test("variant, size and className become classes", () => {
    for (const variant of ["primary", "secondary", "quiet", "danger"] as const) {
      expect(renderToStaticMarkup(<Button variant={variant}>x</Button>)).toContain(
        `class="ca-btn ca-btn-${variant} ca-btn-md"`,
      );
    }
    expect(
      renderToStaticMarkup(
        <Button size="sm" className="wide">
          x
        </Button>,
      ),
    ).toContain('class="ca-btn ca-btn-secondary ca-btn-sm wide"');
  });

  test("an icon comes before the text: 18px, or 16px when small", () => {
    const md = renderToStaticMarkup(<Button icon="plus">Add</Button>);
    expect(md).toMatch(/^<button[^>]*><svg class="ca-icon" width="18"[\s\S]*<\/svg>Add<\/button>$/);
    expect(
      renderToStaticMarkup(
        <Button icon="plus" size="sm">
          Add
        </Button>,
      ),
    ).toContain('width="16"');
  });

  test("busy puts a spinner in the icon's place, says so, and ignores presses", () => {
    const html = renderToStaticMarkup(
      <Button icon="lock" busy onClick={() => {}}>
        Lock
      </Button>,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toMatch(/<svg class="ca-icon ca-spin"[\s\S]*<\/svg>Lock<\/button>$/);
    expect(html).not.toContain(" disabled");
    const idle = renderToStaticMarkup(<Button icon="lock">Lock</Button>);
    expect(idle).not.toContain("aria-busy");
    expect(idle).not.toContain("ca-spin");
  });

  test("other attributes pass through, and type can be overridden", () => {
    const html = renderToStaticMarkup(
      <Button type="submit" disabled aria-label="Send now" data-x="1">
        Send
      </Button>,
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Send now"');
    expect(html).toContain('data-x="1"');
  });
});

describe("IconButton", () => {
  test("the label is both its accessible name and its tooltip", () => {
    const html = renderToStaticMarkup(<IconButton icon="x" label="Close" />);
    expect(html).toStartWith(
      '<button type="button" aria-label="Close" title="Close" class="ca-iconbtn ca-iconbtn-md ca-iconbtn-quiet">',
    );
    expect(html).toContain('<svg class="ca-icon" width="20"');
    expect(html).not.toContain("aria-pressed");
  });

  test("small draws a 16px icon; variant and className add classes", () => {
    const html = renderToStaticMarkup(
      <IconButton icon="x" label="Close" size="sm" variant="secondary" className="x" />,
    );
    expect(html).toContain('class="ca-iconbtn ca-iconbtn-sm ca-iconbtn-secondary x"');
    expect(html).toContain('width="16"');
  });

  test("pressed makes it a toggle button, false included", () => {
    expect(renderToStaticMarkup(<IconButton icon="x" label="Mute" pressed />)).toContain(
      'aria-pressed="true"',
    );
    expect(renderToStaticMarkup(<IconButton icon="x" label="Mute" pressed={false} />)).toContain(
      'aria-pressed="false"',
    );
  });

  test("other attributes pass through", () => {
    expect(renderToStaticMarkup(<IconButton icon="x" label="Close" disabled />)).toContain(
      'disabled=""',
    );
  });
});
