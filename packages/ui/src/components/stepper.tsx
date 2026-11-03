import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface StepperProps {
  /** The confirmed value; `null` shows `emptyText` and disables both buttons. */
  value: number | null;
  onChange?: (next: number) => void;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  formatValue?: (value: number) => string;
  /** A change is in flight; show `pendingValue` until the device confirms. */
  pending?: boolean;
  pendingValue?: number | null;
  /** Default true: the small spinner while pending. */
  showSpinner?: boolean;
  size?: "md" | "sm";
  disabled?: boolean;
  emptyText?: string;
  className?: string;
}

/** The value one step up (`direction` 1) or down (-1), snapped to the step and kept in range. */
export function stepValue(
  base: number,
  direction: 1 | -1,
  { min = -Infinity, max = Infinity, step = 1 }: { min?: number; max?: number; step?: number },
): number {
  const decimals = String(step).split(".")[1]?.length ?? 0;
  const snapped = Math.round((base + direction * step) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}

/**
 * − value + for a number set in steps: a set point, a duration, a count. The value box is a
 * fixed width, sized for the longest value in range, so nothing moves while stepping.
 */
export function Stepper({
  value,
  onChange,
  label,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit = "",
  formatValue,
  pending,
  pendingValue,
  showSpinner,
  size = "md",
  disabled,
  emptyText = "—",
  className,
}: StepperProps) {
  const decimals = String(step).split(".")[1]?.length ?? 0;
  const format = formatValue ?? ((v: number) => `${Number(v.toFixed(decimals))}${unit}`);
  const base = pending && pendingValue != null ? pendingValue : value;
  const off = disabled || base == null;
  const widest = [
    Number.isFinite(min) ? format(min) : "",
    Number.isFinite(max) ? format(max) : "",
    base == null ? "" : format(base),
    emptyText,
    decimals && Number.isFinite(max) ? format(max - step) : "",
  ].reduce((most, text) => Math.max(most, text.length), 3);
  const go = (direction: 1 | -1) => {
    if (disabled || base == null) return;
    const next = stepValue(base, direction, { min, max, step });
    if (next !== base) onChange?.(next);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own frame and legend
    <div
      className={cx(
        "ca-stepper",
        `ca-stepper-${size}`,
        pending && "ca-stepper-pending",
        off && "ca-stepper-off",
        className,
      )}
      role="group"
      aria-label={label}
      aria-busy={pending || undefined}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowRight") {
          event.preventDefault();
          go(1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
          event.preventDefault();
          go(-1);
        }
      }}
    >
      <button
        type="button"
        className="ca-stepper-btn"
        aria-label="Decrease"
        disabled={off || base == null || base <= min}
        onClick={() => go(-1)}
      >
        <Icon name="minus" size={18} />
      </button>
      <output
        className="ca-stepper-value"
        aria-live="polite"
        style={{ width: `calc(${widest}ch + 8px)` }}
      >
        {base == null ? emptyText : format(base)}
      </output>
      <button
        type="button"
        className="ca-stepper-btn"
        aria-label="Increase"
        disabled={off || base == null || base >= max}
        onClick={() => go(1)}
      >
        <Icon name="plus" size={18} />
      </button>
      {pending && showSpinner !== false ? (
        <span className="ca-stepper-spin" title="Waiting for the device">
          <Icon name="loader-circle" size={12} spin />
        </span>
      ) : null}
    </div>
  );
}
