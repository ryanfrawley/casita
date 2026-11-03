import { Fragment, type ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { RangeBar, type RangeBarProps } from "./range-bar.tsx";

export type WidgetAccent = "lamp" | "sky" | "sage" | "ember";
export type WidgetSize = "sm" | "md" | "lg";

export interface WidgetStat {
  key: string;
  label: string;
  value: string;
  icon?: string;
}

/** One thing drawn in the card's body, already in the order and grouping the card wants. */
export type WidgetBlock =
  | { kind: "headline"; key: string; value: string; unit?: string; caption: string }
  | { kind: "stats"; key: string; stats: WidgetStat[] }
  | {
      kind: "bar";
      key: string;
      label: string;
      value: string;
      /** 0 to 100. */
      percent: number;
      tone?: RangeBarProps["tone"];
      /** A tick on the bar and the words after the value: "limit 80%". */
      marker?: { percent: number; text: string };
      /** Draws the value as a warning. */
      low?: boolean;
    }
  | { kind: "row"; key: string; children: ReactNode }
  /** A chart or another drawing, with the reading's name over it. */
  | { kind: "figure"; key: string; label?: string; children: ReactNode };

export interface WidgetCardProps {
  name: string;
  /** An icon name, domain or device kind. */
  icon?: string;
  /** The line under the name, already joined: chosen status readings, else maker and model. */
  status?: string;
  /** Colours the lit icon, "Card colour" bars and the toggles. */
  accent?: WidgetAccent;
  size?: WidgetSize;
  /** Lights the icon in the accent. */
  active?: boolean;
  /** Shown as the tooltip. */
  deviceId?: string;
  /** The "…" menu or buttons in the header; with no header, in a strip above the body. */
  actions?: ReactNode;
  /** Default true. False leaves out the name, icon and status: the blocks stand on their own. */
  header?: boolean;
  /** Drawn in place of the icon, name and status; the actions still follow it. */
  heading?: ReactNode;
  /** The body as blocks; or give `children` drawn with `WidgetBlockView` and your own. */
  blocks?: WidgetBlock[];
  children?: ReactNode;
  /** What an empty body says; null draws no body at all, for a card that is its heading. */
  emptyText?: string | null;
  className?: string;
}

/**
 * A customisable at-a-glance card for one device: a header (icon in the arch, name, status
 * line, actions), then the readings the household chose, each drawn the way they chose.
 */
export function WidgetCard({
  name,
  icon = "plug",
  status,
  accent = "lamp",
  size = "md",
  active,
  deviceId,
  actions,
  header = true,
  heading,
  blocks,
  children,
  emptyText = "Nothing chosen for this card yet.",
  className,
}: WidgetCardProps) {
  const body = blocks ? (blocks.length ? blocks.map(block) : null) : children;
  const headOnly = header && !body && emptyText === null;
  return (
    <section
      className={cx(
        "ca-widget",
        `ca-widget-${accent}`,
        `ca-widget-size-${size}`,
        active && "ca-widget-active",
        !header && "ca-widget-bare",
        headOnly && "ca-widget-headonly",
        className,
      )}
      aria-label={name}
      title={deviceId}
    >
      {header ? (
        <header className="ca-widget-head">
          {heading ?? (
            <>
              <span className="ca-widget-icon">
                <Icon name={icon} size={22} />
              </span>
              <div className="ca-widget-titles">
                <div className="ca-widget-name">{name}</div>
                <div className="ca-widget-status">{status ?? ""}</div>
              </div>
            </>
          )}
          {actions}
        </header>
      ) : actions ? (
        <div className="ca-widget-strip">{actions}</div>
      ) : null}
      {body ? (
        <div className="ca-widget-body">{body}</div>
      ) : emptyText === null ? null : (
        <p className="ca-widget-empty">{emptyText}</p>
      )}
    </section>
  );
}

/** One block on its own, for a card whose body is composed rather than listed. */
export function WidgetBlockView({ block: item }: { block: WidgetBlock }) {
  return <>{block(item)}</>;
}

function block(item: WidgetBlock): ReactNode {
  switch (item.kind) {
    case "headline":
      return (
        <div key={item.key} className="ca-widget-headline">
          <span className="ca-widget-big">{item.value}</span>
          {item.unit ? <span className="ca-widget-unit">{item.unit.trim()}</span> : null}
          <span className="ca-widget-caption">{item.caption}</span>
        </div>
      );
    case "stats":
      return (
        <dl key={item.key} className="ca-widget-stats">
          {item.stats.map((stat) => (
            <div key={stat.key} className="ca-widget-stat">
              <dt>
                {stat.icon ? <Icon name={stat.icon} size={14} /> : null}
                {stat.label}
              </dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "bar":
      return (
        <div key={item.key} className={cx("ca-widget-bar", item.low && "ca-widget-low")}>
          <div className="ca-widget-bar-head">
            <span>{item.label}</span>
            <span className="ca-widget-bar-val">
              {item.low ? <Icon name="triangle-alert" size={14} /> : null}
              {item.value}
              {item.marker ? <span className="ca-widget-muted"> · {item.marker.text}</span> : null}
            </span>
          </div>
          <RangeBar
            min={0}
            max={100}
            from={0}
            to={item.percent}
            marker={item.marker?.percent}
            tone={item.low ? "danger" : item.tone}
            label={`${item.label} ${item.value}${item.low ? ", low" : ""}`}
          />
        </div>
      );
    case "row":
      return <Fragment key={item.key}>{item.children}</Fragment>;
    case "figure":
      return (
        <figure key={item.key} className="ca-widget-figure">
          {item.label ? (
            <figcaption className="ca-widget-figure-head">{item.label}</figcaption>
          ) : null}
          {item.children}
        </figure>
      );
  }
}
