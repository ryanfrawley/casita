import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  icon?: string;
  count?: number;
  children: ReactNode;
}

/** A rounded toggle for filtering: lights, switches, locks. */
export function Pill({ selected, icon, count, className, children, ...rest }: PillProps) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={Boolean(selected)}
      className={cx("ca-pill", selected && "ca-pill-on", className)}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
      {count != null ? <span className="ca-pill-count">{count}</span> : null}
    </button>
  );
}

export interface PillOption {
  value: string;
  label: string;
  icon?: string;
  count?: number;
  disabled?: boolean;
}
export interface PillGroupProps {
  options: PillOption[];
  label: string;
  value?: string[];
  defaultValue?: string[];
  onChange?: (value: string[]) => void;
  /** Default true. */
  multiple?: boolean;
  /** The "All" pill's text; `null` leaves it out. */
  allLabel?: string | null;
  allCount?: number;
  className?: string;
}

/** A row of filter pills with an "All" pill. Multi-select by default; selecting nothing means all. */
export function PillGroup({
  options,
  label,
  value,
  defaultValue,
  onChange,
  multiple = true,
  allLabel,
  allCount,
  className,
}: PillGroupProps) {
  const [own, setOwn] = useState(defaultValue ?? []);
  const current = value ?? own;
  const set = (next: string[]) => {
    if (!value) setOwn(next);
    onChange?.(next);
  };
  const toggle = (key: string) => {
    const on = current.includes(key);
    if (multiple) set(on ? current.filter((k) => k !== key) : [...current, key]);
    else set(on ? [] : [key]);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own frame and legend
    <div className={cx("ca-pills", className)} role="group" aria-label={label}>
      {allLabel === null ? null : (
        <Pill selected={current.length === 0} onClick={() => set([])} count={allCount}>
          {allLabel ?? "All"}
        </Pill>
      )}
      {options.map((option) => (
        <Pill
          key={option.value}
          icon={option.icon}
          count={option.count}
          disabled={option.disabled}
          selected={current.includes(option.value)}
          onClick={() => toggle(option.value)}
        >
          {option.label}
        </Pill>
      ))}
    </div>
  );
}
