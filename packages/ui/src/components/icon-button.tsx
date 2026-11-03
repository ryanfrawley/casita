import type { ButtonHTMLAttributes } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Required: it is the accessible name and the tooltip. */
  label: string;
  size?: "md" | "sm";
  variant?: "quiet" | "secondary";
  pressed?: boolean;
}

/** A square button holding one icon. */
export function IconButton({
  icon,
  label,
  size = "md",
  variant = "quiet",
  pressed,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed == null ? undefined : pressed}
      {...rest}
      className={cx("ca-iconbtn", `ca-iconbtn-${size}`, `ca-iconbtn-${variant}`, className)}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 20} />
    </button>
  );
}
