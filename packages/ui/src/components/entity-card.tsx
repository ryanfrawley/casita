import type { ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { type DeviceStatus, StatusDot } from "./status-dot.tsx";
import type { WidgetAccent } from "./widget-card.tsx";

export interface EntityCardProps {
  name: string;
  /** An icon name, domain or device kind. */
  icon?: string;
  /** The line under the name: how the thing reads, "On · 40%", or a chosen status line. */
  summary?: string;
  /** Colours the lit icon. */
  accent?: WidgetAccent;
  /** Lights the icon in the accent. */
  active?: boolean;
  /** Shown as the tooltip. */
  deviceId?: string;
  status?: DeviceStatus;
  /** The control, the details chevron and the "…" menu, at the trailing edge. */
  actions?: ReactNode;
  /** Opens the entity's details: the icon and the titles become a button. */
  onOpen?: () => void;
  /** What hangs under the row, such as a dimmer while the light is on. */
  children?: ReactNode;
  className?: string;
}

/**
 * A card that is one row: for a device with a single entity, or a card that shows one. The
 * header is the whole card, so the control sits where the name is and nothing is said twice.
 */
export function EntityCard({
  name,
  icon = "plug",
  summary,
  accent = "lamp",
  active,
  deviceId,
  status,
  actions,
  onOpen,
  children,
  className,
}: EntityCardProps) {
  const face = (
    <>
      <span className="ca-ecard-icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="ca-ecard-titles">
        <div className="ca-ecard-nameline">
          <h3 className="ca-ecard-name">{name}</h3>
          {status ? <StatusDot status={status} placement="bottom" /> : null}
        </div>
        {summary ? <div className="ca-ecard-summary">{summary}</div> : null}
      </div>
    </>
  );
  return (
    <section
      className={cx(
        "ca-ecard",
        `ca-ecard-${accent}`,
        active && "ca-ecard-active",
        status && `ca-ecard-${status}`,
        className,
      )}
      aria-label={name}
      title={deviceId}
    >
      <header className="ca-ecard-head">
        {onOpen ? (
          <button
            type="button"
            className="ca-ecard-open"
            aria-label={`${name} details`}
            onClick={onOpen}
          >
            {face}
          </button>
        ) : (
          face
        )}
        {actions ? <div className="ca-ecard-actions">{actions}</div> : null}
      </header>
      {children ? <div className="ca-ecard-body">{children}</div> : null}
    </section>
  );
}
