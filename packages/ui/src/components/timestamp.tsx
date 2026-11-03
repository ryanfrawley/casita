import { useEffect, useState } from "react";
import { formatTime, formatWhen, type TimeFormat, toDate } from "../time.ts";
import { cx } from "../util.ts";

export interface TimestampProps {
  value: Date | number | string;
  format?: TimeFormat;
  /** Words before the time: "Updated". */
  prefix?: string;
  /** Default true: a relative time re-reads the clock every 30 seconds. */
  live?: boolean;
  /** Fixes "now", for tests and previews; turns `live` off. */
  now?: Date | number | string;
  className?: string;
}

/** A time, written by the content rules, that keeps itself current. Its tooltip is the full date and time. */
export function Timestamp({ value, format, prefix, live, now, className }: TimestampProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (live === false || now != null) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [live, now]);
  const date = toDate(value);
  const valid = !Number.isNaN(date.getTime());
  return (
    <time
      className={cx("ca-time", className)}
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? formatWhen(date.getTime()) : undefined}
    >
      {prefix ? `${prefix} ` : null}
      {formatTime(date, { format, now })}
    </time>
  );
}
