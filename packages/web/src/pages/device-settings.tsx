// A device's settings, as its integration describes them: one card per section, a control per
// setting. A change is sent at once; the control shows pending until the device reports the new
// value, and only then does it read the new value.

import {
  asSettings,
  CasitaError,
  changedFromDefault,
  findSettings,
  type Setting,
  settingLabel,
  settingSections,
  settingText,
} from "@casita/client";
import { Button, Dialog, EmptyState, Select, Skeleton, TextField, Toggle } from "@casita/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useHouse, useIsAdmin, useStore } from "../context.tsx";
import { settingHint, settingInput } from "../forms.ts";
import { deviceList } from "../model.ts";

type SettingValue = number | boolean | string;

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; settings: Setting[] };

/** How long a sent value waits for the device's report before the control stops saying so. */
const PENDING_MS = 30_000;

/** The device's settings, fetched again whenever it reports a change. */
function useSettings(deviceId: string): Loaded {
  const store = useStore();
  const { phase } = useHouse();
  // Settings are an admin's; the server refuses anyone else, so they are not asked for.
  const admin = useIsAdmin();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    if (phase !== "ready" || !admin) return;
    let current = true;
    const load = () =>
      store.request("get_device_settings", { deviceId }).then(
        (result) => {
          if (current) setLoaded({ status: "ready", settings: asSettings(result) });
        },
        (err: unknown) => {
          if (!current) return;
          const message = err instanceof CasitaError ? err.message : "Couldn't load its settings";
          setLoaded({ status: "error", message });
        },
      );
    void load();
    const off = store.onEvent("settings_changed", (event) => {
      if (event.deviceId === deviceId) void load();
    });
    return () => {
      current = false;
      off();
    };
  }, [store, phase, admin, deviceId]);
  return loaded;
}

/**
 * Values sent and not yet reported, by key. A key leaves when the device reports the value
 * sent, when sending fails, or when it has waited too long.
 */
function usePending(settings: Setting[] | undefined) {
  const [pending, setPending] = useState<ReadonlyMap<string, SettingValue>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const drop = useCallback((key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setPending((before) => {
      if (!before.has(key)) return before;
      const next = new Map(before);
      next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    for (const [key, value] of pending) {
      const reported = settings?.find((s) => s.key === key)?.value;
      if (reported !== undefined && String(reported) === String(value)) drop(key);
    }
  }, [settings, pending, drop]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) clearTimeout(timer);
    };
  }, []);
  const add = useCallback(
    (key: string, value: SettingValue) => {
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => drop(key), PENDING_MS),
      );
      setPending((before) => new Map(before).set(key, value));
    },
    [drop],
  );
  return { pending, add, drop };
}

function NumberControl({
  setting,
  pending,
  onSend,
}: {
  setting: Setting;
  pending: boolean;
  onSend: (value: SettingValue) => void;
}) {
  const shown = setting.value === null ? "" : String(setting.value);
  const [text, setText] = useState(shown);
  // A report from the device replaces what is typed, unless it is being typed.
  const focused = useRef(false);
  const shownAtFocus = useRef(shown);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  // A disabled field may lose focus without a blur; once sent, the device's report decides.
  useEffect(() => {
    if (pending) focused.current = false;
  }, [pending]);
  const parsed = settingInput(setting, text);
  const changed = text.trim() !== shown;
  const error = changed && "error" in parsed ? parsed.error : undefined;
  const send = () => {
    if (changed && "value" in parsed) onSend(parsed.value);
  };
  return (
    <form
      className="app-setting-number"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <TextField
        label={setting.label}
        hideLabel
        className="app-setting-field"
        inputMode={setting.type === "number" ? "numeric" : undefined}
        value={text}
        error={error}
        disabled={pending}
        placeholder={setting.value === null ? "Not reported" : undefined}
        onFocus={() => {
          focused.current = true;
          shownAtFocus.current = shown;
        }}
        onBlur={() => {
          focused.current = false;
          // A report that came while it was being typed in wins once it is left; a value
          // typed and not yet sent (Set is being pressed) stays.
          if (shown !== shownAtFocus.current) setText(shown);
        }}
        onChange={(event) => setText(event.target.value)}
      />
      {setting.unit ? <span className="ca-text-caption app-muted">{setting.unit}</span> : null}
      <Button
        size="sm"
        type="submit"
        variant="quiet"
        disabled={!changed || Boolean(error) || pending}
        busy={pending}
      >
        Set
      </Button>
    </form>
  );
}

function SettingControl({
  setting,
  pending,
  onSend,
}: {
  setting: Setting;
  pending: boolean;
  onSend: (value: SettingValue) => void;
}) {
  if (setting.readOnly) {
    return <span className="ca-text-body app-setting-reading">{settingText(setting)}</span>;
  }
  if (setting.type === "boolean") {
    return (
      <Toggle
        aria-label={setting.label}
        checked={setting.value === true}
        pending={pending}
        onChange={(checked) => onSend(checked)}
      />
    );
  }
  if (setting.type === "enum") {
    const options = (setting.options ?? []).map((option) => ({
      value: String(option.value),
      label: option.label,
    }));
    const value = setting.value === null ? "" : String(setting.value);
    // A value the device reports that its driver does not name is still shown.
    if (value && !options.some((option) => option.value === value))
      options.unshift({ value, label: value });
    return (
      <Select
        aria-label={setting.label}
        className="app-setting-select"
        value={value}
        placeholder="Not reported"
        disabled={pending}
        options={options}
        onChange={(chosen) => {
          const option = setting.options?.find((o) => String(o.value) === chosen);
          if (option) onSend(option.value);
        }}
      />
    );
  }
  return <NumberControl setting={setting} pending={pending} onSend={onSend} />;
}

function SettingRow({
  setting,
  pending,
  onSend,
}: {
  setting: Setting;
  pending: boolean;
  onSend: (value: SettingValue) => void;
}) {
  const hint = setting.type === "number" ? settingHint(setting) : undefined;
  const fromDefault = changedFromDefault(setting) && !setting.readOnly;
  return (
    <li className="app-setting">
      <div className="app-setting-text">
        <span className="app-setting-label">
          {settingLabel(setting)}
          <span className="ca-mono app-muted app-setting-key">{setting.key}</span>
        </span>
        {setting.description ? (
          <span className="ca-text-caption app-muted">{setting.description}</span>
        ) : null}
        {hint ? <span className="ca-text-caption app-muted">{hint}</span> : null}
        {pending ? (
          <span className="ca-text-caption app-muted">Sent; waiting for the device…</span>
        ) : fromDefault && setting.default !== undefined ? (
          <span className="ca-text-caption app-muted">
            Normally {settingText(setting, setting.default)}.{" "}
            <button
              type="button"
              className="app-link app-setting-reset"
              onClick={() => onSend(setting.default as SettingValue)}
            >
              Put it back
            </button>
          </span>
        ) : null}
      </div>
      <div className="app-setting-control">
        <SettingControl setting={setting} pending={pending} onSend={onSend} />
      </div>
    </li>
  );
}

export function DeviceSettings({ deviceId }: { deviceId: string }) {
  const house = useHouse();
  const admin = useIsAdmin();
  const store = useStore();
  const act = useAction();
  const loaded = useSettings(deviceId);
  const settings = loaded.status === "ready" ? loaded.settings : undefined;
  const { pending, add, drop } = usePending(settings);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<{ setting: Setting; value: SettingValue }>();
  const item = deviceList(house).find((candidate) => candidate.id === deviceId);

  const send = async (setting: Setting, value: SettingValue) => {
    add(setting.key, value);
    const sent = await act(
      `${settingLabel(setting)} sent`,
      `Couldn't change ${settingLabel(setting).toLowerCase()}`,
      () => store.request("set_device_setting", { deviceId, key: setting.key, value }),
    );
    if (!sent) drop(setting.key);
  };
  const ask = (setting: Setting) => (value: SettingValue) => {
    // Hard to undo: say what it does first. Going back to its usual value needs no asking.
    if (setting.destructive && String(value) !== String(setting.default))
      setConfirming({ setting, value });
    else void send(setting, value);
  };

  let body: React.ReactNode;
  if (!admin) {
    body = <EmptyState size="inline" title="Only an admin can change a device's settings." />;
  } else if (loaded.status === "loading") {
    body = <Skeleton shape="block" width="100%" height={240} />;
  } else if (loaded.status === "error") {
    body = <EmptyState size="inline" icon="triangle-alert" title={loaded.message} />;
  } else if (!loaded.settings.length) {
    body = (
      <EmptyState
        size="inline"
        icon="settings-2"
        title="Nothing to change"
        description="Its integration doesn't describe any settings for this device."
      />
    );
  } else {
    const sections = settingSections(findSettings(loaded.settings, query));
    body = sections.length ? (
      sections.map((section) => (
        <section key={section.title ?? ""} className="app-card">
          <h2 className="ca-text-heading">{section.title ?? "General"}</h2>
          <ul className="app-settings">
            {section.settings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                pending={pending.has(setting.key)}
                onSend={ask(setting)}
              />
            ))}
          </ul>
        </section>
      ))
    ) : (
      <EmptyState size="inline" title="Nothing matches" />
    );
  }

  return (
    <div className="app-page app-page-narrow">
      <header className="app-page-head">
        <div className="app-setting-head">
          <h1 className="ca-text-title">{item?.name ?? deviceId}</h1>
          <p className="ca-text-caption app-muted">
            {[item?.maker, item?.integrationId].filter(Boolean).join(" · ")}
          </p>
        </div>
        {settings?.length ? (
          <TextField
            label="Find"
            type="search"
            placeholder="A name, a number or a word"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
      </header>
      {settings?.length ? (
        <p className="ca-text-body app-muted">
          What its integration says can be changed on this device. A change is sent at once and
          shows here when the device reports it; a device that sleeps takes it when it next wakes.
        </p>
      ) : null}
      {body}
      <Dialog
        open={confirming !== undefined}
        tone="danger"
        title={`Change ${confirming ? settingLabel(confirming.setting).toLowerCase() : ""}?`}
        description={
          confirming
            ? `Setting it to ${settingText(confirming.setting, confirming.value)} is hard to undo.`
            : undefined
        }
        onClose={() => setConfirming(undefined)}
        actions={
          <>
            <Button data-autofocus onClick={() => setConfirming(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirming) void send(confirming.setting, confirming.value);
                setConfirming(undefined);
              }}
            >
              Change it
            </Button>
          </>
        }
      />
    </div>
  );
}
