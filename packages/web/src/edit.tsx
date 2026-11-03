// The forms an admin changes things with, and the dialog that asks before removing one.

import type { Row } from "@casita/client";
import { Button, Checkbox, Dialog, IconPicker, Select, TextField } from "@casita/ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAction, useHouse, useStore } from "./context.tsx";
import {
  classOptions,
  defaultDeviceIcon,
  defaultEntityIcon,
  deviceDraft,
  deviceDraftErrors,
  devicePatch,
  entityDraft,
  entityDraftErrors,
  entityPatch,
} from "./model.ts";

/** A destructive action, named, with what it will take with it. */
export function ConfirmRemove({
  open,
  title,
  description,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      tone="danger"
      title={title}
      description={description}
      onClose={onClose}
      actions={
        <>
          <Button data-autofocus onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm();
              setBusy(false);
              onClose();
            }}
          >
            Remove
          </Button>
        </>
      }
    />
  );
}

function AreaSelect({
  value,
  onChange,
  none,
}: {
  value: string;
  onChange: (value: string) => void;
  none: string;
}) {
  const { areas } = useHouse();
  return (
    <Select
      label="Area"
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: none },
        ...areas
          .map((area) => ({ value: String(area.id), label: String(area.name) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ]}
    />
  );
}

export function EntityEditor({ entity, onRemoved }: { entity: Row; onRemoved: () => void }) {
  const store = useStore();
  const act = useAction();
  const house = useHouse();
  const [draft, setDraft] = useState(() => entityDraft(entity));
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft((old) => ({ ...old, ...patch }));
  const errors = entityDraftErrors(draft, entity);
  const patch = entityPatch(draft, entity);
  const classes = classOptions(String(entity.domain));
  const effective = (entity.effectiveRetention as { raw?: number } | undefined)?.raw;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!patch || Object.keys(errors).length) return;
    setBusy(true);
    await act(`Saved ${draft.name.trim()}`, `Couldn't save ${entity.name}`, () =>
      store.request("update_entity", { entityId: String(entity.id), ...patch }),
    );
    setBusy(false);
  };

  return (
    <form className="app-form" onSubmit={save}>
      <h3 className="ca-text-heading">Settings</h3>
      <TextField
        label="Name"
        value={draft.name}
        error={errors.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <TextField
        label="Entity id"
        mono
        value={draft.id}
        error={errors.id}
        hint="Automations and scripts that use the old id keep working through an alias."
        spellCheck={false}
        onChange={(event) => set({ id: event.target.value })}
      />
      <AreaSelect
        value={draft.areaId}
        onChange={(areaId) => set({ areaId })}
        none={entity.deviceId ? "Same as its device" : "None"}
      />
      <IconPicker
        label="Icon"
        value={draft.icon || undefined}
        fallback={
          defaultEntityIcon(entity, (house.states.get(String(entity.id))?.state as Row) ?? {}) ??
          String(entity.domain)
        }
        onChange={(icon) => set({ icon: icon ?? "" })}
      />
      {classes.length ? (
        <Select
          label="Kind"
          value={draft.deviceClass}
          onChange={(deviceClass) => set({ deviceClass })}
          options={classes}
        />
      ) : null}
      <Checkbox
        label="Hidden"
        hint="Left off Home; still recorded and usable in automations."
        checked={draft.hidden}
        onChange={(hidden) => set({ hidden })}
      />
      <Checkbox
        label="Disabled"
        hint="Ignored entirely: no state, no history, no commands."
        checked={draft.disabled}
        onChange={(disabled) => set({ disabled })}
      />
      <TextField
        label="Keep raw history for"
        inputMode="numeric"
        value={draft.rawDays}
        error={errors.rawDays}
        placeholder={effective ? `${effective} (default)` : "Default"}
        hint="Days. Leave empty to use the default."
        onChange={(event) => set({ rawDays: event.target.value.trim() })}
      />
      <div className="app-form-actions">
        <Button variant="quiet" icon="trash-2" onClick={() => setRemoving(true)}>
          Remove
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !patch || Object.keys(errors).length > 0}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <ConfirmRemove
        open={removing}
        title={`Remove ${entity.name}?`}
        description={
          entity.orphaned
            ? "Its integration is no longer loaded, so it will not come back. Its history is removed with it."
            : "Its history is removed with it. If its integration still reports it, it will be added again as new."
        }
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          const removed = await act(
            `Removed ${entity.name}`,
            `Couldn't remove ${entity.name}`,
            () => store.request("delete_entity", { entityId: String(entity.id) }),
          );
          if (removed) onRemoved();
        }}
      />
    </form>
  );
}

export function DeviceEditor({ device, onRemoved }: { device: Row; onRemoved: () => void }) {
  const store = useStore();
  const act = useAction();
  const house = useHouse();
  const [draft, setDraft] = useState(() => deviceDraft(device));
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft((old) => ({ ...old, ...patch }));
  const errors = deviceDraftErrors(draft);
  const patch = devicePatch(draft, device);
  const fallback = defaultDeviceIcon(
    device,
    house.entities
      .filter((entity) => entity.deviceId === device.id)
      .map((entity) => ({ domain: String(entity.domain) })),
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!patch || Object.keys(errors).length) return;
    setBusy(true);
    await act(`Saved ${draft.name.trim()}`, `Couldn't save ${device.name}`, () =>
      store.request("update_device", { deviceId: String(device.id), ...patch }),
    );
    setBusy(false);
  };

  return (
    <form className="app-form" onSubmit={save}>
      <h3 className="ca-text-heading">Settings</h3>
      <TextField
        label="Name"
        value={draft.name}
        error={errors.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      <TextField
        label="Device id"
        mono
        value={draft.id}
        error={errors.id}
        hint={`Pages and automations name it as device.${draft.id || "…"}; they do not follow a change.`}
        spellCheck={false}
        onChange={(event) => set({ id: event.target.value })}
      />
      <AreaSelect value={draft.areaId} onChange={(areaId) => set({ areaId })} none="None" />
      <IconPicker
        label="Icon"
        value={draft.icon || undefined}
        fallback={fallback}
        onChange={(chosen) => set({ icon: chosen ?? "" })}
      />
      <div className="app-form-actions">
        <Button variant="quiet" icon="trash-2" onClick={() => setRemoving(true)}>
          Remove
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !patch || Object.keys(errors).length > 0}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <ConfirmRemove
        open={removing}
        title={`Remove ${device.name}?`}
        description="Its entities and their history are removed with it. If its integration still reports it, it will be added again as new."
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          const removed = await act(
            `Removed ${device.name}`,
            `Couldn't remove ${device.name}`,
            () => store.request("delete_device", { deviceId: String(device.id) }),
          );
          if (removed) onRemoved();
        }}
      />
    </form>
  );
}
