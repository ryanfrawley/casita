// Every automation with its status, and a page's handlers beside them; an admin creates one
// from a template here and edits, switches or deletes it.

import { CasitaError, type Row } from "@casita/client";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  TextField,
  Timestamp,
  Toggle,
} from "@casita/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  automationIdOf,
  nameProblem,
  TEMPLATES,
  type Template,
  templateSource,
} from "../automations.ts";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { editAutomationPath, editPagePath } from "../routes.ts";
import { useNavigate } from "../shell.tsx";
import { Sensors } from "./sensors.tsx";

const STATUS = {
  running: ["ok", "Running"],
  error: ["error", "Error"],
  stopped: ["neutral", "Off"],
} as const;

interface Automation extends Row {
  id: string;
  kind: "automation" | "page";
  name: string;
  enabled: boolean;
  handlers: number;
  status: keyof typeof STATUS;
  error?: string;
  lastRunAt?: number;
}

export function Automations() {
  const store = useStore();
  const admin = useIsAdmin();
  const act = useAction();
  const navigate = useNavigate();
  const [list, setList] = useState<Automation[]>();
  const [failed, setFailed] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Automation | null>(null);

  const load = useCallback(() => {
    store.request("get_automations", {}).then(
      (result) => {
        setFailed("");
        setList(result as Automation[]);
      },
      (err: unknown) =>
        setFailed(err instanceof CasitaError ? err.message : "Couldn't load the automations"),
    );
  }, [store]);
  useEffect(load, [load]);
  // A save, a switch, a firing's error: the list follows.
  useEffect(() => store.onEvent("automation_status", load), [store, load]);
  useEffect(() => store.onEvent("automation_changed", load), [store, load]);

  const setEnabled = async (automation: Automation, enabled: boolean) => {
    await act(
      `${enabled ? "Enabled" : "Disabled"} ${automation.name}`,
      `Couldn't switch ${automation.name}`,
      () => store.request("set_automation_enabled", { automationId: automation.id, enabled }),
    );
    load();
  };

  const remove = async (automation: Automation) => {
    setDeleting(null);
    await act(`Deleted ${automation.name}`, `Couldn't delete ${automation.name}`, () =>
      store.request("delete_automation", { automationId: automation.id }),
    );
    load();
  };

  const open = (automation: Automation) =>
    navigate(
      automation.kind === "page" ? editPagePath(automation.id) : editAutomationPath(automation.id),
    );

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">Automations</h1>
        {admin ? (
          <Button icon="plus" onClick={() => setCreating(true)}>
            New automation
          </Button>
        ) : null}
      </header>
      {failed ? (
        <EmptyState size="inline" icon="triangle-alert" title={failed} />
      ) : !list ? (
        <Skeleton shape="block" width="100%" height={160} />
      ) : list.length === 0 ? (
        // Inline, as the derived sensors' is below it; the header holds the way to make one.
        <EmptyState
          size="inline"
          icon="workflow"
          title="No automations yet"
          description="An automation watches the house and acts for you: a light that follows motion, a schedule, one thing that follows another."
        />
      ) : (
        <DataTable<Automation>
          rows={list}
          onRowClick={admin ? open : undefined}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <span className="app-cell-stack">
                  <span>
                    {row.name} {row.kind === "page" ? <Badge tone="neutral">page</Badge> : null}
                  </span>
                  {row.error ? <span className="app-cell-error">{row.error}</span> : null}
                </span>
              ),
            },
            {
              key: "handlers",
              label: "Handlers",
              render: (row) => String(row.handlers),
            },
            {
              key: "lastRunAt",
              label: "Last run",
              render: (row) =>
                row.lastRunAt ? (
                  <Timestamp value={row.lastRunAt} />
                ) : (
                  <span className="app-muted">—</span>
                ),
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
                admin && row.kind === "automation" ? (
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
                ) : admin ? (
                  <Button size="sm" variant="quiet" icon="pencil" onClick={() => open(row)}>
                    Edit page
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      <Sensors />
      <NewAutomation
        open={creating}
        taken={(list ?? []).filter((a) => a.kind === "automation").map((a) => a.id)}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          navigate(editAutomationPath(id));
        }}
      />
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Its handlers stop now and its saved versions go with it."
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
    </div>
  );
}

/** Name it, pick a template and the things it acts on; the first save is the creation. */
function NewAutomation({
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
  const [templateId, setTemplateId] = useState(TEMPLATES[0]?.id ?? "blank");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const template = TEMPLATES.find((t) => t.id === templateId) ?? (TEMPLATES[0] as Template);
  const problem = nameProblem(name, taken);
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
    const id = automationIdOf(name);
    setBusy(true);
    const ok = await act(`Created ${name}`, `Couldn't create ${name}`, async () => {
      const saved = (await store.request("save_automation", { automationId: id, source })) as {
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
      title="New automation"
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
          placeholder="HallLight"
          hint={
            !name
              ? "One word, capitalised: HallLight"
              : problem
                ? undefined
                : `Saved as ${automationIdOf(name)}`
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
          options={TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
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
