import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useOutside } from "../hooks.ts";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { IconButton } from "./icon-button.tsx";

export type MenuItem =
  | {
      label: string;
      icon?: string;
      hint?: string;
      tone?: "danger";
      disabled?: boolean;
      /** Set, the item is a setting that is on or off, with a check when on; unset, an action. */
      checked?: boolean;
      onSelect?: () => void;
      type?: undefined;
    }
  | { type: "separator" }
  | { type: "heading"; label: string };

export interface MenuProps {
  items: MenuItem[];
  /** The trigger's accessible name when it is only an icon. Default "More actions". */
  label?: string;
  /** Makes the trigger a button with this text instead of an icon. */
  text?: string;
  icon?: string;
  variant?: "primary" | "secondary" | "quiet";
  size?: "md" | "sm";
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
}

const ITEMS = "[role=menuitem]:not([disabled]), [role=menuitemcheckbox]:not([disabled])";

/** A short list of actions behind a button: the "…" on a row. */
export function Menu({
  items,
  label,
  text,
  icon,
  variant = "secondary",
  size = "md",
  align = "end",
  disabled,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  useOutside(wrap, open, () => setOpen(false));
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  };
  const key = (event: KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (!els.length) return;
    const at = els.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => {
      event.preventDefault();
      els[(index + els.length) % els.length]?.focus();
    };
    if (event.key === "ArrowDown") focus(at + 1);
    else if (event.key === "ArrowUp") focus(at - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(els.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") setOpen(false);
  };
  const trigger = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    disabled,
    onClick: () => setOpen(!open),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        setOpen(true);
      }
    },
  };

  return (
    <div ref={wrap} className={cx("ca-menu", className)}>
      {text ? (
        <button
          type="button"
          className={cx("ca-btn", `ca-btn-${variant}`, `ca-btn-${size}`)}
          {...trigger}
        >
          {icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
          {text}
          <Icon name="chevron-down" size={16} />
        </button>
      ) : (
        <IconButton
          icon={icon ?? "ellipsis"}
          label={label ?? "More actions"}
          size={size}
          {...trigger}
        />
      )}
      {open ? (
        <div
          id={id}
          ref={list}
          role="menu"
          aria-label={label ?? text}
          className={cx("ca-pop", "ca-menu-list", `ca-menu-${align}`)}
          onKeyDown={key}
        >
          {items.map((item, i) => {
            // The list is fixed for the life of an open menu, so position is a stable key.
            const k = i;
            if (item.type === "separator") {
              // biome-ignore lint/a11y/useSemanticElements: an hr cannot sit in a menu's flex column unstyled
              return <div key={k} role="separator" className="ca-pop-sep" />;
            }
            if (item.type === "heading") {
              return (
                <div key={k} role="presentation" className="ca-pop-heading">
                  {item.label}
                </div>
              );
            }
            return (
              <button
                key={k}
                type="button"
                {...(item.checked === undefined
                  ? { role: "menuitem" }
                  : { role: "menuitemcheckbox", "aria-checked": item.checked })}
                disabled={item.disabled}
                tabIndex={-1}
                className={cx("ca-pop-item", item.tone === "danger" && "ca-pop-danger")}
                onClick={() => {
                  close(true);
                  item.onSelect?.();
                }}
              >
                {item.icon ? <Icon name={item.icon} size={18} /> : null}
                <span className="ca-pop-text">
                  <span>{item.label}</span>
                  {item.hint ? <span className="ca-pop-hint">{item.hint}</span> : null}
                </span>
                {item.checked ? <Icon name="check" size={16} className="ca-pop-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
