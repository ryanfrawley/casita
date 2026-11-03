import {
  Children,
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { Badge, type BadgeProps } from "./badge.tsx";

export interface AreaFact {
  label: string;
  icon?: string;
  tone?: "on" | "alert" | "ok" | "unavailable";
}
export interface AreaProps {
  /** Empty, the heading has no title, and the area is not labelled by one. */
  name: string;
  /** An icon name or device kind; `house` by default, and `null` for no icon. */
  icon?: string | null;
  /** Lights the arch icon when anything in the area is on or open. */
  active?: boolean;
  /** "6 devices · 19 entities" */
  subtitle?: string;
  /** Shown as the tooltip. */
  areaId?: string;
  /** Two to five read-only facts about the area right now, each a word and never only a colour. */
  facts?: AreaFact[];
  /** Drawn in place of the icon, name and subtitle; the facts, actions and menu still follow. */
  header?: ReactNode;
  /** No heading row at all: no title, facts, actions or menu, and the area cannot be closed. */
  bare?: boolean;
  /** Area-wide buttons. */
  actions?: ReactNode;
  /** The "…" at the end of the title line, usually a Menu. */
  menu?: ReactNode;
  collapsible?: boolean;
  /** Default true. */
  defaultOpen?: boolean;
  /** Default 320. */
  minColumnWidth?: number;
  /** Default true; turn off only where cards must line up in rows. */
  masonry?: boolean;
  /** The line shown when the area has nothing in it. */
  empty?: string;
  /** Usually DeviceCards. */
  children?: ReactNode;
  className?: string;
}

const FACT_TONE: Record<NonNullable<AreaFact["tone"]>, NonNullable<BadgeProps["tone"]>> = {
  on: "on",
  ok: "ok",
  alert: "error",
  unavailable: "unavailable",
};

/**
 * How many columns the area's grid has at its current width, for a child that wants to span
 * them. The grid fills as many columns as fit, so only the browser knows the count.
 */
export const AreaColumns = createContext(1);

/** The grid's column count as the browser resolved it, followed as the area is resized. */
function useColumns(ref: RefObject<HTMLElement | null>, on: boolean): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!on || !grid || typeof ResizeObserver === "undefined") return;
    const count = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.trim();
      setColumns(tracks && tracks !== "none" ? tracks.split(/\s+/).length : 1);
    };
    const resize = new ResizeObserver(count);
    resize.observe(grid);
    count();
    return () => resize.disconnect();
  }, [on, ref]);
  return columns;
}

/**
 * Masonry for an area's card grid: each card spans as many 1px rows as it is tall, and dense
 * auto-placement drops it into the topmost free spot, so short cards don't leave holes. DOM
 * order is kept.
 */
function useMasonry(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!on || !grid || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const items = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const walk = (el: Element) => {
        for (const child of el.children) {
          if (getComputedStyle(child).display === "contents") walk(child);
          else out.push(child as HTMLElement);
        }
      };
      walk(grid);
      return out;
    };
    const lay = () => {
      frame = 0;
      const gap =
        Number.parseFloat(getComputedStyle(grid).getPropertyValue("--area-row-gap")) || 16;
      grid.classList.add("ca-area-masonry");
      for (const el of items()) {
        const rows = Math.max(1, Math.ceil(el.getBoundingClientRect().height + gap));
        el.style.gridRowEnd = `span ${rows}`;
      }
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(lay);
    };
    const resize = new ResizeObserver(queue);
    const observe = () => {
      resize.disconnect();
      resize.observe(grid);
      for (const el of items()) resize.observe(el);
    };
    const mutation = new MutationObserver(() => {
      observe();
      queue();
    });
    observe();
    mutation.observe(grid, { childList: true, subtree: true });
    lay();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      if (frame) cancelAnimationFrame(frame);
      grid.classList.remove("ca-area-masonry");
    };
  }, [on, ref]);
}

/**
 * A room or zone and everything in it: a sunken well with the area's name in an arch, a few
 * facts, area-wide actions, then its devices as raised cards in a grid.
 */
export function Area({
  name,
  icon = "house",
  active,
  subtitle,
  areaId,
  facts,
  header,
  bare,
  actions,
  menu,
  collapsible,
  defaultOpen = true,
  minColumnWidth,
  masonry = true,
  empty,
  children,
  className,
}: AreaProps) {
  const [own, setOwn] = useState(defaultOpen);
  const open = collapsible && !bare ? own : true;
  const grid = useRef<HTMLDivElement>(null);
  useMasonry(grid, open && masonry);
  const columns = useColumns(grid, open);
  const id = useId();
  const count = Children.toArray(children).filter(Boolean).length;
  const chevron = collapsible ? (
    <Icon name="chevron-down" size={18} className="ca-area-chevron" />
  ) : null;
  const title = header ? (
    <>
      <div className="ca-area-heading">{header}</div>
      {chevron}
    </>
  ) : (
    <>
      {icon === null ? null : (
        <span className={cx("ca-area-icon", active && "ca-area-icon-on")}>
          <Icon name={icon} size={22} />
        </span>
      )}
      {name ? (
        <span className="ca-area-titles">
          <span className="ca-area-nameline">
            <h2 className="ca-area-name">{name}</h2>
            {chevron}
          </span>
          {subtitle ? <span className="ca-area-sub">{subtitle}</span> : null}
        </span>
      ) : (
        chevron
      )}
    </>
  );
  return (
    <section
      className={cx("ca-area", !open && "ca-area-closed", bare && "ca-area-bare", className)}
      aria-label={name || undefined}
      title={areaId}
    >
      {bare ? null : (
        <header className="ca-area-head">
          {collapsible ? (
            <button
              type="button"
              className="ca-area-toggle"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOwn(!open)}
            >
              {title}
            </button>
          ) : (
            <div className="ca-area-toggle ca-area-static">{title}</div>
          )}
          {facts?.length ? (
            <ul className="ca-area-facts">
              {facts.map((fact) => (
                <li key={fact.label}>
                  <Badge tone={fact.tone ? FACT_TONE[fact.tone] : "neutral"} icon={fact.icon}>
                    {fact.label}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {actions ? <div className="ca-area-actions">{actions}</div> : null}
          {menu ? <div className="ca-area-menu">{menu}</div> : null}
        </header>
      )}
      {open ? (
        <div
          id={id}
          ref={grid}
          className="ca-area-grid"
          style={
            minColumnWidth ? ({ "--area-col": `${minColumnWidth}px` } as CSSProperties) : undefined
          }
        >
          {count ? (
            <AreaColumns.Provider value={columns}>{children}</AreaColumns.Provider>
          ) : (
            <p className="ca-area-empty">
              {empty ??
                `Nothing in ${name || "this area"} yet. Assign devices to this area from the Devices page.`}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
