import type { ButtonHTMLAttributes } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "md" | "sm";
  icon?: string;
  /** What it does is under way: a spinner in the icon's place, and presses are ignored. */
  busy?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <button
      type="button"
      {...rest}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onClick}
      className={cx("ca-btn", `ca-btn-${variant}`, `ca-btn-${size}`, className)}
    >
      {busy ? (
        <Icon name="loader-circle" size={iconSize} spin />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
    </button>
  );
}
