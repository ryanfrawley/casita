import type { MouseEvent, ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface SideNavItem {
  value?: string;
  /** Makes the item a link, so it can be opened in a new tab. */
  href?: string;
  label: string;
  icon?: string;
  count?: number;
  /** Something here needs attention; the text is the warning icon's name. */
  alert?: string;
  /** Marks the current page when `value` matching is not used. */
  current?: boolean;
  onClick?: (event: MouseEvent) => void;
}
export interface SideNavProps {
  items?: SideNavItem[];
  sections?: { title?: string; items: SideNavItem[] }[];
  value?: string;
  onSelect?: (value: string, event: MouseEvent) => void;
  brand?: ReactNode;
  footer?: ReactNode;
  label?: string;
  className?: string;
}

/** The app's main navigation down the left edge. */
export function SideNav({
  items,
  sections,
  value,
  onSelect,
  brand,
  footer,
  label = "Main",
  className,
}: SideNavProps) {
  return (
    <nav className={cx("ca-nav", className)} aria-label={label}>
      {brand ? <div className="ca-nav-brand">{brand}</div> : null}
      {(sections ?? [{ items: items ?? [] }]).map((section, at) => (
        // Sections are fixed for the life of the nav; untitled ones have only their position.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={at} className="ca-nav-section">
          {"title" in section && section.title ? (
            <div className="ca-nav-heading">{section.title}</div>
          ) : null}
          <ul className="ca-nav-list">
            {section.items.map((item) => {
              const on =
                item.value != null && value != null ? item.value === value : Boolean(item.current);
              const props = {
                className: cx("ca-nav-item", on && "ca-nav-on"),
                "aria-current": on ? ("page" as const) : undefined,
                onClick: (event: MouseEvent) => {
                  // A modified click on a link is the browser's: open in a new tab.
                  const ours = !item.href || (!event.metaKey && !event.ctrlKey);
                  if (onSelect && item.value != null && ours) {
                    if (item.href) event.preventDefault();
                    onSelect(item.value, event);
                  }
                  item.onClick?.(event);
                },
              };
              const inner = (
                <>
                  {item.icon ? <Icon name={item.icon} size={20} /> : null}
                  <span className="ca-nav-label">{item.label}</span>
                  {item.alert ? (
                    <span className="ca-nav-alert" title={item.alert}>
                      <Icon name="triangle-alert" size={16} title={item.alert} />
                    </span>
                  ) : null}
                  {item.count != null ? <span className="ca-nav-count">{item.count}</span> : null}
                </>
              );
              return (
                <li key={item.value ?? item.label}>
                  {item.href ? (
                    <a href={item.href} {...props}>
                      {inner}
                    </a>
                  ) : (
                    <button type="button" {...props}>
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {footer ? <div className="ca-nav-foot">{footer}</div> : null}
    </nav>
  );
}
