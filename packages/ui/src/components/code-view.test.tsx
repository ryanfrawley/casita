import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatTime, formatWhen } from "../time.ts";
import { CodeView } from "./code-view.tsx";
import { Timestamp } from "./timestamp.tsx";

const rows = (html: string) => html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const gutters = (html: string) =>
  [...html.matchAll(/<td class="ca-code-gutter">([^<]*)<\/td>/g)].map((m) => m[1]);
const texts = (html: string) =>
  [...html.matchAll(/<td class="ca-code-text">([^<]*)/g)].map((m) => m[1]);

describe("CodeView", () => {
  test("a figure holding a focusable, named region of numbered lines", () => {
    const html = renderToStaticMarkup(<CodeView code={"a: 1\nb: 2"} />);
    expect(html).toStartWith(
      '<figure class="ca-code"><div class="ca-code-scroll" tabindex="0" role="region" aria-label="Code">',
    );
    expect(gutters(html)).toEqual(["1", "2"]);
    expect(texts(html)).toEqual(["a: 1", "b: 2"]);
    expect(html).not.toContain("figcaption");
  });

  test("one trailing newline is dropped, but not an empty line before it", () => {
    expect(texts(renderToStaticMarkup(<CodeView code={"a\nb\n"} />))).toEqual(["a", "b"]);
    expect(rows(renderToStaticMarkup(<CodeView code={"a\n\n"} />))).toHaveLength(2);
  });

  test("an empty line keeps a zero-width character so it has height", () => {
    expect(texts(renderToStaticMarkup(<CodeView code={"a\n\nb"} />))).toEqual(["a", "​", "b"]);
  });

  test("lines may be strings or objects with a gutter, tone and message", () => {
    const html = renderToStaticMarkup(
      <CodeView
        lines={[
          "plain",
          { text: "warn", tone: "error", message: "Unknown key" },
          { text: "later", gutter: "+", tone: "muted" },
        ]}
      />,
    );
    const [plain, error, muted] = rows(html);
    expect(plain).toStartWith('<tr class="ca-code-line">');
    expect(error).toStartWith('<tr class="ca-code-line ca-code-error">');
    expect(error).toContain('<span class="ca-code-msg"><svg');
    expect(error).toContain("Unknown key</span>");
    expect(error).toContain('<path d="M12 9v4"');
    expect(muted).toStartWith('<tr class="ca-code-line ca-code-muted">');
    expect(gutters(html)).toEqual(["1", "2", "+"]);
  });

  test("marks flag lines by number, counted from startLine", () => {
    const html = renderToStaticMarkup(
      <CodeView
        code={"one\ntwo\nthree"}
        startLine={10}
        marks={[
          { line: 11, tone: "error", message: "Bad indent" },
          { line: 12, tone: "info" },
          { line: 2, tone: "error", message: "never shown" },
        ]}
      />,
    );
    const [one, two, three] = rows(html);
    expect(gutters(html)).toEqual(["10", "11", "12"]);
    expect(one).toStartWith('<tr class="ca-code-line">');
    expect(two).toStartWith('<tr class="ca-code-line ca-code-error">');
    expect(two).toContain("Bad indent");
    expect(three).toStartWith('<tr class="ca-code-line ca-code-info">');
    expect(three).not.toContain("ca-code-msg");
    expect(html).not.toContain("never shown");
  });

  test("an info mark's message uses the info icon", () => {
    const html = renderToStaticMarkup(
      <CodeView code="x" marks={[{ line: 1, tone: "info", message: "Deprecated" }]} />,
    );
    expect(html).toContain('<circle cx="12" cy="12" r="10"');
    expect(html).toContain("Deprecated");
  });

  test("a mark beats the line's own tone", () => {
    const html = renderToStaticMarkup(
      <CodeView lines={[{ text: "x", tone: "muted" }]} marks={[{ line: 1, tone: "error" }]} />,
    );
    expect(rows(html)[0]).toStartWith('<tr class="ca-code-line ca-code-error">');
  });

  test("lineNumbers={false} leaves out the gutter", () => {
    expect(renderToStaticMarkup(<CodeView code="x" lineNumbers={false} />)).not.toContain(
      "ca-code-gutter",
    );
  });

  test("code beats lines", () => {
    expect(
      texts(renderToStaticMarkup(<CodeView code="from code" lines={["from lines"]} />)),
    ).toEqual(["from code"]);
  });

  test("a title heads the figure and names the region; else label does", () => {
    const html = renderToStaticMarkup(
      <CodeView
        code="x"
        title="automations.yaml"
        label="ignored"
        actions={<button type="button">Copy</button>}
      />,
    );
    expect(html).toContain(
      '<figcaption class="ca-code-head"><span class="ca-code-title">automations.yaml</span><span class="ca-code-actions"><button type="button">Copy</button></span></figcaption>',
    );
    expect(html).toContain('aria-label="automations.yaml"');
    expect(renderToStaticMarkup(<CodeView code="x" label="Log" />)).toContain('aria-label="Log"');
  });

  test("wrap, maxHeight and className", () => {
    const html = renderToStaticMarkup(<CodeView code="x" wrap maxHeight={200} className="x" />);
    expect(html).toContain('<figure class="ca-code ca-code-wrap x">');
    expect(html).toContain('style="max-height:200px"');
  });
});

describe("Timestamp", () => {
  const now = new Date(2026, 5, 10, 12, 0);
  const value = new Date(2026, 5, 10, 11, 56);

  test("a time element with the ISO date, the full date as its tooltip, and the relative text", () => {
    const html = renderToStaticMarkup(<Timestamp value={value} now={now} />);
    expect(html).toBe(
      `<time class="ca-time" dateTime="${value.toISOString()}" title="${formatWhen(value.getTime())}">4 min ago</time>`,
    );
  });

  test("a prefix goes before the time", () => {
    const html = renderToStaticMarkup(<Timestamp value={value} now={now} prefix="Updated" />);
    expect(html).toMatch(/>Updated 4 min ago<\/time>$/);
  });

  test("format is passed through", () => {
    const html = renderToStaticMarkup(<Timestamp value={value} now={now} format="date" />);
    expect(html).toContain(">Wed 10 Jun</time>");
    expect(renderToStaticMarkup(<Timestamp value={value} format="clock" />)).toContain(
      `>${formatTime(value, { format: "clock" })}</time>`,
    );
  });

  test("a numeric string is epoch milliseconds", () => {
    const html = renderToStaticMarkup(<Timestamp value={String(value.getTime())} now={now} />);
    expect(html).toContain(`dateTime="${value.toISOString()}"`);
  });

  test("an invalid date is a dash, with no dateTime or tooltip", () => {
    expect(renderToStaticMarkup(<Timestamp value="soon" className="x" />)).toBe(
      '<time class="ca-time x">—</time>',
    );
  });
});
