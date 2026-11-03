import type { Row } from "@casita/client";
import {
  Button,
  CopyChip,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconPicker,
  Menu,
  TextField,
} from "@casita/ui";
import { type FormEvent, useState } from "react";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { ConfirmRemove } from "../edit.tsx";
import { type AreaItem, areaList } from "../model.ts";

/** What the area dialog hands back: the name, and the icon ("" for the default). */
export interface AreaDraft {
  name: string;
  icon: string;
}

/** A dialog for a new area, or an old one's name and icon. */
function AreaDialog({
  title,
  initial,
  action,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: AreaDraft;
  action: string;
  onClose: () => void;
  onSubmit: (draft: AreaDraft) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [busy, setBusy] = useState(false);
  const ready = name.trim() !== "" && (name.trim() !== initial.name || icon !== initial.icon);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    const done = await onSubmit({ name: name.trim(), icon });
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Dialog open title={title} onClose={onClose} size="md">
      <form className="app-form" onSubmit={submit}>
        <TextField
          label="Name"
          data-autofocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <IconPicker
          label="Icon"
          value={icon || undefined}
          fallback="house"
          onChange={(chosen) => setIcon(chosen ?? "")}
        />
        <div className="app-form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function Areas() {
  const house = useHouse();
  const store = useStore();
  const admin = useIsAdmin();
  const act = useAction();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<AreaItem | null>(null);
  const [removing, setRemoving] = useState<AreaItem | null>(null);
  const rows = areaList(house);

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Areas</h1>
        {admin ? (
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add area
          </Button>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <EmptyState
          icon="map"
          title="No areas yet"
          description="An area is a room or a zone. Put devices in one and Home groups them by it."
        />
      ) : (
        <DataTable<AreaItem>
          rows={rows}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-name">
                  <Icon name={row.icon ?? "house"} size={18} />
                  {row.name}
                </span>
              ),
            },
            { key: "id", label: "Id", render: (row) => <CopyChip value={row.id} /> },
            { key: "devices", label: "Devices", align: "right" },
            { key: "entities", label: "Entities", align: "right" },
            {
              key: "more",
              label: "",
              align: "right",
              width: 44,
              render: (row) =>
                admin ? (
                  <Menu
                    size="sm"
                    label={`${row.name} actions`}
                    items={[
                      { label: "Edit", icon: "pencil", onSelect: () => setRenaming(row) },
                      {
                        label: "Remove",
                        icon: "trash-2",
                        tone: "danger",
                        onSelect: () => setRemoving(row),
                      },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      )}
      {adding ? (
        <AreaDialog
          title="Add an area"
          initial={{ name: "", icon: "" }}
          action="Add"
          onClose={() => setAdding(false)}
          onSubmit={({ name, icon }) =>
            act(`Added ${name}`, `Couldn't add ${name}`, async () => {
              const area = (await store.request("create_area", { name })) as Row;
              if (icon) await store.request("update_area", { areaId: String(area.id), icon });
            })
          }
        />
      ) : null}
      {renaming ? (
        <AreaDialog
          title={`Edit ${renaming.name}`}
          initial={{ name: renaming.name, icon: renaming.icon ?? "" }}
          action="Save"
          onClose={() => setRenaming(null)}
          onSubmit={({ name, icon }) =>
            act(`Saved ${name}`, `Couldn't save ${renaming.name}`, () =>
              store.request("update_area", {
                areaId: renaming.id,
                name: name === renaming.name ? undefined : name,
                icon: icon === (renaming.icon ?? "") ? undefined : icon || null,
              }),
            )
          }
        />
      ) : null}
      <ConfirmRemove
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""}?`}
        description={
          removing && removing.devices + removing.entities > 0
            ? "Its devices and entities are kept; they will be in no area."
            : "Nothing is in it."
        }
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          act(`Removed ${removing?.name}`, `Couldn't remove ${removing?.name}`, () =>
            store.request("delete_area", { areaId: removing?.id ?? "" }),
          )
        }
      />
    </div>
  );
}
