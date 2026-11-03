// Every derived sensor with the entity it is reported as and its status; an admin creates
// one from a template here and edits, switches or deletes it. Drawn under the automations.

import { CasitaError, present, type Row } from "@casita/client";
import {
  Badge,
  Button,
  CopyChip,
  DataTable,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  TextField,
  Toggle,
} from "@casita/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { editSensorPath } from "../routes.ts";
import {
  SENSOR_TEMPLATES,
  sensorIdOf,
  sensorNameProblem,
  type Template,
  templateSource,
} from "../sensors.ts";
import { useNavigate } from "../shell.tsx";

const STATUS = {
  running: ["ok", "Running"],
  error: ["error", "Error"],
  stopped: ["neutral", "Off"],
} as const;

export interface Sensor extends Row {
  id: string;
  name: string;
  type: "String" | "Number" | "Bool";
  enabled: boolean;
  entityId?: string;
  entities: string[];
  status: keyof typeof STATUS;
  error?: string;
}

export function Sensors() {
  const store = useStore();
  const house = useHouse();
  const admin = useIsAdmin();
  const act = useAction();
  const navigate = useNavigate();
  const [list, setList] = useState<Sensor[]>();
  const [failed, setFailed] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Sensor | null>(null);

  const load = useCallback(() => {
    store.request("get_sensors", {}).then(
      (result) => {
        setFailed("");
        setList(result as Sensor[]);
      },
      (err: unknown) =>
        setFailed(err instanceof CasitaError ? err.message : "Couldn't load the sensors"),
    );
  }, [store]);
  useEffect(load, [load]);
  // A save, a switch, a computation's error: the list follows.
  useEffect(() => store.onEvent("sensor_changed", load), [store, load]);
  useEffect(() => store.onEvent("automation_status", load), [store, load]);

  const setEnabled = async (sensor: Sensor, enabled: boolean) => {
    await act(
      `${enabled ? "Enabled" : "Disabled"} ${sensor.name}`,
      `Couldn't switch ${sensor.name}`,
      () => store.request("set_sensor_enabled", { sensorId: sensor.id, enabled }),
    );
    load();
  };

  const remove = async (sensor: Sensor) => {
    setDeleting(null);
    await act(`Deleted ${sensor.name}`, `Couldn't delete ${sensor.name}`, () =>
      store.request("delete_sensor", { sensorId: sensor.id }),
    );
    load();
  };

  const open = (sensor: Sensor) => navigate(editSensorPath(sensor.id));

  return (
    <section className="app-section">
      <header className="app-page-head">
        <h2 className="ca-text-heading">Derived sensors</h2>
        {admin ? (
          <Button icon="plus" onClick={() => setCreating(true)}>
            New sensor
          </Button>
        ) : null}
      </header>
      {failed ? (
        <EmptyState size="inline" icon="triangle-alert" title={failed} />
      ) : !list ? (
        <Skeleton shape="block" width="100%" height={120} />
      ) : list.length === 0 ? (
        <EmptyState
          size="inline"
          icon="combine"
          title="No derived sensors yet"
          description="A derived sensor reads other sensors and reports one value of its own: a door and its lock as Open, Unlocked or Secured; the average of several thermometers."
        />
      ) : (
        <DataTable<Sensor>
          rows={list}
          onRowClick={admin ? open : undefined}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-stack">
                  <span>{row.name}</span>
                  {row.error ? <span className="app-cell-error">{row.error}</span> : null}
                </span>
              ),
            },
            {
              key: "entityId",
              label: "Entity",
              render: (row) =>
                row.entityId ? (
                  <CopyChip value={row.entityId} />
                ) : (
                  <span className="app-muted">—</span>
                ),
            },
            {
              key: "value",
              label: "Reads",
              render: (row) => (row.entityId ? present(house.states.get(row.entityId)).text : "—"),
            },
            {
              key: "status",
              label: "Status",
              render: (row) => {
                const [tone, word] = STATUS[row.status] ?? STATUS.stopped;
                return (
                  <Badge tone={tone} icon={row.status === "stopped" ? null : undefined}>
                    {word}
                  </Badge>
                );
              },
            },
            {
              key: "actions",
              label: "",
              align: "right",
              render: (row) =>
                admin ? (
                  <span className="app-cell-actions">
                    <Toggle
                      checked={row.enabled}
                      label={row.enabled ? "On" : "Off"}
                      onChange={(enabled) => void setEnabled(row, enabled)}
                    />
                    <Button size="sm" variant="quiet" icon="pencil" onClick={() => open(row)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="trash-2"
                      onClick={() => setDeleting(row)}
                    >
                      Delete
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      )}
      <NewSensor
        open={creating}
        taken={(list ?? []).map((s) => s.id)}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          navigate(editSensorPath(id));
        }}
      />
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Its entity goes with it, with the entity's history; a page or an automation that names it will wait for it."
        actions={
          <>
            <Button variant="quiet" onClick={() => setDeleting(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) void remove(deleting);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}

/** Name it, pick a template and its inputs; the first save is the creation. */
function NewSensor({
  open,
  taken,
  onClose,
  onCreated,
}: {
  open: boolean;
  taken: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const store = useStore();
  const house = useHouse();
  const act = useAction();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(SENSOR_TEMPLATES[0]?.id ?? "blank");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const template =
    SENSOR_TEMPLATES.find((t) => t.id === templateId) ?? (SENSOR_TEMPLATES[0] as Template);
  const problem = sensorNameProblem(name, taken);
  const source = templateSource(template, name, picks);

  const optionsFor = useMemo(
    () => (domains: string[]) =>
      house.entities
        .filter((e) => domains.includes(String(e.domain)))
        .map((e) => ({ value: String(e.id), label: `${String(e.name)} (${String(e.id)})` })),
    [house.entities],
  );

  const create = async () => {
    if (problem || !source) return;
    const id = sensorIdOf(name);
    setBusy(true);
    const ok = await act(`Created ${name}`, `Couldn't create ${name}`, async () => {
      const saved = (await store.request("save_sensor", { sensorId: id, source })) as {
        ok: boolean;
        diagnostics: { message: string }[];
      };
      if (!saved.ok) throw new Error(saved.diagnostics[0]?.message ?? "It does not compile");
    });
    setBusy(false);
    if (ok) {
      setName("");
      setPicks({});
      onCreated(id);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="New sensor"
      description="It opens in the editor once it is created; everything here can be changed there."
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || Boolean(problem) || !source}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="app-form">
        <TextField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="KitchenDoor"
          hint={
            problem && name
              ? undefined
              : `Saved as ${sensorIdOf(name || "KitchenDoor")}; its entity is named after it`
          }
          error={name ? problem : undefined}
          mono
          autoFocus
        />
        <Select
          label="Start from"
          value={templateId}
          onChange={(value) => {
            setTemplateId(value);
            setPicks({});
          }}
          options={SENSOR_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
          hint={template.description}
        />
        {template.fields.map((field) => (
          <Select
            key={field.key}
            label={field.label}
            value={picks[field.key] ?? ""}
            placeholder="Choose…"
            onChange={(value) => setPicks((current) => ({ ...current, [field.key]: value }))}
            options={optionsFor(field.domains)}
            mono
          />
        ))}
      </div>
    </Dialog>
  );
}
