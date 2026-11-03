import { CasitaError, type Row } from "@casita/client";
import {
  Button,
  CodeView,
  EmptyState,
  SegmentedControl,
  Select,
  Skeleton,
  TextField,
} from "@casita/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAction, useIsAdmin, useStore, useThemes } from "../context.tsx";
import { redacted, typedValue, uptime } from "../forms.ts";
import { EDIT_COMPONENTS_PATH, editPagePath, editThemePath } from "../routes.ts";
import { useNavigate, useThemeChoice } from "../shell.tsx";

function About() {
  const store = useStore();
  const [status, setStatus] = useState<Row>();
  useEffect(() => {
    store.request("get_status", {}).then(
      (result) => setStatus(result as Row),
      () => {},
    );
  }, [store]);
  if (!status) return <Skeleton lines={3} />;
  const facts: [string, string][] = [
    ["Version", String(status.version)],
    ["Protocol", String(status.protocol)],
    ["Up for", uptime(Number(status.uptimeMs))],
    ["Entities", String(status.entities)],
    ["Devices", String(status.devices)],
  ];
  return (
    <dl className="app-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt className="ca-text-caption app-muted">{label}</dt>
          <dd className="ca-text-body">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The theme this browser draws in: Auto follows the device between the house's defaults. */
function Appearance() {
  const themes = useThemes();
  const { theme, setTheme } = useThemeChoice();
  return (
    <SegmentedControl
      label="Theme"
      value={theme}
      onChange={setTheme}
      options={[
        { value: "system", label: "Auto" },
        ...(themes.length
          ? themes
          : [
              { id: "day", name: "Day" },
              { id: "night", name: "Night" },
            ]
        ).map((t) => ({ value: t.id, label: t.name })),
      ]}
    />
  );
}

function General({ server, onSaved }: { server: Row; onSaved: () => void }) {
  const store = useStore();
  const act = useAction();
  const history = (server.history ?? {}) as Row;
  const [units, setUnits] = useState(String(server.units ?? "metric"));
  const [timezone, setTimezone] = useState(String(server.timezone ?? ""));
  const [days, setDays] = useState(String(history.defaultDays ?? ""));
  const [busy, setBusy] = useState(false);
  const daysError =
    /^[1-9]\d*$/.test(days) || days === String(history.defaultDays ?? "")
      ? undefined
      : "A whole number of days.";

  // Each setting is its own path, so one that is refused does not hold back the others.
  const changes: [path: string, value: unknown, label: string][] = [];
  if (units !== String(server.units ?? "metric")) changes.push(["server.units", units, "Units"]);
  if (timezone.trim() !== String(server.timezone ?? "") && timezone.trim()) {
    changes.push(["server.timezone", timezone.trim(), "Time zone"]);
  }
  if (!daysError && days !== String(history.defaultDays ?? "")) {
    changes.push(["server.history.defaultDays", Number(days), "History"]);
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    for (const [path, value, label] of changes) {
      await act(`${label} saved`, `Couldn't save ${label.toLowerCase()}`, () =>
        store.request("set_config", { path, value }),
      );
    }
    setBusy(false);
    onSaved();
  };

  return (
    <form className="app-form" onSubmit={save}>
      <Select
        label="Units"
        hint="How readings are shown everywhere. Stored values are not changed."
        value={units}
        onChange={setUnits}
        options={[
          { value: "metric", label: "Metric (°C, km)" },
          { value: "imperial", label: "Imperial (°F, mi)" },
        ]}
      />
      <TextField
        label="Time zone"
        mono
        placeholder="The server's own"
        hint="An IANA name such as America/Los_Angeles. Schedules run in it."
        value={timezone}
        onChange={(event) => setTimezone(event.target.value)}
      />
      <TextField
        label="Keep raw history for"
        inputMode="numeric"
        placeholder="30"
        hint="Days, when nothing more specific applies."
        error={daysError}
        value={days}
        onChange={(event) => setDays(event.target.value.trim())}
      />
      <div className="app-form-actions">
        <span />
        <Button type="submit" variant="primary" disabled={busy || changes.length === 0}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function Advanced({ config, onSaved }: { config: unknown; onSaved: () => void }) {
  const store = useStore();
  const act = useAction();
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const set = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const saved = await act(`Set ${path.trim()}`, `Couldn't set ${path.trim()}`, () =>
      store.request("set_config", { path: path.trim(), value: typedValue(value) }),
    );
    setBusy(false);
    if (saved) {
      setValue("");
      onSaved();
    }
  };
  return (
    <>
      <CodeView
        title="Configuration"
        label="The server's configuration"
        code={JSON.stringify(redacted(config), null, 2)}
        maxHeight={360}
      />
      <form className="app-form app-form-row" onSubmit={set}>
        <TextField
          label="Path"
          mono
          placeholder="server.history.defaultDays"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <TextField
          label="Value"
          mono
          placeholder="45"
          hint="Read as JSON when it is; otherwise as text. The server checks it before saving."
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" disabled={busy || !path.trim() || !value.trim()}>
          Set
        </Button>
      </form>
    </>
  );
}

export function Settings() {
  const store = useStore();
  const admin = useIsAdmin();
  const act = useAction();
  const [config, setConfig] = useState<Row>();
  const [failed, setFailed] = useState("");
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(() => {
    if (!admin) return;
    store.request("get_config", {}).then(
      (result) => setConfig(((result as Row).value ?? {}) as Row),
      (err: unknown) =>
        setFailed(err instanceof CasitaError ? err.message : "Couldn't load the settings"),
    );
  }, [store, admin]);
  useEffect(load, [load]);

  const backup = async () => {
    setBackingUp(true);
    let path = "";
    await act("Backup written", "Couldn't write a backup", async () => {
      path = String(((await store.request("backup", {})) as Row).path);
    });
    setBackingUp(false);
    if (path) setBackupPath(path);
  };
  const [backupPath, setBackupPath] = useState("");

  return (
    <div className="app-page app-page-narrow">
      <header className="app-page-head">
        <h1 className="ca-text-title">Settings</h1>
      </header>
      <section className="app-card">
        <h2 className="ca-text-heading">About this server</h2>
        <About />
        <p className="ca-text-caption app-muted">
          <a className="app-link" href="/api/schema" target="_blank" rel="noreferrer">
            The protocol's schema
          </a>{" "}
          describes every request and message.
        </p>
      </section>
      <section className="app-card">
        <h2 className="ca-text-heading">Appearance</h2>
        <p className="ca-text-body app-muted">
          Remembered by this browser. Auto follows the device between the house's light and dark
          themes.
        </p>
        <Appearance />
      </section>
      {!admin ? (
        <p className="ca-text-body app-muted">Only an admin can change the server's settings.</p>
      ) : failed ? (
        <EmptyState size="inline" icon="triangle-alert" title={failed} />
      ) : !config ? (
        <Skeleton shape="block" width="100%" height={240} />
      ) : (
        <>
          <section className="app-card">
            <h2 className="ca-text-heading">General</h2>
            <General
              key={JSON.stringify(config.server)}
              server={(config.server ?? {}) as Row}
              onSaved={load}
            />
          </section>
          <section className="app-card">
            <h2 className="ca-text-heading">Pages and themes</h2>
            <p className="ca-text-body app-muted">
              Home is a page written in Casa; themes are too, and so are the headings of rooms,
              cards and sections. Day, Night and October are built in; a theme of the house's own
              extends one of them, and October's source shows how.
            </p>
            <PagesAndThemes />
          </section>
          <section className="app-card">
            <h2 className="ca-text-heading">Backup</h2>
            <p className="ca-text-body app-muted">
              Writes a copy of the database beside it, on the server.
            </p>
            <div className="app-form-actions">
              <span className="ca-mono app-muted">{backupPath}</span>
              <Button disabled={backingUp} onClick={() => void backup()}>
                {backingUp ? "Writing…" : "Back up now"}
              </Button>
            </div>
          </section>
          <section className="app-card">
            <h2 className="ca-text-heading">Everything else</h2>
            <p className="ca-text-body app-muted">
              The whole configuration, with credentials covered. Any path can be set; integrations
              pick up their changes when reloaded.
            </p>
            <Advanced config={config} onSaved={load} />
          </section>
        </>
      )}
    </div>
  );
}

/** The pages and themes an admin can open in the editor, and a way to start a new theme. */
function PagesAndThemes() {
  const themes = useThemes();
  const navigate = useNavigate();
  const [newId, setNewId] = useState("");
  const id = newId.trim().toLowerCase();
  const valid = /^[a-z][a-z0-9_]*$/.test(id) && !themes.some((t) => t.id === id);
  return (
    <div className="app-casa-settings">
      <div className="app-form-actions">
        <span className="ca-text-body">Home</span>
        <Button size="sm" icon="pencil" onClick={() => navigate(editPagePath("home"))}>
          Edit page
        </Button>
      </div>
      <div className="app-form-actions">
        <span className="ca-text-body">
          Shared components
          <span className="app-muted">
            {" "}
            · an AreaHeader, CardHeader or SectionHeader here replaces Casita's on every page
          </span>
        </span>
        <Button size="sm" icon="pencil" onClick={() => navigate(EDIT_COMPONENTS_PATH)}>
          Edit
        </Button>
      </div>
      <ul className="app-casa-theme-list">
        {themes.map((theme) => (
          <li key={theme.id} className="app-casa-item">
            <span>
              {theme.name}
              {theme.builtin ? <span className="app-muted"> · built in</span> : null}
              {theme.isLightDefault ? <span className="app-muted"> · light default</span> : null}
              {theme.isDarkDefault ? <span className="app-muted"> · dark default</span> : null}
            </span>
            <Button size="sm" variant="quiet" onClick={() => navigate(editThemePath(theme.id))}>
              {theme.builtin ? "View" : "Edit"}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="app-form-actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) navigate(editThemePath(id));
        }}
      >
        <TextField
          label="New theme id"
          mono
          value={newId}
          onChange={(event) => setNewId(event.target.value)}
          hint="Lowercase letters, digits and underscores; the theme's name is set in its source."
        />
        <Button size="sm" type="submit" disabled={!valid}>
          Start
        </Button>
      </form>
    </div>
  );
}
