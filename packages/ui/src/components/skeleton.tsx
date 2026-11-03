import { cx } from "../util.ts";

export interface SkeletonProps {
  shape?: "text" | "block" | "circle";
  /** Text only: more than one stacks lines, the last one shorter. */
  lines?: number;
  width?: number | string;
  height?: number | string;
  lastWidth?: number | string;
  className?: string;
}

/** A placeholder shape while the first data loads. Never a state: no "Off", no 0. */
export function Skeleton({
  shape = "text",
  lines = 1,
  width,
  height,
  lastWidth = "60%",
  className,
}: SkeletonProps) {
  if (shape === "text" && lines > 1) {
    return (
      <span className={cx("ca-skel-stack", className)} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder lines have only their position
            key={i}
            className="ca-skel ca-skel-text"
            style={{ width: i === lines - 1 ? lastWidth : (width ?? "100%") }}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={cx("ca-skel", `ca-skel-${shape}`, className)}
      style={{ width, height }}
      aria-hidden
    />
  );
}
