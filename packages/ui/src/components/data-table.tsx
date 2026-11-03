import type { MouseEvent, ReactNode } from "react";
import { cx } from "../util.ts";

export interface DataTableColumn<R> {
  /** The row field shown when there is no `render`; also the column's key. */
  key: string;
  label: string;
  mono?: boolean;
  align?: "left" | "right" | "center";
  width?: number | string;
  render?: (row: R) => ReactNode;
}
export interface DataTableProps<R extends { id?: string | number }> {
  columns: DataTableColumn<R>[];
  rows: R[];
  caption?: string;
  dense?: boolean;
  className?: string;
  /**
   * Makes each row a target for the same thing its own button or link does, for a mouse or a
   * finger; a click on a control inside the row is that control's, not the row's. The row is
   * not focusable, so keep the control for the keyboard.
   */
  onRowClick?: (row: R) => void;
}

/** True for a click that landed on a control, which has its own job. */
const onControl = (event: MouseEvent<HTMLTableRowElement>): boolean =>
  (event.target as Element).closest("a, button, input, select, textarea, label") !== null;

export function DataTable<R extends { id?: string | number }>({
  columns,
  rows,
  caption,
  dense,
  className,
  onRowClick,
}: DataTableProps<R>) {
  return (
    <div className={cx("ca-table-wrap", className)}>
      <table className={cx("ca-table", dense && "ca-table-dense")}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ textAlign: column.align ?? "left", width: column.width }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              className={onRowClick ? "ca-table-row-link" : undefined}
              onClick={
                onRowClick &&
                ((event) => {
                  if (!onControl(event)) onRowClick(row);
                })
              }
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.mono ? "ca-mono" : undefined}
                  style={{ textAlign: column.align ?? "left" }}
                >
                  {column.render
                    ? column.render(row)
                    : ((row as Record<string, unknown>)[column.key] as ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
