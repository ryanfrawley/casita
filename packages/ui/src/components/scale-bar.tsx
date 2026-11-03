import type { CSSProperties } from "react";
import { cx } from "../util.ts";

export interface ScaleBand {
  label: string;
  /** 1, the best, to 6, the worst: the colour step it is drawn in. */
  tone: number;
}

export interface ScaleBarProps {
  label: string;
  /** The reading as words, unit and all: "21 µg/m³". */
  value: string;
  bands: readonly ScaleBand[];
  /** Where the reading sits: its band, and 0 to 1 along the track. Left out, there is none. */
  placed?: { band: number; position: number };
  className?: string;
}

/** The track: each band's colour at the middle of its equal share, blending into the next. */
export const gradientOf = (bands: readonly ScaleBand[]): string => {
  if (bands.length === 0) return "none";
  // A gradient needs two stops; one band is one colour end to end.
  if (bands.length === 1) {
    const only = `var(--scale-${(bands[0] as ScaleBand).tone})`;
    return `linear-gradient(to right, ${only}, ${only})`;
  }
  const stops = bands.map(
    (band, i) => `var(--scale-${band.tone}) ${(((i + 0.5) / bands.length) * 100).toFixed(1)}%`,
  );
  return `linear-gradient(to right, ${stops.join(", ")})`;
};

/**
 * A reading on a banded scale: one track that runs through the bands' colours, each band an
 * equal share, faint but for the stretch up to the reading, a dot in the band's colour at the
 * reading, and the band's word beside the name.
 */
export function ScaleBar({ label, value, bands, placed, className }: ScaleBarProps) {
  const band = placed ? bands[placed.band] : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot hold the bands, marker and word this draws
    <div
      className={cx("ca-scale", !placed && "ca-scale-none", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={placed?.position ?? 0}
      aria-valuetext={band ? `${value}, ${band.label}` : value}
    >
      <div className="ca-scale-head">
        <span className="ca-scale-name">
          <span className="ca-scale-label">{label}</span>
          {band ? (
            <span className={cx("ca-scale-word", `ca-scale-tone-${band.tone}`)}>{band.label}</span>
          ) : null}
        </span>
        <span className="ca-scale-value">{value}</span>
      </div>
      <div
        className="ca-scale-track"
        style={
          {
            backgroundImage: gradientOf(bands),
            ...(placed ? { "--scale-at": `${placed.position * 100}%` } : {}),
          } as CSSProperties
        }
      >
        {placed ? (
          <span
            className="ca-scale-mark"
            style={
              {
                left: `${placed.position * 100}%`,
                ...(band ? { "--scale-tone": `var(--scale-${band.tone})` } : {}),
              } as CSSProperties
            }
          />
        ) : null}
      </div>
    </div>
  );
}
