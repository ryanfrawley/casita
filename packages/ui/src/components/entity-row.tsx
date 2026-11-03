import type { ReactNode } from "react";
import { type Domain, Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import type { EntityState } from "./entity-tile.tsx";

export interface EntityRowProps {
  name: string;
  /** Shown as the tooltip. */
  entityId?: string;
  domain?: Domain;
  /** An icon name or device kind, when the domain's own icon is not the right picture. */
  icon?: string;
  state?: EntityState;
  summary?: string;
  area?: string;
  level?: "control" | "read";
  /** A reading shown at the row's end: "21.5 °C". */
  value?: ReactNode;
  /** The row's controls: a Toggle, a Slider, a Button. */
  children?: ReactNode;
  /** Opens the entity's details: the row up to its controls becomes a button. */
  onOpen?: () => void;
  className?: string;
}

/**
 * One entity as a condensed row: state disc, name, meta line, then whatever controls it is
 * given. With `onOpen`, everything before the controls is one button to its details, so a
 * toggle or a slider still works on its own.
 */
export function EntityRow({
  name,
  entityId,
  domain,
  icon,
  state = "off",
  summary,
  area,
  level,
  value,
  children,
  onOpen,
  className,
}: EntityRowProps) {
  const meta = [summary, level === "read" ? "View only" : area].filter(Boolean).join(" · ");
  const face = (
    <>
      <span className="ca-row-icon">
        <Icon name={icon || domain || "switch"} size={18} />
      </span>
      <div className="ca-row-text">
        <div className="ca-row-name">{name}</div>
        {meta ? <div className="ca-row-meta">{meta}</div> : null}
      </div>
      {value != null ? <div className="ca-row-value">{value}</div> : null}
    </>
  );
  return (
    <div className={cx("ca-row", `ca-row-${state}`, className)} title={entityId}>
      {onOpen ? (
        <button
          type="button"
          className="ca-row-open"
          aria-label={`${name} details`}
          onClick={onOpen}
        >
          {face}
        </button>
      ) : (
        face
      )}
      {children ? <div className="ca-row-controls">{children}</div> : null}
    </div>
  );
}
