import type { MouseEvent, ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { Timestamp } from "./timestamp.tsx";

export interface SceneButtonProps {
  name: string;
  onRun?: (event: MouseEvent) => void;
  icon?: string;
  description?: string;
  lastRun?: Date | number | string;
  state?: "idle" | "running" | "error";
  runningText?: string;
  error?: string;
  disabled?: boolean;
  /** Fixes "now" for the last-run time, for tests and previews. */
  now?: Date | number;
  className?: string;
}

/** A scene or script: one press runs it. An exemplar, built from Icon and Timestamp. */
export function SceneButton({
  name,
  onRun,
  icon = "play",
  description,
  lastRun,
  state = "idle",
  runningText = "Running…",
  error = "Didn’t finish",
  disabled,
  now,
  className,
}: SceneButtonProps) {
  const running = state === "running";
  const failed = state === "error";
  let sub: ReactNode = description;
  if (running) sub = runningText;
  else if (failed) sub = error;
  else if (lastRun != null) {
    sub = (
      <>
        Ran <Timestamp value={lastRun} now={now} />
      </>
    );
  }
  return (
    <button
      type="button"
      className={cx("ca-scene", `ca-scene-${state}`, className)}
      disabled={disabled}
      aria-busy={running || undefined}
      aria-disabled={running || undefined}
      title={description}
      onClick={(event) => {
        if (!running) onRun?.(event);
      }}
    >
      <span className="ca-scene-icon">
        <Icon
          name={running ? "loader-circle" : failed ? "triangle-alert" : icon}
          size={20}
          spin={running}
        />
      </span>
      <span className="ca-scene-text">
        <span className="ca-scene-name">{name}</span>
        {sub ? <span className="ca-scene-sub">{sub}</span> : null}
      </span>
    </button>
  );
}
