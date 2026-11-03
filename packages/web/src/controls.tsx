// An entity's row with the control its domain calls for.

import { toCelsius, unitSystem } from "@casita/client";
import { Button, EntityRow, Slider, Thermostat, Toggle } from "@casita/ui";
import { type ReactNode, useState } from "react";
import { useCommand } from "./context.tsx";
import { controllable, type EntityView, intents } from "./model.ts";

type Send = ReturnType<typeof useCommand>;

function Control({ view, send }: { view: EntityView; send: Send }) {
  const go = (intent: Parameters<Send>[2]) => void send(view.id, view.name, intent);
  const busy = view.state === "pending";
  const state = (view.record?.state ?? {}) as Record<string, unknown>;
  switch (view.domain) {
    case "light":
    case "switch":
      return (
        <Toggle
          aria-label={view.name}
          checked={state.on === true}
          pending={busy}
          onChange={(on) => go(intents.power(view, on))}
        />
      );
    case "lock":
      // A lock is never changed by a stray press on a switch: it gets a button that says what it does.
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => go(intents.lock(!state.locked || Boolean(state.jammed)))}
        >
          {state.jammed ? "Retry lock" : state.locked ? "Unlock" : "Lock"}
        </Button>
      );
    case "cover": {
      if (state.motion === "opening" || state.motion === "closing") {
        return (
          <Button size="sm" disabled={busy} onClick={() => go(intents.cover("stop"))}>
            Stop
          </Button>
        );
      }
      const closed = typeof state.position === "number" && state.position <= 0;
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => go(intents.cover(closed ? "open" : "close"))}
        >
          {closed ? "Open" : "Close"}
        </Button>
      );
    }
    case "button":
      return (
        <Button size="sm" icon="play" disabled={busy} onClick={() => go(intents.press())}>
          Press
        </Button>
      );
    default:
      return null;
  }
}

/** A light that dims gets its level under the row; dragging shows the number, letting go sends it. */
function Dimmer({ view, send }: { view: EntityView; send: Send }) {
  const confirmed = Math.round((view.brightness ?? 0) * 100);
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <Slider
      ariaLabel={`${view.name} brightness`}
      value={dragging ?? confirmed}
      pending={view.state === "pending"}
      onChange={setDragging}
      onCommit={(percent) => {
        setDragging(null);
        if (percent !== confirmed) void send(view.id, view.name, intents.brightness(percent));
      }}
    />
  );
}

/** An entity as a row that opens its details, its control, and anything else at the end. */
export function EntityLine({
  view,
  onOpen,
  actions,
}: {
  view: EntityView;
  onOpen?: (id: string) => void;
  actions?: ReactNode;
}) {
  return (
    <>
      <EntityRow
        name={view.name}
        entityId={view.id}
        domain={view.domain as "light"}
        icon={view.icon}
        state={view.state}
        summary={view.summary}
        level={view.level}
        onOpen={onOpen ? () => onOpen(view.id) : undefined}
      >
        <EntityControls view={view} />
        {actions}
      </EntityRow>
      <EntityDimmer view={view} />
    </>
  );
}

/** The entity's control, for a row or a card that is one row; nothing when it has none. */
export function EntityControls({ view }: { view: EntityView }) {
  const send = useCommand();
  return controllable(view) ? <Control view={view} send={send} /> : null;
}

/** A dimmer under a light that dims, while it is on; nothing for anything else. */
/** Whether a dimmer is drawn for the entity: a light that dims, on or off, so its card keeps
 * its height when it is switched. */
export function hasDimmer(view: EntityView): boolean {
  return controllable(view) && view.domain === "light" && view.dims;
}

export function EntityDimmer({
  view,
  className = "app-dimmer",
}: {
  view: EntityView;
  className?: string;
}) {
  const send = useCommand();
  if (!hasDimmer(view)) return null;
  return (
    <div className={className}>
      <Dimmer view={view} send={send} />
    </div>
  );
}

/** A thermostat, in the house's unit system; commands go out in Celsius, as the core holds them. */
export function ClimateCard({ view }: { view: EntityView }) {
  const send = useCommand();
  const state = (view.record?.state ?? {}) as Record<string, unknown>;
  const imperial = unitSystem() === "imperial";
  const shown = (celsius: unknown) =>
    typeof celsius === "number" ? (imperial ? (celsius * 9) / 5 + 32 : celsius) : null;
  const range = (
    view.entity.capabilities as { tempRange?: { min: number; max: number } } | undefined
  )?.tempRange;
  const [sent, setSent] = useState<{ target?: number; mode?: string }>({});
  const pending = view.state === "pending";
  const mode = String(state.mode ?? "off") as "heat" | "cool" | "auto" | "off";
  return (
    <Thermostat
      name={view.name}
      entityId={view.id}
      current={shown(state.currentTemp)}
      target={shown(state.targetTemp)}
      mode={mode}
      // No `action`: the core reports the mode it is set to, not what the equipment is doing
      // this minute, and the header says only what the house has confirmed.
      unit={imperial ? "°F" : "°C"}
      step={imperial ? 1 : 0.5}
      min={shown(range?.min ?? 7) ?? undefined}
      max={shown(range?.max ?? 30) ?? undefined}
      level={view.level}
      available={view.available}
      pendingTarget={pending ? (sent.target ?? null) : null}
      pendingMode={pending ? (sent.mode ?? null) : null}
      onTargetChange={(next) => {
        setSent({ target: next });
        void send(view.id, view.name, intents.target(toCelsius(next), `${next}°`));
      }}
      onModeChange={(next) => {
        setSent({ mode: next });
        void send(view.id, view.name, intents.mode(next));
      }}
    />
  );
}
