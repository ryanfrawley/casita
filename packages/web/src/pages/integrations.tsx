import type { Row } from "@casita/client";
import {
  Badge,
  Button,
  Checkbox,
  CodeView,
  CopyChip,
  DataTable,
  Dialog,
  EmptyState,
  Select,
  Sheet,
  TextField,
  Timestamp,
} from "@casita/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { actionLabel, type Field, formParams, initialValues, schemaFields } from "../forms.ts";
import { cameraProblem, canScan, type Scanner, scanQr } from "../scan.ts";

const STATUS = {
  running: ["ok", "Running"],
  starting: ["pending", "Starting"],
  error: ["error", "Error"],
  stopped: ["neutral", "Stopped"],
} as const;

type Instance = Row & { id: string };

/** "zigbee2mqtt.main" is a Zigbee2mqtt; the instance name tells two of a kind apart. */
const integrationName = (integration: Row): string => {
  const type = String(integration.type ?? String(integration.integrationId).split(".")[0]);
  return type.charAt(0).toUpperCase() + type.slice(1);
};

/** The camera, open until it reads a QR code or is dismissed. */
function ScanDialog({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    if (!video.current) return;
    let scanner: Scanner | undefined;
    let closed = false;
    scanQr(video.current, onCode).then(
      (started) => {
        if (closed) started.stop();
        else scanner = started;
      },
      (err: unknown) => setProblem(cameraProblem(err)),
    );
    return () => {
      closed = true;
      scanner?.stop();
    };
  }, [onCode]);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Scan the QR code"
      description="Hold the code on the device's label up to the camera."
      actions={
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {problem ? (
        <p className="app-cell-error">{problem}</p>
      ) : (
        <video ref={video} className="app-scan" playsInline muted />
      )}
    </Dialog>
  );
}

function ActionForm({ integrationId, action }: { integrationId: string; action: Row }) {
  const store = useStore();
  const act = useAction();
  const fields = schemaFields(action.schema);
  const [values, setValues] = useState(() => initialValues(fields));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [scanning, setScanning] = useState<Field>();
  const { params, errors } = formParams(fields, values);
  const name = String(action.name);
  const set = (field: Field, value: string | boolean) =>
    setValues((old) => ({ ...old, [field.name]: value }));

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setResult(undefined);
    await act(`${actionLabel(name)} done`, `${actionLabel(name)} didn't work`, async () => {
      const answer = await store.request("integration_action", {
        integrationId,
        action: name,
        params,
      });
      setResult(JSON.stringify(answer ?? {}, null, 2));
    });
    setBusy(false);
  };

  const runButton = (
    <Button type="submit" icon="play" disabled={busy}>
      {busy ? "Running…" : "Run"}
    </Button>
  );
  const output =
    result && result !== "{}" ? (
      <CodeView title="Result" code={result} lineNumbers={false} />
    ) : null;

  // An action with nothing to fill in is one line: its name, and Run.
  if (fields.length === 0) {
    return (
      <form className="app-action" onSubmit={run}>
        <div className="app-action-row">
          <h4 className="ca-text-label">{actionLabel(name)}</h4>
          {runButton}
        </div>
        {output}
      </form>
    );
  }

  return (
    <form className="app-form app-action" onSubmit={run}>
      <h4 className="ca-text-label">{actionLabel(name)}</h4>
      {fields.map((field) => {
        const error = tried ? errors[field.name] : undefined;
        const label = `${actionLabel(field.name)}${field.required ? "" : " (optional)"}`;
        if (field.kind === "boolean") {
          return (
            <Checkbox
              key={field.name}
              label={actionLabel(field.name)}
              hint={field.description}
              checked={values[field.name] === true}
              onChange={(checked) => set(field, checked)}
            />
          );
        }
        if (field.kind === "select") {
          return (
            <Select
              key={field.name}
              label={label}
              hint={field.description}
              error={error}
              placeholder="Choose"
              value={String(values[field.name] ?? "")}
              options={(field.options ?? []).map((value) => ({ value, label: value }))}
              onChange={(value) => set(field, value)}
            />
          );
        }
        const input = (
          <TextField
            key={field.name}
            label={label}
            hint={field.kind === "json" ? (field.description ?? "As JSON.") : field.description}
            error={error}
            mono={field.kind === "json" || field.scan !== undefined}
            inputMode={field.kind === "number" ? "decimal" : undefined}
            value={String(values[field.name] ?? "")}
            onChange={(event) => set(field, event.target.value)}
          />
        );
        if (field.scan !== "qr" || !canScan()) return input;
        return (
          <div key={field.name} className="app-scan-field">
            {input}
            <Button size="sm" variant="quiet" onClick={() => setScanning(field)}>
              Scan with the camera
            </Button>
          </div>
        );
      })}
      {scanning ? (
        <ScanDialog
          onClose={() => setScanning(undefined)}
          onCode={(text) => {
            set(scanning, text);
            setScanning(undefined);
          }}
        />
      ) : null}
      <div className="app-form-actions">
        <span />
        {runButton}
      </div>
      {output}
    </form>
  );
}

export function Integrations() {
  const house = useHouse();
  const store = useStore();
  const admin = useIsAdmin();
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const shown = house.integrations.find((integration) => integration.integrationId === open);
  const count = (id: unknown) =>
    house.entities.filter((entity) => entity.integrationId === id).length;
  const reload = (integration: Row) =>
    act(
      `Reloaded ${integration.integrationId}`,
      `Couldn't reload ${integration.integrationId}`,
      () =>
        store.request("reload_integration", { integrationId: String(integration.integrationId) }),
    );

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Integrations</h1>
      </header>
      {house.integrations.length === 0 ? (
        <EmptyState
          icon="plug"
          title="No integrations yet"
          description="Add one under [[integration]] in the server's config; it appears here when it starts."
        />
      ) : (
        <DataTable<Instance>
          className="app-integrations"
          onRowClick={(row) => setOpen(row.id)}
          rows={[...house.integrations]
            .sort((a, b) => String(a.integrationId).localeCompare(String(b.integrationId)))
            .map((integration) => ({ ...integration, id: String(integration.integrationId) }))}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-stack">
                  {integrationName(row)}
                  {row.status === "error" && row.error ? (
                    <span className="app-cell-error">{String(row.error)}</span>
                  ) : null}
                </span>
              ),
            },
            { key: "id", label: "Instance", mono: true },
            { key: "entities", label: "Entities", align: "right", render: (row) => count(row.id) },
            {
              key: "status",
              label: "Status",
              render: (row) => {
                const [tone, word] = STATUS[row.status as keyof typeof STATUS] ?? STATUS.stopped;
                return (
                  <Badge tone={tone} icon={row.status === "stopped" ? null : undefined}>
                    {word}
                  </Badge>
                );
              },
            },
            {
              key: "actions",
              label: "Actions",
              render: (row) => {
                const actions = (row.actions as Row[] | undefined)?.length ?? 0;
                return actions > 0 ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon="chevron-right"
                    className="app-cell-flush"
                    onClick={() => setOpen(row.id)}
                  >
                    {actions === 1 ? "1 action" : `${actions} actions`}
                  </Button>
                ) : (
                  <span className="app-muted">None</span>
                );
              },
            },
            {
              key: "reload",
              label: "",
              align: "right",
              render: (row) =>
                admin ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon="refresh-cw"
                    onClick={() => void reload(row)}
                  >
                    Reload
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {shown ? (
        <Sheet
          open
          onClose={() => setOpen(null)}
          title={integrationName(shown)}
          subtitle={<CopyChip value={String(shown.integrationId)} />}
          width={480}
        >
          <div className="app-detail">
            {typeof shown.since === "number" ? (
              <p className="ca-text-caption app-muted">
                {String(shown.status).charAt(0).toUpperCase() + String(shown.status).slice(1)}{" "}
                <Timestamp value={shown.since} prefix="· started" />
              </p>
            ) : null}
            {!((shown.actions as Row[] | undefined) ?? []).length ? (
              <p className="ca-text-body app-muted">This integration has no actions.</p>
            ) : admin ? (
              ((shown.actions as Row[] | undefined) ?? []).map((action) => (
                <ActionForm
                  key={String(action.name)}
                  integrationId={String(shown.integrationId)}
                  action={action}
                />
              ))
            ) : (
              <p className="ca-text-body app-muted">
                Only an admin can run an integration's actions.
              </p>
            )}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
