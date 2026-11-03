// A thing of the house in a sheet: an entity with its control, its id and what it has been
// doing; a device with what is on it; an area with what is in it.

import { CasitaError, type Row } from "@casita/client";
import {
  Button,
  CopyChip,
  DeviceCard,
  EmptyState,
  Icon,
  SegmentedControl,
  Sheet,
  Skeleton,
  StateTimeline,
  TimeSeriesChart,
  Timestamp,
} from "@casita/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useHouse, useIsAdmin, useStore } from "./context.tsx";
import { ClimateCard, EntityControls, EntityDimmer, EntityLine } from "./controls.tsx";
import { DeviceEditor, EntityEditor } from "./edit.tsx";
import {
  areaList,
  deviceEntities,
  deviceList,
  entityView,
  type HistoryView,
  hasDeviceSettings,
  historyKind,
  historyView,
} from "./model.ts";
import { deviceSettingsPath } from "./routes.ts";
import { useNavigate } from "./shell.tsx";

/** A way to the device's settings, for an admin, when its integration keeps any. */
function SettingsLink({ deviceId, label }: { deviceId: unknown; label: string }) {
  const house = useHouse();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const device = house.devices.find((candidate) => candidate.id === deviceId);
  if (!admin || !hasDeviceSettings(house, device)) return null;
  return (
    <div className="app-form-actions app-settings-link">
      <span className="ca-text-body app-muted">{label}</span>
      <Button
        size="sm"
        icon="settings-2"
        onClick={() => navigate(deviceSettingsPath(String(deviceId)))}
      >
        Settings
      </Button>
    </div>
  );
}

const RANGES = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;
type Range = keyof typeof RANGES;

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: HistoryView; from: number; to: number; truncated: boolean };

const LIMIT = 10_000;

function History({ entityId, domain, name }: { entityId: string; domain: string; name: string }) {
  const store = useStore();
  const [range, setRange] = useState<Range>("day");
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  // A new range keeps the last chart up, faded, until its own arrives: the pane does not jump
  // to a placeholder and back.
  const [pending, setPending] = useState(false);
  // The house's unit system is part of what the chart shows.
  const { units } = useHouse();

  // biome-ignore lint/correctness/useExhaustiveDependencies: units changes how the same records read
  useEffect(() => {
    let current = true;
    setPending(true);
    const to = Date.now();
    const from = to - RANGES[range];
    store.request("get_history", { entityId, from, to, limit: LIMIT, includePrevious: true }).then(
      (result) => {
        if (!current) return;
        const records = (result as { records: Row[] }).records;
        setLoaded({
          status: "ready",
          view: historyView(domain, records, from),
          from,
          to,
          truncated: records.length >= LIMIT,
        });
        setPending(false);
      },
      (err: unknown) => {
        if (!current) return;
        const message = err instanceof CasitaError ? err.message : "Couldn't load its history";
        setLoaded({ status: "error", message });
        setPending(false);
      },
    );
    return () => {
      current = false;
    };
  }, [store, entityId, domain, range, units]);

  // Before anything has loaded, a placeholder the size of what is coming: a chart, or a bar
  // and its axis.
  let body = (
    <Skeleton shape="block" height={historyKind(domain) === "values" ? 200 : 40} width="100%" />
  );
  if (loaded.status === "error") {
    body = <EmptyState size="inline" icon="triangle-alert" title={loaded.message} />;
  } else if (loaded.status === "ready") {
    const { view, from, to } = loaded;
    const points = view.series?.some((series) => series.points.some(([, value]) => value !== null));
    if (view.series && points) {
      body = (
        <TimeSeriesChart
          label={name}
          series={view.series}
          unit={view.unit}
          xDomain={[from, to]}
          height={200}
        />
      );
    } else if (view.segments?.length) {
      body = (
        <StateTimeline
          label={name}
          segments={view.segments}
          states={view.states}
          xDomain={[from, to]}
          axis
        />
      );
    } else {
      body = <EmptyState size="inline" icon="history" title="Nothing recorded in this range" />;
    }
  }

  return (
    <section className="app-history">
      <div className="app-history-head">
        <h3 className="ca-text-heading">History</h3>
        <SegmentedControl
          label="Range"
          value={range}
          onChange={(value) => setRange(value as Range)}
          options={[
            { value: "hour", label: "Hour" },
            { value: "day", label: "24 hours" },
            { value: "week", label: "7 days" },
          ]}
        />
      </div>
      <div className={pending && loaded.status === "ready" ? "app-history-stale" : undefined}>
        {body}
      </div>
      {loaded.status === "ready" && loaded.truncated ? (
        <p className="ca-text-caption app-muted">
          There is more than fits here; the newest part of the range is missing. Try a shorter
          range.
        </p>
      ) : null}
    </section>
  );
}

export function EntityDetail({
  entityId,
  onClose,
  onRenamed,
  onOpenDevice,
}: {
  entityId: string | null;
  onClose: () => void;
  /** Called when the open entity's id changes, so the sheet can follow it. */
  onRenamed?: (id: string) => void;
  /** Shows the entity's device; without it the link goes to the Devices page with it open. */
  onOpenDevice?: (deviceId: string) => void;
}) {
  const house = useHouse();
  const admin = useIsAdmin();
  const store = useStore();
  const navigate = useNavigate();
  // A rename arrives as an event carrying both ids; the sheet stays on the same entity.
  useEffect(() => {
    if (!entityId || !onRenamed) return;
    return store.onRenamed((oldId, newId, kind) => {
      if (kind === "entity" && oldId === entityId) onRenamed(newId);
    });
  }, [store, entityId, onRenamed]);
  const entity = entityId
    ? house.entities.find((candidate) => candidate.id === entityId)
    : undefined;
  if (!entityId) return null;
  if (!entity) {
    // Renamed or removed while its sheet was open.
    return (
      <Sheet open onClose={onClose} title="Not here any more">
        <EmptyState size="inline" title="That entity is gone." />
      </Sheet>
    );
  }
  const view = entityView(house, entity);
  const changed = view.record?.changedAt;
  const device = entity.deviceId
    ? house.devices.find((candidate) => candidate.id === entity.deviceId)
    : undefined;
  const openDevice = (deviceId: string) =>
    onOpenDevice
      ? onOpenDevice(deviceId)
      : navigate(`/devices?open=${encodeURIComponent(deviceId)}`);
  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="app-cell-name">
          <Icon name={view.icon || view.domain} size={18} />
          {view.name}
        </span>
      }
      subtitle={
        <span className="app-sheet-sub">
          <CopyChip value={view.id} />
          {device ? (
            // The way up to what the entity is part of.
            <button
              type="button"
              className="app-parent-link"
              onClick={() => openDevice(String(device.id))}
            >
              <Icon name="cpu" size={14} />
              <span>{String(device.name ?? device.id)}</span>
              <Icon name="chevron-right" size={14} />
            </button>
          ) : null}
        </span>
      }
      width={480}
    >
      <div className="app-detail">
        <section className="app-status">
          <div className="app-status-head">
            <h3 className="ca-text-heading">Status</h3>
            {view.domain === "climate" ? null : (
              <div className="app-status-state">
                <span className="ca-text-body">{view.summary}</span>
                <EntityControls view={view} />
              </div>
            )}
          </div>
          {view.domain === "climate" ? <ClimateCard view={view} /> : <EntityDimmer view={view} />}
          {typeof changed === "number" ? (
            <p className="ca-text-caption app-muted">
              <Timestamp value={changed} prefix="Changed" />
            </p>
          ) : null}
        </section>
        <History entityId={view.id} domain={view.domain} name={view.name} />
        {entity.deviceId ? (
          <SettingsLink
            deviceId={entity.deviceId}
            label="What its device can be set to do, such as its LEDs and how it dims"
          />
        ) : null}
        {admin ? <EntityEditor key={view.id} entity={entity} onRemoved={onClose} /> : null}
      </div>
    </Sheet>
  );
}

/** A device in a sheet: its card with every entity on it, and its editor for an admin. */
export function DeviceDetail({
  deviceId,
  onClose,
  onOpenEntity,
  onRenamed,
}: {
  deviceId: string | null;
  onClose: () => void;
  onOpenEntity?: (id: string) => void;
  /** Called when the open device's id changes, so the sheet can follow it. */
  onRenamed?: (id: string) => void;
}) {
  const house = useHouse();
  const admin = useIsAdmin();
  const store = useStore();
  useEffect(() => {
    if (!deviceId || !onRenamed) return;
    return store.onRenamed((oldId, newId, kind) => {
      if (kind === "device" && oldId === deviceId) onRenamed(newId);
    });
  }, [store, deviceId, onRenamed]);
  if (!deviceId) return null;
  // Looked up afresh on every render, so an open sheet follows a rename or a move.
  const item = deviceList(house).find((candidate) => candidate.id === deviceId);
  if (!item) {
    return (
      <Sheet open onClose={onClose} title="Not here any more">
        <EmptyState size="inline" title="That device is gone." />
      </Sheet>
    );
  }
  const rows = deviceEntities(house, item.id);
  const { device } = item;
  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      subtitle={<CopyChip value={item.id} />}
      width={480}
    >
      <div className="app-detail">
        <DeviceCard
          name={item.name}
          icon={typeof device.icon === "string" ? device.icon : rows[0]?.domain}
          manufacturer={device.manufacturer as string | undefined}
          model={device.model as string | undefined}
          area={item.area}
          status={item.status}
          statusText={device.orphaned ? "Orphaned" : undefined}
          error={
            device.orphaned
              ? "Its integration is no longer loaded. Remove it, or add the integration back."
              : item.status === "unavailable"
                ? `${item.name} isn't responding. Check that it has power and is in range.`
                : undefined
          }
          footer={[item.integrationId, device.firmware ? `Firmware ${device.firmware}` : null]
            .filter(Boolean)
            .join(" · ")}
        >
          {rows.map((row) => (
            <EntityLine key={row.id} view={row} onOpen={onOpenEntity} />
          ))}
        </DeviceCard>
        <SettingsLink
          deviceId={item.id}
          label="Its parameters, as its integration describes them"
        />
        {admin ? <DeviceEditor key={item.id} device={device} onRemoved={onClose} /> : null}
      </div>
    </Sheet>
  );
}

/** An area in a sheet: its devices by name, and every entity in it with its control. */
export function AreaDetail({
  areaId,
  onClose,
  onOpenEntity,
}: {
  areaId: string | null;
  onClose: () => void;
  onOpenEntity?: (id: string) => void;
}) {
  const house = useHouse();
  if (!areaId) return null;
  const item = areaList(house).find((candidate) => candidate.id === areaId);
  if (!item) {
    return (
      <Sheet open onClose={onClose} title="Not here any more">
        <EmptyState size="inline" title="That area is gone." />
      </Sheet>
    );
  }
  const devices = house.devices
    .filter((device) => device.areaId === areaId)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rows = house.entities
    .filter((entity) => entity.effectiveAreaId === areaId)
    .map((entity) => entityView(house, entity));
  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="app-cell-name">
          <Icon name={item.icon ?? "house"} size={18} />
          {item.name}
        </span>
      }
      subtitle={<CopyChip value={item.id} />}
      width={480}
    >
      <div className="app-detail">
        <p className="ca-text-caption app-muted">
          {devices.length === 1 ? "1 device" : `${devices.length} devices`}
          {devices.length ? `: ${devices.map((device) => String(device.name)).join(", ")}` : ""}
        </p>
        {rows.length ? (
          <div className="app-detail-list">
            {rows.map((row) => (
              <EntityLine key={row.id} view={row} onOpen={onOpenEntity} />
            ))}
          </div>
        ) : (
          <EmptyState size="inline" title="Nothing is in this area yet." />
        )}
      </div>
    </Sheet>
  );
}

/** A thing of the house a sheet can show. */
export interface Thing {
  kind: "entity" | "device" | "area";
  id: string;
}

/**
 * The three sheets, one open at a time, with an entity pressed on a device's or area's sheet
 * opening over it and closing back to it. `open` shows a thing; `sheets` goes in the tree.
 */
export function useThingSheets(): { open: (thing: Thing) => void; sheets: ReactNode } {
  const [opened, setOpened] = useState<Thing | null>(null);
  const [drilled, setDrilled] = useState<string | null>(null);
  const close = () => {
    setOpened(null);
    setDrilled(null);
  };
  const sheets = (
    <>
      <DeviceDetail
        deviceId={opened?.kind === "device" ? opened.id : null}
        onClose={close}
        onOpenEntity={setDrilled}
        onRenamed={(id) => setOpened({ kind: "device", id })}
      />
      <AreaDetail
        areaId={opened?.kind === "area" ? opened.id : null}
        onClose={close}
        onOpenEntity={setDrilled}
      />
      <EntityDetail
        entityId={drilled ?? (opened?.kind === "entity" ? opened.id : null)}
        onClose={drilled ? () => setDrilled(null) : close}
        onRenamed={drilled ? setDrilled : (id) => setOpened({ kind: "entity", id })}
        onOpenDevice={(id) => {
          setDrilled(null);
          setOpened({ kind: "device", id });
        }}
      />
    </>
  );
  const open = useCallback((thing: Thing) => {
    setOpened(thing);
    setDrilled(null);
  }, []);
  return { open, sheets };
}
