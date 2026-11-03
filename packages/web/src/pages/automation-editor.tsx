// The automation editor: the source on the left with its problems and handlers, the
// automation's recent runs on the right. The compiler runs in the browser as the admin types;
// the server compiles again on save and arms the handlers.

import { CasitaError } from "@casita/client";
import {
  type CompileResult,
  compile,
  type Diagnostic,
  duration,
  isUnavailable,
} from "@casita/core/casa";
import {
  Badge,
  Button,
  EmptyState,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  TextField,
  Timestamp,
} from "@casita/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditor } from "../casa/editor.tsx";
import { completions, describeTrigger, marks, offsetOf } from "../casa/language.ts";
import { useHouse, useIsAdmin, useStore, useToast } from "../context.tsx";
import { useNavigate } from "../shell.tsx";
import {
  CHECK_DEBOUNCE_MS,
  HandlerList,
  Problems,
  parseOverride,
  registryOf,
  useFormat,
  useReferences,
} from "./page-editor.tsx";
import { useSplit } from "./split.tsx";

const RUNS_POLL_MS = 5000;

interface Source {
  source: string;
  versions: { version: number; savedAt: number; savedBy?: string }[];
}

interface Run {
  at: number;
  line: number;
  trigger: string;
  calls: { entityId: string; command: { action: string }; error?: string }[];
  /** Missing from a server older than `run`. */
  actions?: { integrationId: string; action: string; error?: string }[];
  armed: number[];
  error?: string;
}

function useSource(automationId: string) {
  const store = useStore();
  const { phase } = useHouse();
  const [loaded, setLoaded] = useState<Source | { error: string } | undefined>();
  const load = useCallback(async () => {
    try {
      setLoaded((await store.request("get_automation_source", { automationId })) as Source);
    } catch (err) {
      setLoaded({
        error: err instanceof CasitaError ? err.message : "Couldn't load the automation",
      });
    }
  }, [store, automationId]);
  useEffect(() => {
    if (phase === "ready") void load();
  }, [phase, load]);
  return { loaded, reload: load };
}

/** The runs the server remembers, refetched on a timer and whenever the status changes. */
function useRuns(automationId: string) {
  const store = useStore();
  const { phase } = useHouse();
  const [runs, setRuns] = useState<Run[]>();
  const [asked, setAsked] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` is the reload request
  useEffect(() => {
    if (phase !== "ready") return;
    let current = true;
    const load = () =>
      store.request("get_automation_runs", { automationId }).then(
        (list) => {
          if (current) setRuns(list as Run[]);
        },
        () => {},
      );
    void load();
    const timer = setInterval(() => void load(), RUNS_POLL_MS);
    const off = store.onEvent("automation_status", () => void load());
    return () => {
      current = false;
      clearInterval(timer);
      off();
    };
  }, [store, phase, automationId, asked]);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  return { runs, reload };
}

export function AutomationEditor({ automationId }: { automationId: string }) {
  const split = useSplit();
  const store = useStore();
  const house = useHouse();
  const toast = useToast();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const { loaded, reload } = useSource(automationId);
  const { runs, reload: reloadRuns } = useRuns(automationId);
  const [testing, setTesting] = useState(false);
  const [text, setText] = useState<string | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [goTo, setGoTo] = useState<{ offset: number; at: number } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"problems" | "handlers">("problems");
  const dirty = loaded && "source" in loaded && text !== undefined && text !== loaded.source;

  useEffect(() => {
    if (loaded && "source" in loaded && text === undefined) setText(loaded.source);
  }, [loaded, text]);

  const registry = useMemo(() => registryOf(house), [house]);
  useEffect(() => {
    if (text === undefined) return;
    const timer = setTimeout(() => {
      setResult(compile({ source: text, registry, automationOnly: true }));
      setServerDiagnostics([]);
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, registry]);

  const diagnostics = useMemo(
    () => [...(result?.diagnostics ?? []), ...serverDiagnostics],
    [result, serverDiagnostics],
  );
  const marked = useMemo(() => marks(diagnostics, text?.length ?? 0), [diagnostics, text]);
  const complete = useCallback(
    (word: string) => {
      const needle = word.toLowerCase();
      return completions(registry, []).filter(
        (c) => !needle || c.label.toLowerCase().startsWith(needle),
      );
    },
    [registry],
  );
  const references = useReferences(house, text);

  const { format, formatted } = useFormat(text, setText, result);

  const save = async (raw: string) => {
    const source = formatted(raw);
    setSaving(true);
    try {
      const saved = (await store.request("save_automation", { automationId, source })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      setServerDiagnostics(saved.diagnostics.filter((d) => d.level === "error"));
      if (saved.ok) {
        toast({ tone: "ok", message: "Automation saved and armed" });
        await reload();
        setText(source);
      } else {
        toast({
          tone: "error",
          title: "Not saved",
          message: `${saved.diagnostics.length} problem${saved.diagnostics.length === 1 ? "" : "s"}; see the list below the source`,
        });
        setTab("problems");
      }
    } catch (err) {
      toast({
        tone: "error",
        title: "Couldn't save",
        message: err instanceof CasitaError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const revert = async (version: number) => {
    setVersionsOpen(false);
    setSaving(true);
    try {
      const reverted = (await store.request("revert_automation", { automationId, version })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      if (reverted.ok) {
        toast({ tone: "ok", message: `Reverted to version ${version}` });
        setText(undefined);
        await reload();
      } else {
        setServerDiagnostics(reverted.diagnostics);
        toast({
          tone: "error",
          title: "That version no longer compiles",
          message: "The house has changed since; fix it in the editor instead.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (!admin) {
    return (
      <div className="app-page">
        <EmptyState icon="shield" title="Only an admin can edit an automation" />
      </div>
    );
  }
  if (!loaded || text === undefined) {
    if (loaded && "error" in loaded) {
      return (
        <div className="app-page">
          <EmptyState
            icon="triangle-alert"
            title="Couldn't load the automation"
            description={loaded.error}
          />
        </div>
      );
    }
    return (
      <div className="app-page">
        <Skeleton shape="block" width="100%" height={400} />
      </div>
    );
  }
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const handlers = result?.serverHandlers ?? [];

  return (
    <div className="app-casa-editor">
      <div className="app-casa-editor-bar">
        <div className="app-casa-editor-title">
          <h1 className="ca-text-title">{result?.automation?.name ?? automationId}</h1>
          {dirty ? <Badge tone="pending">Unsaved</Badge> : <Badge tone="neutral">Saved</Badge>}
          {errors ? (
            <Badge tone="error">
              {errors} error{errors === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="app-casa-editor-actions">
          <Button variant="quiet" size="sm" onClick={() => navigate("/automations")}>
            Close
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setVersionsOpen(true)}>
            Versions
          </Button>
          <Button variant="quiet" size="sm" disabled={saving} onClick={format}>
            Format
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={saving || dirty || !handlers.length}
            title={dirty ? "Save first: a test runs the saved version" : undefined}
            onClick={() => setTesting(true)}
          >
            Test
          </Button>
          <Button
            size="sm"
            disabled={saving || errors > 0 || !dirty}
            onClick={() => void save(text)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div className="app-casa-editor-panes" ref={split.ref} style={split.style}>
        <div className="app-casa-editor-source">
          <CodeEditor
            value={text}
            onChange={setText}
            marks={marked}
            complete={complete}
            hover={references.hover}
            links={references.links}
            onOpen={references.onOpen}
            goTo={goTo}
            className="app-casa-code"
          />
          {references.sheets}
          <div className="app-casa-editor-drawer">
            <SegmentedControl
              label="Drawer"
              value={tab}
              onChange={(value) => setTab(value as typeof tab)}
              options={[
                {
                  value: "problems",
                  label: diagnostics.length ? `Problems (${diagnostics.length})` : "Problems",
                },
                {
                  value: "handlers",
                  label: handlers.length ? `Handlers (${handlers.length})` : "Handlers",
                },
              ]}
            />
            {tab === "problems" ? (
              <Problems
                diagnostics={diagnostics}
                source={text}
                onPick={(offset) => setGoTo({ offset, at: Date.now() })}
              />
            ) : (
              <HandlerList handlers={handlers} />
            )}
          </div>
        </div>
        {split.handle}
        <div className="app-casa-editor-preview">
          <div className="app-casa-preview-head">
            <span className="app-muted">
              Recent runs, newest first: what fired, what it sent, and what was refused.
            </span>
          </div>
          <RunList
            runs={runs}
            onPick={(line) => setGoTo({ offset: offsetOf(text, line, 1), at: Date.now() })}
          />
        </div>
      </div>
      <TestSheet
        open={testing}
        onClose={() => setTesting(false)}
        automationId={automationId}
        handlers={handlers}
        onRan={(line) => {
          reloadRuns();
          setGoTo({ offset: offsetOf(text, line, 1), at: Date.now() });
        }}
      />
      <Sheet
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        title="Versions"
        subtitle="Every save; revert is a save of that version's source"
      >
        <ul className="app-casa-versions">
          {(loaded && "versions" in loaded ? loaded.versions : []).map((v) => (
            <li key={v.version} className="app-casa-item">
              <span>
                <strong>Version {v.version}</strong>{" "}
                <Timestamp value={v.savedAt} className="app-muted" />
                {v.savedBy ? <span className="app-muted"> · {v.savedBy}</span> : null}
              </span>
              <Button size="sm" onClick={() => void revert(v.version)}>
                Revert
              </Button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}

/** What a handler's trigger reads, as a pretend key: `sensor.x` or `weather.home#attr`. */
const triggerKey = (h: CompileResult["serverHandlers"][number]): string =>
  h.trigger.kind === "changed"
    ? `${h.trigger.entity}${h.trigger.attr ? `#${h.trigger.attr}` : ""}`
    : "";

interface PretendRow {
  key: string;
  value: string;
}

/**
 * Runs one handler of the saved automation now. Left blank, it reads the house as it is;
 * a pretend value stands in for one entity's value or attribute, for this run only.
 */
function TestSheet({
  open,
  onClose,
  automationId,
  handlers,
  onRan,
}: {
  open: boolean;
  onClose: () => void;
  automationId: string;
  handlers: CompileResult["serverHandlers"];
  onRan: (line: number) => void;
}) {
  const store = useStore();
  const toast = useToast();
  const [line, setLine] = useState<number | undefined>();
  const [rows, setRows] = useState<PretendRow[]>([]);
  const [running, setRunning] = useState(false);
  const handler = handlers.find((h) => h.line === line) ?? handlers[0];

  // Each opening starts on the first handler, with its trigger's key ready to pretend.
  useEffect(() => {
    if (!open) return;
    const first = handlers[0];
    setLine(first?.line);
    setRows(first && triggerKey(first) ? [{ key: triggerKey(first), value: "" }] : []);
  }, [open, handlers]);

  const pick = (value: string) => {
    const next = handlers.find((h) => String(h.line) === value);
    setLine(next?.line);
    if (next && triggerKey(next) && rows.every((r) => !r.value.trim()))
      setRows([{ key: triggerKey(next), value: "" }]);
  };

  const pretend: Record<string, number | string | boolean | null> = {};
  for (const row of rows) {
    const value = parseOverride(row.value);
    if (!row.key.trim() || value === undefined) continue;
    pretend[row.key.trim()] = isUnavailable(value) ? null : (value as number | string | boolean);
  }
  const pretending = Object.keys(pretend).length > 0;

  const runIt = async () => {
    if (!handler) return;
    setRunning(true);
    try {
      const run = (await store.request("test_automation", {
        automationId,
        line: handler.line,
        ...(pretending ? { pretend } : {}),
      })) as Run;
      const failed = [...run.calls, ...(run.actions ?? [])].find((c) => c.error)?.error;
      toast(
        run.error || failed
          ? { tone: "error", title: "The test ran into a problem", message: run.error ?? failed }
          : { tone: "ok", message: "Test ran; what it did is under Recent runs" },
      );
      onRan(handler.line);
      onClose();
    } catch (err) {
      toast({
        tone: "error",
        title: "Couldn't test",
        message: err instanceof CasitaError ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Test"
      subtitle="Runs a handler now, as if its trigger fired. What it sends is real."
      footer={
        <div className="app-form-actions">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={running || !handler} onClick={() => void runIt()}>
            {running ? "Running…" : pretending ? "Run with pretend values" : "Run now"}
          </Button>
        </div>
      }
    >
      <div className="app-form">
        {handlers.length > 1 ? (
          <Select
            label="Handler"
            value={handler ? String(handler.line) : undefined}
            onChange={pick}
            options={handlers.map((h) => ({
              value: String(h.line),
              label: `${describeTrigger(h.trigger)} (line ${h.line})`,
            }))}
          />
        ) : handler ? (
          <p>
            <code>{describeTrigger(handler.trigger)}</code>{" "}
            <span className="app-muted">line {handler.line}</span>
          </p>
        ) : null}
        <p className="app-muted">
          Leave the values blank to run against the house as it is now. To try something that isn't
          happening, pretend a value: an entity (<code>sensor.outside</code>) or one attribute (
          <code>weather.home#conditionNext12h</code>), with a number, a word such as{" "}
          <code>rain</code>, or a state such as <code>On</code>.
        </p>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, never reordered
          <div key={i} className="app-form app-form-row">
            <TextField
              label="Pretend"
              mono
              value={row.key}
              placeholder="sensor.outside"
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
            />
            <TextField
              label="Value"
              mono
              value={row.value}
              placeholder="as it is"
              onChange={(e) =>
                setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
            />
          </div>
        ))}
        <div>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setRows([...rows, { key: "", value: "" }])}
          >
            Pretend another value
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function RunList({ runs, onPick }: { runs: Run[] | undefined; onPick: (line: number) => void }) {
  if (!runs) return <Skeleton shape="block" width="100%" height={120} />;
  if (!runs.length) {
    return (
      <EmptyState
        size="inline"
        icon="workflow"
        title="No runs yet"
        description="A run appears here when a trigger fires; the server remembers the last twenty."
      />
    );
  }
  return (
    <ol className="app-casa-runs">
      {runs.map((run) => (
        <li key={`${run.at}-${run.line}-${run.trigger}`} className="app-casa-run">
          <div className="app-casa-run-head">
            <button type="button" className="app-casa-run-trigger" onClick={() => onPick(run.line)}>
              <code>{run.trigger}</code>
              <span className="app-muted">line {run.line}</span>
            </button>
            <Timestamp value={run.at} className="app-muted" />
          </div>
          <ul className="app-casa-run-calls">
            {run.calls.map((call, i) => (
              // Calls repeat an entity and command within one run; only their order tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each poll
              <li key={`${call.entityId}-${i}`}>
                <code>
                  {call.entityId}.{call.command.action}
                </code>
                {call.error ? (
                  <Badge tone="error">{call.error}</Badge>
                ) : (
                  <Badge tone="ok">sent</Badge>
                )}
              </li>
            ))}
            {(run.actions ?? []).map((ran, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each poll
              <li key={`run-${ran.integrationId}-${i}`}>
                <code>
                  run {ran.integrationId}.{ran.action}
                </code>
                {ran.error ? <Badge tone="error">{ran.error}</Badge> : <Badge tone="ok">ran</Badge>}
              </li>
            ))}
            {run.armed.map((ms, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each poll
              <li key={`after-${ms}-${i}`}>
                <code>after {duration(ms)}</code>
                <Badge tone="neutral">armed</Badge>
              </li>
            ))}
            {run.error ? (
              <li>
                <Badge tone="error">{run.error}</Badge>
              </li>
            ) : null}
            {!run.calls.length && !run.actions?.length && !run.armed.length && !run.error ? (
              <li className="app-muted">nothing to do</li>
            ) : null}
          </ul>
        </li>
      ))}
    </ol>
  );
}
