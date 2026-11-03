// The sensor editor: the source on the left with its problems, and on the right what the
// sensor reads now: each input's state and the value it makes of them. The compiler runs in
// the browser as the admin types; the server compiles again on save and computes the value.

import { CasitaError, present, type Row } from "@casita/client";
import { type CompileResult, compile, type Diagnostic } from "@casita/core/casa";
import { Badge, Button, EmptyState, Sheet, Skeleton, Timestamp } from "@casita/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditor } from "../casa/editor.tsx";
import { completions, marks } from "../casa/language.ts";
import { useHouse, useIsAdmin, useStore, useToast } from "../context.tsx";
import { useNavigate } from "../shell.tsx";
import type { House } from "../store.ts";
import {
  CHECK_DEBOUNCE_MS,
  Problems,
  registryOf,
  useFormat,
  useReferences,
} from "./page-editor.tsx";
import { useSplit } from "./split.tsx";

interface Source {
  source: string;
  versions: { version: number; savedAt: number; savedBy?: string }[];
}

interface SensorRow extends Row {
  id: string;
  entityId?: string;
  status: "running" | "error" | "stopped";
  error?: string;
}

function useSource(sensorId: string) {
  const store = useStore();
  const { phase } = useHouse();
  const [loaded, setLoaded] = useState<Source | { error: string } | undefined>();
  const load = useCallback(async () => {
    try {
      setLoaded((await store.request("get_sensor_source", { sensorId })) as Source);
    } catch (err) {
      setLoaded({ error: err instanceof CasitaError ? err.message : "Couldn't load the sensor" });
    }
  }, [store, sensorId]);
  useEffect(() => {
    if (phase === "ready") void load();
  }, [phase, load]);
  return { loaded, reload: load };
}

/** The sensor's row in the list: its entity and status, refetched when the status changes. */
function useSensorRow(sensorId: string) {
  const store = useStore();
  const { phase } = useHouse();
  const [row, setRow] = useState<SensorRow>();
  useEffect(() => {
    if (phase !== "ready") return;
    let current = true;
    const load = () =>
      store.request("get_sensors", {}).then(
        (list) => {
          if (current) setRow((list as SensorRow[]).find((s) => s.id === sensorId));
        },
        () => {},
      );
    void load();
    const offs = [
      store.onEvent("automation_status", () => void load()),
      store.onEvent("sensor_changed", () => void load()),
    ];
    return () => {
      current = false;
      for (const off of offs) off();
    };
  }, [store, phase, sensorId]);
  return row;
}

/** The entity ids the compiled inputs name, in source order, with their input's name. */
function inputsOf(result: CompileResult | undefined): { name: string; ids: string[] }[] {
  const ids = (expr: unknown): string[] => {
    if (!Array.isArray(expr)) return [];
    if (expr[0] === "entity") return [String(expr[1])];
    if (expr[0] === "list") return expr.slice(1).flatMap(ids);
    return [];
  };
  return (result?.sensor?.inputs ?? []).map((input) => ({
    name: input.name,
    ids: ids(input.value),
  }));
}

export function SensorEditor({ sensorId }: { sensorId: string }) {
  const split = useSplit();
  const store = useStore();
  const house = useHouse();
  const toast = useToast();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const { loaded, reload } = useSource(sensorId);
  const row = useSensorRow(sensorId);
  const [text, setText] = useState<string | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [goTo, setGoTo] = useState<{ offset: number; at: number } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = loaded && "source" in loaded && text !== undefined && text !== loaded.source;

  useEffect(() => {
    if (loaded && "source" in loaded && text === undefined) setText(loaded.source);
  }, [loaded, text]);

  const registry = useMemo(() => registryOf(house), [house]);
  useEffect(() => {
    if (text === undefined) return;
    const timer = setTimeout(() => {
      setResult(compile({ source: text, registry, sensorOnly: true }));
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
      const saved = (await store.request("save_sensor", { sensorId, source })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      setServerDiagnostics(saved.diagnostics.filter((d) => d.level === "error"));
      if (saved.ok) {
        toast({ tone: "ok", message: "Sensor saved; its value follows" });
        await reload();
        setText(source);
      } else {
        toast({
          tone: "error",
          title: "Not saved",
          message: `${saved.diagnostics.length} problem${saved.diagnostics.length === 1 ? "" : "s"}; see the list below the source`,
        });
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
      const reverted = (await store.request("revert_sensor", { sensorId, version })) as {
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
        <EmptyState icon="shield" title="Only an admin can edit a sensor" />
      </div>
    );
  }
  if (!loaded || text === undefined) {
    if (loaded && "error" in loaded) {
      return (
        <div className="app-page">
          <EmptyState
            icon="triangle-alert"
            title="Couldn't load the sensor"
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

  return (
    <div className="app-casa-editor">
      <div className="app-casa-editor-bar">
        <div className="app-casa-editor-title">
          <h1 className="ca-text-title">{result?.sensor?.name ?? sensorId}</h1>
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
            <Problems
              diagnostics={diagnostics}
              source={text}
              onPick={(offset) => setGoTo({ offset, at: Date.now() })}
            />
          </div>
        </div>
        {split.handle}
        <div className="app-casa-editor-preview">
          <div className="app-casa-preview-head">
            <span className="app-muted">
              What the sensor reads now: each input as the house reports it, and the value the saved
              source makes of them.
            </span>
          </div>
          <Readings house={house} inputs={inputsOf(result)} row={row} />
        </div>
      </div>
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

/** The inputs' states and the sensor's own, as rows: name, entity id, how it reads. */
function Readings({
  house,
  inputs,
  row,
}: {
  house: House;
  inputs: { name: string; ids: string[] }[];
  row: SensorRow | undefined;
}) {
  const line = (label: string, id: string) => {
    const entity = house.entities.find((e) => e.id === id);
    const shown = present(house.states.get(id));
    return (
      <li key={`${label}-${id}`} className="app-casa-item">
        <span className="app-cell-stack">
          <span>
            <strong>{label}</strong>{" "}
            <span className="app-muted">{entity ? String(entity.name) : ""}</span>
          </span>
          <code className="app-muted">{id}</code>
        </span>
        <Badge tone={shown.tone === "muted" ? "neutral" : shown.tone === "warn" ? "error" : "ok"}>
          {shown.text}
        </Badge>
      </li>
    );
  };
  return (
    <ul className="app-casa-versions">
      {inputs.flatMap((input) =>
        input.ids.map((id, i) =>
          line(input.ids.length > 1 ? `${input.name}[${i}]` : input.name, id),
        ),
      )}
      {row?.entityId ? (
        <>
          <li className="app-casa-item app-muted">
            <span>makes</span>
            {row.error ? <Badge tone="error">{row.error}</Badge> : null}
          </li>
          {line("value", row.entityId)}
        </>
      ) : (
        <li className="app-casa-item app-muted">
          <span>Save it to see what it makes of them.</span>
        </li>
      )}
    </ul>
  );
}
