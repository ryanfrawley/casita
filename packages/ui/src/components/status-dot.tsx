import { cx } from "../util.ts";

export type DeviceStatus = "online" | "unavailable" | "error" | "disabled";

export interface StatusDotProps {
  status: DeviceStatus;
  /** Overrides the status's word. */
  label?: string;
  /** The tooltip's second line: "Last seen just now". */
  detail?: string;
  size?: "sm" | "md" | "lg";
  placement?: "top" | "bottom";
  align?: "start" | "center" | "end";
  /** Default true, so the word can be reached with Tab. */
  focusable?: boolean;
  className?: string;
}

const STATUS_WORD: Record<DeviceStatus, string> = {
  online: "Online",
  unavailable: "Unavailable",
  error: "Error",
  disabled: "Disabled",
};

/** A device's connectivity as a dot; the word is its tooltip and its accessible name. */
export function StatusDot({
  status: given,
  label,
  detail,
  size = "md",
  placement = "top",
  align = "center",
  focusable,
  className,
}: StatusDotProps) {
  const status = Object.hasOwn(STATUS_WORD, given) ? given : "unavailable";
  const word = label ?? STATUS_WORD[status];
  return (
    <span
      className={cx(
        "ca-status",
        `ca-status-${status}`,
        `ca-status-${size}`,
        `ca-status-tip-${placement}`,
        `ca-status-align-${align}`,
        className,
      )}
      role="img"
      aria-label={detail ? `${word}. ${detail}` : word}
      // Focus is how a keyboard reaches the tooltip.
      tabIndex={focusable === false ? undefined : 0}
    >
      <span className="ca-status-dot" aria-hidden />
      <span className="ca-status-tip" aria-hidden>
        <strong>{word}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
    </span>
  );
}
