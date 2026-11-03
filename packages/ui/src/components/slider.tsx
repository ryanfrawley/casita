import { type ChangeEvent, type CSSProperties, type SyntheticEvent, useId, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface SliderProps {
  label?: string;
  ariaLabel?: string;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Default "%". */
  unit?: string;
  tone?: "lamp" | "sky" | "ember" | "neutral";
  pending?: boolean;
  pendingText?: string;
  unavailable?: boolean;
  disabled?: boolean;
  /** `read` draws the level as a meter with no thumb. */
  level?: "control" | "read";
  marks?: number[];
  formatValue?: (value: number) => string;
  /** Every movement of the thumb. */
  onChange?: (value: number) => void;
  /** When the thumb is let go: the moment to send a command. */
  onCommit?: (value: number) => void;
  className?: string;
}

export function Slider({
  label,
  ariaLabel,
  value: given,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  tone = "lamp",
  pending,
  pendingText,
  unavailable,
  disabled,
  level,
  marks,
  formatValue,
  onChange,
  onCommit,
  className,
}: SliderProps) {
  const [own, setOwn] = useState(defaultValue ?? min);
  const value = given ?? own;
  const id = useId();
  const readOnly = level === "read";
  const format = formatValue ?? ((v: number) => `${v}${unit}`);
  const style = { "--pct": `${((value - min) / (max - min || 1)) * 100}%` } as CSSProperties;
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (given == null) setOwn(next);
    onChange?.(next);
  };
  const commit = (event: SyntheticEvent<HTMLInputElement>) =>
    onCommit?.(Number(event.currentTarget.value));

  const head = label ? (
    <div className="ca-slider-head">
      {readOnly ? (
        <span className="ca-slider-label">{label}</span>
      ) : (
        <label htmlFor={id} className="ca-slider-label">
          {label}
        </label>
      )}
      <span className="ca-slider-value">
        {unavailable ? (
          "Unavailable"
        ) : pending ? (
          <>
            <Icon name="loader-circle" size={14} spin />
            {pendingText ?? `Setting ${format(value)}…`}
          </>
        ) : (
          format(value)
        )}
      </span>
    </div>
  ) : null;

  return (
    <div
      className={cx(
        "ca-slider",
        `ca-slider-${tone}`,
        pending && "ca-slider-pending",
        unavailable && "ca-slider-unavailable",
        className,
      )}
    >
      {head}
      {readOnly && !unavailable ? (
        // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be drawn like the slider track across browsers
        <div
          id={id}
          role="meter"
          className="ca-range-read"
          style={style}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={format(value)}
          aria-label={label ?? ariaLabel}
        >
          <span />
        </div>
      ) : (
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={unavailable || disabled || readOnly}
          className="ca-range"
          style={style}
          aria-valuetext={unavailable ? "Unavailable" : format(value)}
          aria-label={label ? undefined : ariaLabel}
          onChange={change}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      )}
      {marks ? (
        <div className="ca-slider-marks">
          {marks.map((mark) => (
            <span key={mark}>{format(mark)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
