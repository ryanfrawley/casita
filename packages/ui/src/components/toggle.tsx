import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  /** A command is in flight: the knob spins until the device reports. */
  pending?: boolean;
  unavailable?: boolean;
  label?: ReactNode;
}

/** An on/off control, nothing else. Shows the confirmed state. */
export function Toggle({
  checked,
  onChange,
  pending,
  unavailable,
  label,
  className,
  id,
  onClick,
  disabled,
  ...rest
}: ToggleProps) {
  const auto = useId();
  const buttonId = id ?? auto;
  const state = unavailable ? "unavailable" : pending ? "pending" : checked ? "on" : "off";
  const button = (
    <button
      type="button"
      role="switch"
      id={buttonId}
      aria-checked={Boolean(checked)}
      aria-busy={pending || undefined}
      disabled={unavailable || disabled}
      {...rest}
      className={cx("ca-toggle", `ca-toggle-${state}`, !label && className)}
      onClick={(event) => {
        if (pending) return;
        onClick?.(event);
        onChange?.(!checked);
      }}
    >
      <span className="ca-toggle-knob">
        {state === "pending" ? <Icon name="loader-circle" size={12} spin /> : null}
      </span>
    </button>
  );
  if (!label) return button;
  return (
    <span className={cx("ca-toggle-field", className)}>
      {button}
      <label htmlFor={buttonId} className="ca-toggle-label">
        {label}
      </label>
    </span>
  );
}
