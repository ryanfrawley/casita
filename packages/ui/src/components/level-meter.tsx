import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface LevelMeterProps {
  label: string;
  /** `null` while the entity is unavailable. */
  value: number | null;
  entityId?: string;
  /** A tick on the track: the charge limit, the humidity set point. */
  target?: number;
  targetLabel?: string;
  min?: number;
  max?: number;
  /** Default "%". */
  unit?: string;
  /** At or below this the meter reads "Low". */
  low?: number;
  status?: string;
  tone?: string;
  className?: string;
}

/** One level against a target: battery charge vs charge limit, tank level, humidity vs set point. */
export function LevelMeter({
  label,
  value,
  entityId,
  target,
  targetLabel = "Target",
  min = 0,
  max = 100,
  unit = "%",
  low,
  status,
  tone: given = "ok",
  className,
}: LevelMeterProps) {
  const percent = (v: number) => Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100));
  const isLow = value != null && low != null && value <= low;
  const tone = value == null ? "unavailable" : isLow ? "low" : given;
  const word = value == null ? "Unavailable" : isLow ? "Low" : status;
  const targetText = target != null ? `${targetLabel} ${target}${unit}` : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot hold the label, value and target this draws
    <div
      className={cx("ca-meter", `ca-meter-${tone}`, className)}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      aria-valuetext={
        value == null ? "Unavailable" : `${value}${unit}${targetText ? `, ${targetText}` : ""}`
      }
    >
      <div className="ca-meter-head">
        <div>
          <div className="ca-meter-label">{label}</div>
          {entityId ? <code className="ca-mono ca-meter-id">{entityId}</code> : null}
        </div>
        <div className="ca-meter-value">
          {value ?? "—"}
          {value == null ? null : <span>{unit}</span>}
        </div>
      </div>
      <div className="ca-meter-track">
        {value == null ? null : (
          <div className="ca-meter-fill" style={{ width: `${percent(value)}%` }} />
        )}
        {target != null ? (
          <div className="ca-meter-target" style={{ left: `${percent(target)}%` }} />
        ) : null}
      </div>
      <div className="ca-meter-foot">
        {word ? (
          <span className="ca-meter-status">
            {tone === "low" ? <Icon name="triangle-alert" size={14} /> : null}
            {tone === "unavailable" ? <Icon name="wifi-off" size={14} /> : null}
            {word}
          </span>
        ) : (
          <span />
        )}
        {targetText ? <span className="ca-meter-tlabel">{targetText}</span> : null}
      </div>
    </div>
  );
}
