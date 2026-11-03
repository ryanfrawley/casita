import {
  Badge,
  CopyChip,
  DataTable,
  EmptyState,
  IconButton,
  PillGroup,
  TextField,
} from "@casita/ui";
import { useState } from "react";
import { useHouse } from "../context.tsx";
import { EntityDetail } from "../detail.tsx";
import { domainCounts, type EntityItem, entityList } from "../model.ts";

/** An empty cell, said so rather than left blank. */
export const None = () => (
  <span className="app-muted" aria-label="None">
    —
  </span>
);

const TONE = { on: "on", off: "neutral", pending: "pending", unavailable: "unavailable" } as const;

export function Entities() {
  const house = useHouse();
  const [domains, setDomains] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const rows = entityList(house, { domains, query });

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Entities</h1>
        <TextField
          label="Find"
          hideLabel
          type="search"
          placeholder="A name, an id or an area"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>
      <PillGroup
        label="Domain"
        options={domainCounts(house)}
        allCount={house.entities.length}
        value={domains}
        onChange={setDomains}
      />
      {rows.length === 0 ? (
        <EmptyState
          size="inline"
          icon="search"
          title={house.entities.length ? "Nothing matches" : "No entities yet"}
          description={
            house.entities.length
              ? undefined
              : "They appear here as integrations find your devices."
          }
        />
      ) : (
        <DataTable<EntityItem>
          caption={
            rows.length === house.entities.length
              ? `${rows.length} entities`
              : `${rows.length} of ${house.entities.length}`
          }
          rows={rows}
          onRowClick={(row) => setOpen(row.id)}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-name">
                  {row.view.name}
                  {row.flags.map((flag) => (
                    <Badge key={flag}>{flag}</Badge>
                  ))}
                </span>
              ),
            },
            { key: "id", label: "Id", render: (row) => <CopyChip value={row.id} /> },
            { key: "area", label: "Area", render: (row) => row.area ?? <None /> },
            {
              key: "device",
              label: "Device",
              render: (row) => <span className="app-nowrap">{row.device ?? <None />}</span>,
            },
            {
              key: "state",
              label: "State",
              render: (row) => <Badge tone={TONE[row.view.state]}>{row.view.summary}</Badge>,
            },
            {
              key: "open",
              label: "",
              align: "right",
              width: 44,
              render: (row) => (
                <IconButton
                  icon="chevron-right"
                  label={`${row.view.name} details`}
                  size="sm"
                  onClick={() => setOpen(row.id)}
                />
              ),
            },
          ]}
        />
      )}
      <EntityDetail entityId={open} onClose={() => setOpen(null)} onRenamed={setOpen} />
    </div>
  );
}
