import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface TabItem {
  value: string;
  label: string;
  icon?: string;
  count?: number;
  disabled?: boolean;
}
export interface TabsProps {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  label: string;
  /** The panel: content, or a function of the selected tab. Leave out to draw only the tab list. */
  children?: ReactNode | ((value: string) => ReactNode);
  id?: string;
  className?: string;
}

/** The tab an arrow, Home or End key moves to, skipping disabled tabs; undefined for any other key. */
export function nextTab(
  tabs: TabItem[],
  current: string | undefined,
  key: string,
): TabItem | undefined {
  const enabled = tabs.filter((tab) => !tab.disabled);
  const at = enabled.findIndex((tab) => tab.value === current);
  if (key === "ArrowRight") return enabled[(at + 1) % enabled.length];
  if (key === "ArrowLeft") return enabled[(at - 1 + enabled.length) % enabled.length];
  if (key === "Home") return enabled[0];
  if (key === "End") return enabled.at(-1);
  return undefined;
}

/** Switch between views of one thing: Settings sections, History's charts and logbook. */
export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  label,
  children,
  id,
  className,
}: TabsProps) {
  const [own, setOwn] = useState(defaultValue ?? tabs[0]?.value);
  const current = value ?? own;
  const auto = useId();
  const base = id ?? auto;
  const ref = useRef<HTMLDivElement>(null);
  const pick = (next: string) => {
    if (value == null) setOwn(next);
    onChange?.(next);
  };
  const key = (event: KeyboardEvent) => {
    const next = nextTab(tabs, current, event.key);
    if (!next) return;
    event.preventDefault();
    pick(next.value);
    [...(ref.current?.querySelectorAll<HTMLElement>("[data-value]") ?? [])]
      .find((el) => el.dataset.value === next.value)
      ?.focus();
  };
  return (
    <div className={cx("ca-tabs", className)}>
      <div ref={ref} role="tablist" aria-label={label} className="ca-tablist" onKeyDown={key}>
        {tabs.map((tab) => {
          const on = tab.value === current;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              id={`${base}-${tab.value}`}
              data-value={tab.value}
              aria-selected={on}
              aria-controls={children != null ? `${base}-panel` : undefined}
              tabIndex={on ? 0 : -1}
              disabled={tab.disabled}
              className={cx("ca-tab", on && "ca-tab-on")}
              onClick={() => pick(tab.value)}
            >
              {tab.icon ? <Icon name={tab.icon} size={18} /> : null}
              <span>{tab.label}</span>
              {tab.count != null ? <span className="ca-tab-count">{tab.count}</span> : null}
            </button>
          );
        })}
      </div>
      {children != null ? (
        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-${current}`}
          className="ca-tabpanel"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a panel takes focus so its content can be reached and scrolled
          tabIndex={0}
        >
          {typeof children === "function" ? children(current ?? "") : children}
        </div>
      ) : null}
    </div>
  );
}
