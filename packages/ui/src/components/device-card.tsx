import { type ReactNode, useId, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { type DeviceStatus, StatusDot } from "./status-dot.tsx";

export interface DeviceStat {
  label: string;
  value: ReactNode;
  icon?: string;
}
export interface DeviceCardProps {
  name: string;
  /** An icon name, domain or device kind such as `irrigation`. */
  icon?: string;
  /** Lights the header icon while the device is doing something: watering, heating, running. */
  active?: boolean;
  manufacturer?: string;
  model?: string;
  area?: string;
  /** Shown as the tooltip. */
  deviceId?: string;
  status?: DeviceStatus;
  /** Overrides the status's word. */
  statusText?: string;
  /** The status tooltip's second line: "Last seen just now". */
  statusDetail?: string;
  /** Buttons for the header, such as "Stop all". */
  actions?: ReactNode;
  /** Two to four values that summarise the device, not one entity. */
  stats?: DeviceStat[];
  /** One line under the header saying what happened and what to do; announced as an alert. */
  error?: string;
  footer?: ReactNode;
  /** The device's EntityRows, flat or in DeviceSections. */
  children?: ReactNode;
  className?: string;
}

/** A device and everything it exposes: header, optional stats, then its entities as rows. */
export function DeviceCard({
  name,
  icon = "plug",
  active,
  manufacturer,
  model,
  area,
  deviceId,
  status,
  statusText,
  statusDetail,
  actions,
  stats,
  error,
  footer,
  children,
  className,
}: DeviceCardProps) {
  const meta = [manufacturer, model, area].filter(Boolean).join(" · ");
  return (
    <section
      className={cx("ca-device", status && `ca-device-${status}`, className)}
      aria-label={name}
      title={deviceId}
    >
      <header className="ca-device-head">
        <span className={cx("ca-device-icon", active && "ca-device-icon-on")}>
          <Icon name={icon} size={22} />
        </span>
        <div className="ca-device-titles">
          <div className="ca-device-nameline">
            <h3 className="ca-device-name">{name}</h3>
            {status ? (
              <StatusDot
                status={status}
                label={statusText}
                detail={statusDetail}
                placement="bottom"
              />
            ) : null}
          </div>
          {meta ? <div className="ca-device-meta">{meta}</div> : null}
        </div>
        {actions ? <div className="ca-device-actions">{actions}</div> : null}
      </header>
      {stats?.length ? (
        <dl className="ca-device-stats">
          {stats.map((stat) => (
            <div key={stat.label} className="ca-device-stat">
              <dt>
                {stat.icon ? <Icon name={stat.icon} size={14} /> : null}
                {stat.label}
              </dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {error ? (
        <div className="ca-device-msg" role="alert">
          <Icon name="triangle-alert" size={16} />
          {error}
        </div>
      ) : null}
      <div className="ca-device-body">{children}</div>
      {footer ? <footer className="ca-device-foot">{footer}</footer> : null}
    </section>
  );
}

export interface DeviceSectionProps {
  title: string;
  /** Repeats the group's state so a collapsed section still says it: "Watering · 8 min left". */
  summary?: string;
  /** A control for the whole group that has no entity of its own. */
  aside?: ReactNode;
  collapsible?: boolean;
  /** Default true. */
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * A titled group of EntityRows inside a DeviceCard: one irrigation zone, one outlet of a power
 * strip. The heading is text only, so it reads as a label above its rows and not as one more row.
 */
export function DeviceSection({
  title,
  summary,
  aside,
  collapsible,
  defaultOpen = true,
  children,
  className,
}: DeviceSectionProps) {
  const [own, setOwn] = useState(defaultOpen);
  const open = collapsible ? own : true;
  const id = useId();
  const titles = (
    <span className="ca-dsec-titles">
      <span className="ca-dsec-title">{title}</span>
      {summary ? <span className="ca-dsec-summary">{summary}</span> : null}
    </span>
  );
  return (
    <div className={cx("ca-dsec", !open && "ca-dsec-closed", className)}>
      <div className="ca-dsec-head">
        {collapsible ? (
          <button
            type="button"
            className="ca-dsec-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOwn(!open)}
          >
            <Icon name="chevron-down" size={16} className="ca-dsec-chevron" />
            {titles}
          </button>
        ) : (
          <div className="ca-dsec-toggle ca-dsec-static">{titles}</div>
        )}
        {aside ? <div className="ca-dsec-aside">{aside}</div> : null}
      </div>
      {open ? (
        <div id={id} className="ca-dsec-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
