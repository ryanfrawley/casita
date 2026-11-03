import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable } from "./data-table.tsx";
import { EmptyState } from "./empty-state.tsx";
import { Skeleton } from "./skeleton.tsx";

interface Row {
  id: string;
  name: string;
  watts: number;
}
const ROWS: Row[] = [
  { id: "k", name: "Kettle", watts: 2200 },
  { id: "l", name: "Lamp", watts: 9 },
];

describe("DataTable", () => {
  test("a header row of column labels and a row per item, showing the field named by key", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        columns={[
          { key: "name", label: "Name" },
          { key: "watts", label: "Power" },
        ]}
        rows={ROWS}
      />,
    );
    expect(html).toStartWith('<div class="ca-table-wrap"><table class="ca-table"><thead>');
    expect(html).toContain(
      '<th scope="col" style="text-align:left">Name</th><th scope="col" style="text-align:left">Power</th>',
    );
    expect(html).toContain(
      '<tr><td style="text-align:left">Kettle</td><td style="text-align:left">2200</td></tr>',
    );
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).not.toContain("<caption");
  });

  test("render beats the field", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        columns={[{ key: "watts", label: "Power", render: (row) => <b>{row.watts} W</b> }]}
        rows={ROWS}
      />,
    );
    expect(html).toContain("<b>9 W</b>");
    expect(html).not.toContain(">9</td>");
  });

  test("align applies to the header and the cells; width only to the header", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row>
        columns={[{ key: "watts", label: "W", align: "right", width: 120 }]}
        rows={ROWS}
      />,
    );
    expect(html).toContain('<th scope="col" style="text-align:right;width:120px">W</th>');
    expect(html).toContain('<td style="text-align:right">2200</td>');
  });

  test("mono marks the cells, not the header", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> columns={[{ key: "id", label: "Id", mono: true }]} rows={ROWS} />,
    );
    expect(html).toContain('<td class="ca-mono" style="text-align:left">k</td>');
    expect(html).toContain('<th scope="col" style="text-align:left">Id</th>');
  });

  test("caption, dense and className", () => {
    const html = renderToStaticMarkup(
      <DataTable<Row> columns={[]} rows={[]} caption="Devices" dense className="x" />,
    );
    expect(html).toBe(
      '<div class="ca-table-wrap x"><table class="ca-table ca-table-dense"><caption>Devices</caption><thead><tr></tr></thead><tbody></tbody></table></div>',
    );
  });
});

describe("EmptyState", () => {
  test("a page-sized state titles with an h2 and draws the house in the arch", () => {
    const html = renderToStaticMarkup(<EmptyState title="No devices yet" />);
    expect(html).toBe(
      `<div class="ca-empty ca-empty-page"><div class="ca-empty-arch" aria-hidden="true">${html.match(/<svg[\s\S]*<\/svg>/)?.[0]}</div><h2 class="ca-empty-title">No devices yet</h2></div>`,
    );
    expect(html).toContain('width="30"');
  });

  test("inline titles with an h3 and a smaller icon", () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here" size="inline" />);
    expect(html).toContain('class="ca-empty ca-empty-inline"');
    expect(html).toContain('<h3 class="ca-empty-title">Nothing here</h3>');
    expect(html).toContain('width="22"');
    expect(html).not.toContain("<h2");
  });

  test("description, actions, icon and className", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No scenes"
        description="Scenes set many devices at once."
        actions={<button type="button">Add</button>}
        icon="play"
        className="x"
      />,
    );
    expect(html).toContain('class="ca-empty ca-empty-page x"');
    expect(html).toContain('<p class="ca-empty-desc">Scenes set many devices at once.</p>');
    expect(html).toContain(
      '<div class="ca-empty-actions"><button type="button">Add</button></div>',
    );
    expect(html).toContain("<polygon");
  });
});

describe("Skeleton", () => {
  test("one text line by default, hidden from assistive technology", () => {
    expect(renderToStaticMarkup(<Skeleton />)).toBe(
      '<span class="ca-skel ca-skel-text" aria-hidden="true"></span>',
    );
  });

  test("block and circle take a width and height", () => {
    expect(renderToStaticMarkup(<Skeleton shape="block" width={120} height="4rem" />)).toBe(
      '<span class="ca-skel ca-skel-block" style="width:120px;height:4rem" aria-hidden="true"></span>',
    );
    expect(renderToStaticMarkup(<Skeleton shape="circle" className="x" />)).toBe(
      '<span class="ca-skel ca-skel-circle x" aria-hidden="true"></span>',
    );
  });

  test("several lines stack, full width but for the last at 60%", () => {
    const html = renderToStaticMarkup(<Skeleton lines={3} />);
    expect(html).toBe(
      '<span class="ca-skel-stack" aria-hidden="true">' +
        '<span class="ca-skel ca-skel-text" style="width:100%"></span>' +
        '<span class="ca-skel ca-skel-text" style="width:100%"></span>' +
        '<span class="ca-skel ca-skel-text" style="width:60%"></span></span>',
    );
  });

  test("width sets the lines and lastWidth the last one", () => {
    const html = renderToStaticMarkup(
      <Skeleton lines={2} width="80%" lastWidth="30%" className="x" />,
    );
    expect(html).toBe(
      '<span class="ca-skel-stack x" aria-hidden="true">' +
        '<span class="ca-skel ca-skel-text" style="width:80%"></span>' +
        '<span class="ca-skel ca-skel-text" style="width:30%"></span></span>',
    );
  });

  test("lines only stack text", () => {
    expect(renderToStaticMarkup(<Skeleton shape="block" lines={3} />)).toBe(
      '<span class="ca-skel ca-skel-block" aria-hidden="true"></span>',
    );
  });
});
