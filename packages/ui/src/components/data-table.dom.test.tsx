import { expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { DataTable } from "./data-table.tsx";

const dom = setupDom();

interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = [
  { id: "k", name: "Kettle" },
  { id: "l", name: "Lamp" },
];

test("a row click opens the row; a click on a control in the row is the control's", async () => {
  const opened: string[] = [];
  const pressed: string[] = [];
  const el = await dom.render(
    <DataTable<Row>
      rows={ROWS}
      onRowClick={(row) => opened.push(row.id)}
      columns={[
        { key: "name", label: "Name" },
        {
          key: "go",
          label: "",
          render: (row) => (
            <button type="button" onClick={() => pressed.push(row.id)}>
              Open
            </button>
          ),
        },
      ]}
    />,
  );
  const rows = el.querySelectorAll("tbody tr");
  expect(rows[0]?.className).toBe("ca-table-row-link");
  await dom.click(rows[1]?.querySelector("td"));
  expect(opened).toEqual(["l"]);
  await dom.click(rows[0]?.querySelector("button"));
  expect(pressed).toEqual(["k"]);
  expect(opened).toEqual(["l"]);
});

test("without onRowClick a row is plain", async () => {
  const el = await dom.render(
    <DataTable<Row> rows={ROWS} columns={[{ key: "name", label: "Name" }]} />,
  );
  expect(el.querySelector("tbody tr")?.className).toBe("");
});
