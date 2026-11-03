import type { ReactNode } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

type Tone = "neutral" | "on" | "ok" | "pending" | "error" | "unavailable" | "brand";

export interface BadgeProps {
  tone?: Tone;
  /** Overrides the tone's own icon; `null` shows none. */
  icon?: string | null;
  children: ReactNode;
  className?: string;
}

const TONE_ICON: Partial<Record<Tone, string>> = {
  ok: "check",
  pending: "loader-circle",
  error: "triangle-alert",
  unavailable: "wifi-off",
};

export function Badge({ tone = "neutral", icon, children, className }: BadgeProps) {
  const shown = icon === undefined ? TONE_ICON[tone] : icon;
  return (
    <span className={cx("ca-badge", `ca-badge-${tone}`, className)}>
      {shown ? (
        <Icon name={shown} size={14} spin={tone === "pending" && shown === "loader-circle"} />
      ) : null}
      {children}
    </span>
  );
}
