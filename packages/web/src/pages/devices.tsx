import { DataTable, EmptyState, IconButton, StatusDot, TextField } from "@casita/ui";
import { useState } from "react";
import { useHouse } from "../context.tsx";
import { DeviceDetail, EntityDetail } from "../detail.tsx";
import { type DeviceItem, deviceList } from "../model.ts";

/** A device named in the address (`?open=thermostat`) opens its sheet; the address then forgets it. */
function openedByAddress(): string | null {
  const open = new URLSearchParams(location.search).get("open");
  if (open) history.replaceState(null, "", location.pathname);
  return open;
}

export function Devices() {
  const house = useHouse();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(openedByAddress);
  // An entity pressed on the device's sheet opens over it; closing that comes back to the device.
  const [entity, setEntity] = useState<string | null>(null);
  const rows = deviceList(house, query);

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Devices</h1>
        <TextField
          label="Find"
          type="search"
          placeholder="A name, a maker or an integration"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>
      {rows.length === 0 ? (
        <EmptyState
          size="inline"
          icon="cpu"
          title={house.devices.length ? "Nothing matches" : "No devices yet"}
          description={
            house.devices.length ? undefined : "They appear here as integrations find them."
          }
        />
      ) : (
        <DataTable<DeviceItem>
          caption={`${rows.length} of ${house.devices.length}`}
          rows={rows}
          onRowClick={(row) => setOpen(row.id)}
          columns={[
            // The area first: a house has many "Motion Sensor"s, and the room tells them apart.
            { key: "area", label: "Area", render: (row) => row.area ?? "" },
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-name">
                  {row.name}
                  <StatusDot
                    status={row.status}
                    label={row.device.orphaned ? "Orphaned" : undefined}
                    size="sm"
                  />
                </span>
              ),
            },
            { key: "maker", label: "Maker and model" },
            { key: "integrationId", label: "Integration", mono: true },
            { key: "entities", label: "Entities", align: "right" },
            {
              key: "open",
              label: "",
              align: "right",
              width: 44,
              render: (row) => (
                <IconButton
                  icon="chevron-right"
                  label={`${row.name} details`}
                  size="sm"
                  onClick={() => setOpen(row.id)}
                />
              ),
            },
          ]}
        />
      )}
      <DeviceDetail
        deviceId={open}
        onClose={() => setOpen(null)}
        onOpenEntity={setEntity}
        onRenamed={setOpen}
      />
      <EntityDetail entityId={entity} onClose={() => setEntity(null)} onRenamed={setEntity} />
    </div>
  );
}
