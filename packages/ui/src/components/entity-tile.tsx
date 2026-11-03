import { type Domain, Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export type EntityState = "on" | "off" | "pending" | "unavailable";

export interface EntityTileProps {
  name: string;
  /** Shown as the tooltip. */
  entityId: string;
  domain: Domain;
  /** The device-confirmed state; `pending` from the moment a command is sent until it is confirmed. */
  state: EntityState;
  /** Overrides the state's word: "On · 60%", "Locking…", "21.5 °C". */
  summary?: string;
  area?: string;
  /** 0 to 1, lights only. */
  brightness?: number;
  /** From the grant resolver. `read` shows the state with no toggle and "View only". */
  level?: "control" | "read";
  onToggle?: () => void;
  className?: string;
}

const STATE_WORD: Record<EntityState, string> = {
  on: "On",
  off: "Off",
  pending: "Turning on…",
  unavailable: "Unavailable",
};

/** One entity as a tile showing its confirmed state; the whole tile is the toggle. */
export function EntityTile({
  name,
  entityId,
  domain,
  state = "off",
  summary,
  area,
  brightness,
  level,
  onToggle,
  className,
}: EntityTileProps) {
  const readOnly = level === "read" || state === "unavailable" || !onToggle;
  const caption = level === "read" ? "View only" : area;
  const body = (
    <>
      <div className="ca-tile-top">
        <span className="ca-tile-icon">
          <Icon name={domain || "light"} size={22} />
        </span>
        {state === "pending" ? (
          <Icon name="loader-circle" size={18} spin className="ca-tile-spinner" />
        ) : null}
      </div>
      <div className="ca-tile-name">{name}</div>
      <div className="ca-tile-state">{summary || STATE_WORD[state]}</div>
      {caption ? <div className="ca-tile-caption">{caption}</div> : null}
      {typeof brightness === "number" && state === "on" ? (
        <div className="ca-tile-level">
          <span style={{ width: `${Math.round(brightness * 100)}%` }} />
        </div>
      ) : null}
    </>
  );
  const classes = cx("ca-tile", `ca-tile-${state}`, readOnly && "ca-tile-readonly", className);
  if (readOnly) {
    return (
      <div className={classes} title={entityId}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={classes}
      onClick={onToggle}
      aria-pressed={state === "on"}
      title={entityId}
    >
      {body}
    </button>
  );
}
