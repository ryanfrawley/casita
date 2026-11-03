import { cx } from "../util.ts";

export interface RangeBarProps {
  from: number;
  to: number;
  min?: number;
  max?: number;
  /** A tick on the scale: the current value. */
  marker?: number;
  /** `accent` follows the enclosing card's `--ca-accent`; `danger` marks a low reading. */
  tone?: "neutral" | "ember" | "sky" | "lamp" | "sage" | "danger" | "accent";
  label?: string;
  className?: string;
}

/** A span on a scale: a day's low–high against the week, a comfort band, an allowed window. */
export function RangeBar({
  from,
  to,
  min = 0,
  max = 100,
  marker,
  tone = "neutral",
  label,
  className,
}: RangeBarProps) {
  const percent = (value: number) =>
    Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100));
  const start = percent(Math.min(from, to));
  const end = percent(Math.max(from, to));
  return (
    <span
      className={cx("ca-rangebar", `ca-rangebar-${tone}`, className)}
      role="img"
      aria-label={label ?? `${from} to ${to}`}
    >
      <span
        className="ca-rangebar-fill"
        style={{ left: `${start}%`, width: `${Math.max(end - start, 2)}%` }}
      />
      {marker != null ? (
        <span className="ca-rangebar-mark" style={{ left: `${percent(marker)}%` }} />
      ) : null}
    </span>
  );
}
