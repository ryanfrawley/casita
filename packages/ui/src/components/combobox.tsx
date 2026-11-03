import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useOutside } from "../hooks.ts";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { describedBy, FieldFoot } from "./field.tsx";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  disabled?: boolean;
}
export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onChange?: (value: string, option: ComboboxOption) => void;
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  emptyText?: string;
  mono?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** The options a typed query keeps: a match anywhere in the label, value or description. */
export function filterOptions(options: ComboboxOption[], query: string | null): ComboboxOption[] {
  if (!query) return options;
  const q = query.toLowerCase();
  return options.filter((o) =>
    `${o.label} ${o.value} ${o.description ?? ""}`.toLowerCase().includes(q),
  );
}

/** Pick one of a long list by typing: entities, areas, integration types. */
export function Combobox({
  options,
  value,
  onChange,
  label,
  placeholder,
  hint,
  error,
  emptyText = "No matches",
  mono,
  disabled,
  id,
  className,
}: ComboboxProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const listId = `${fieldId}-list`;
  const selected = options.find((o) => o.value === value);
  /** `query` is null until the person types; then it replaces the selected label in the box. */
  const [state, setState] = useState({ open: false, query: null as string | null, active: 0 });
  const set = (patch: Partial<typeof state>) => setState((old) => ({ ...old, ...patch }));
  const list = filterOptions(options, state.query);
  const wrap = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useOutside(wrap, state.open, () => set({ open: false, query: null }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active option or the list's presence changes
  useEffect(() => {
    listRef.current?.querySelector(".ca-combo-active")?.scrollIntoView?.({ block: "nearest" });
  }, [state.active, state.open]);

  const pick = (option: ComboboxOption | undefined) => {
    if (!option || option.disabled) return;
    onChange?.(option.value, option);
    set({ open: false, query: null, active: 0 });
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      set({
        open: true,
        active: state.open
          ? Math.min(list.length - 1, state.active + 1)
          : Math.max(0, selected ? list.indexOf(selected) : 0),
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      set({ active: Math.max(0, state.active - 1) });
    } else if (event.key === "Enter" && state.open) {
      event.preventDefault();
      pick(list[state.active]);
    } else if (event.key === "Escape" && state.open) {
      event.preventDefault();
      event.stopPropagation();
      set({ open: false, query: null });
    } else if (event.key === "Tab") {
      set({ open: false, query: null });
    }
  };

  return (
    <div ref={wrap} className={cx("ca-field", "ca-combo", error && "ca-field-invalid", className)}>
      {label ? (
        <label htmlFor={fieldId} className="ca-field-label">
          {label}
        </label>
      ) : null}
      <div className="ca-combo-box">
        <input
          id={fieldId}
          role="combobox"
          aria-expanded={state.open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            state.open && list[state.active] ? `${listId}-${state.active}` : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          className={cx("ca-input", "ca-combo-input", mono && "ca-mono")}
          placeholder={placeholder}
          value={state.query ?? selected?.label ?? ""}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set({ query: event.target.value, open: true, active: 0 })}
          onClick={() => set({ open: true })}
          onFocus={(event) => event.target.select()}
          onKeyDown={key}
        />
        <Icon name="chevron-down" size={16} className="ca-select-chevron" />
        {state.open ? (
          <ul
            id={listId}
            ref={listRef}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a listbox the input drives, not a form select
            role="listbox"
            className="ca-pop ca-combo-list"
            aria-label={label}
          >
            {list.length ? (
              list.map((option, i) => {
                const on = option.value === value;
                return (
                  // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the input; aria-activedescendant points here
                  <li
                    key={option.value}
                    id={`${listId}-${i}`}
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see the listbox above
                    role="option"
                    aria-selected={on}
                    aria-disabled={option.disabled || undefined}
                    className={cx(
                      "ca-pop-item",
                      i === state.active && "ca-combo-active",
                      option.disabled && "ca-pop-disabled",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option);
                    }}
                    onMouseEnter={() => set({ active: i })}
                  >
                    {option.icon ? <Icon name={option.icon} size={18} /> : null}
                    <span className="ca-pop-text">
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className={cx("ca-pop-hint", mono && "ca-mono")}>
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {on ? <Icon name="check" size={16} className="ca-pop-check" /> : null}
                  </li>
                );
              })
            ) : (
              <li className="ca-pop-empty" role="presentation">
                {emptyText}
              </li>
            )}
          </ul>
        ) : null}
      </div>
      <FieldFoot id={fieldId} error={error} hint={hint} />
    </div>
  );
}
