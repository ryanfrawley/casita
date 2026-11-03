import { type PointerEvent, useMemo, useState } from "react";
import { Icon } from "../icon.tsx";
import { eased, modelElevation, solarElevation } from "../sun-math.ts";
import { cx } from "../util.ts";

export interface SunPathProps {
  /** Sunrise and sunset as clock words: "7:29 am". */
  rise: string;
  set: string;
  /** The house's day, midnight to midnight, in ms: 23 or 25 hours when the clocks change. */
  dayStart: number;
  dayEnd: number;
  /** Sunrise, sunset and now, in ms. */
  riseAt: number;
  setAt: number;
  now: number;
  /** Where the house is. Given, the curve is the sun's true height and the angles are shown. */
  latitude?: number;
  longitude?: number;
  /** The house's zone, for the time under the pointer. */
  timeZone?: string;
  /** What comes next, first: "Sunset in 2h 10m". */
  headline: string;
  /** A word after it: "10h 46m of daylight". */
  detail?: string;
  label: string;
  className?: string;
}

// The drawing's own units: a day 1000 wide and 100 tall, a little room above and below.
const WIDTH = 1000;
const HEIGHT = 100;
const PAD = 8;
const STEPS = 192;

const clamp = (t: number) => Math.max(0, Math.min(1, t));
/** A share as a CSS percentage, to the hundredth. */
const percent = (share: number) => `${Number((share * 100).toFixed(2))}%`;
/** A label's place along the horizon, kept clear of the edges. */
const place = (t: number) => percent(Math.max(0.07, Math.min(0.93, t)));

/** The clock in the house's zone: "2:14 pm". */
function clockIn(timeZone: string | undefined): (ms: number) => string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-US", options);
  }
  return (ms) => format.format(ms).toLowerCase().replace(/\s/g, " ");
}

/** "28° up", "41° down": the sun's angle to the horizon, as the pointer reads it. */
export const angleWords = (degrees: number): string => {
  const whole = Math.round(degrees);
  return whole === 0 ? "On the horizon" : `${Math.abs(whole)}° ${whole > 0 ? "up" : "down"}`;
};

/**
 * The day as the sun's path: its height across the whole day, over the horizon from sunrise
 * to sunset and under it through the night, the sun where it is now, and what comes next.
 * Running a pointer along it reads the time there and, where the house's place is known, the
 * sun's angle.
 */
export function SunPath({
  rise,
  set,
  dayStart,
  dayEnd,
  riseAt,
  setAt,
  now,
  latitude,
  longitude,
  timeZone,
  headline,
  detail,
  label,
  className,
}: SunPathProps) {
  const length = Math.max(1, dayEnd - dayStart);
  const share = (ms: number) => (ms - dayStart) / length;
  const riseShare = clamp(share(riseAt));
  const setShare = clamp(share(setAt));
  const placed = latitude !== undefined && longitude !== undefined;

  // The curve: the sun's height through the day, eased below the horizon, fitted to the drawing.
  const curve = useMemo(() => {
    const elevation = (t: number) =>
      placed
        ? solarElevation(dayStart + t * length, latitude as number, longitude as number)
        : modelElevation(t, riseShare, setShare);
    const heights = Array.from({ length: STEPS + 1 }, (_, i) => eased(elevation(i / STEPS)));
    const top = Math.max(10, ...heights);
    const bottom = Math.min(-5, ...heights);
    const scale = (HEIGHT - 2 * PAD) / (top - bottom);
    const y = (t: number) => PAD + (top - eased(elevation(t))) * scale;
    return { elevation, y, horizon: PAD + top * scale };
  }, [placed, latitude, longitude, dayStart, length, riseShare, setShare]);

  const points = (from: number, to: number): string => {
    const at = (t: number) => `${(t * WIDTH).toFixed(1)},${curve.y(t).toFixed(1)}`;
    const out = [at(from)];
    for (let i = Math.ceil(from * STEPS); i <= Math.floor(to * STEPS); i++) out.push(at(i / STEPS));
    out.push(at(to));
    return out.join(" ");
  };

  const t = clamp(share(now));
  const up = t >= riseShare && t <= setShare;
  const clock = useMemo(() => clockIn(timeZone), [timeZone]);

  // The pointer's place along the day while it is over the curve, or dragging along it.
  const [hover, setHover] = useState<number | null>(null);
  const track = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) setHover(clamp((event.clientX - box.left) / box.width));
  };
  const hoverAngle = hover !== null && placed ? curve.elevation(hover) : undefined;

  return (
    <div className={cx("ca-sun", !up && "ca-sun-night", className)} role="img" aria-label={label}>
      {/* While a pointer reads the day, the heading reads with it: the time there and the
          sun's angle, in place of what comes next. */}
      <div className="ca-sun-head">
        {hover !== null ? (
          <>
            <span className="ca-sun-headline">{clock(dayStart + hover * length)}</span>
            {hoverAngle !== undefined ? (
              <span className="ca-sun-detail">Sun {angleWords(hoverAngle).toLowerCase()}</span>
            ) : null}
          </>
        ) : (
          <>
            <span className="ca-sun-headline">{headline}</span>
            {detail ? <span className="ca-sun-detail">{detail}</span> : null}
            {placed ? (
              <span className="ca-sun-detail">
                · Sun {angleWords(curve.elevation(t)).toLowerCase()}
              </span>
            ) : null}
          </>
        )}
      </div>
      <div
        className={cx("ca-sun-plot", hover !== null && "ca-sun-plot-hover")}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          track(event);
        }}
        onPointerMove={(event) => {
          // A mouse reads as it passes; a finger only while it is down.
          if (event.pointerType === "mouse" || event.buttons) track(event);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setHover(null);
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== "mouse") setHover(null);
        }}
        onPointerCancel={() => setHover(null)}
      >
        <svg
          className="ca-sun-art"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polygon
            className="ca-sun-day"
            points={`${riseShare * WIDTH},${curve.horizon} ${points(riseShare, setShare)} ${setShare * WIDTH},${curve.horizon}`}
          />
          <line
            className="ca-sun-horizon"
            x1={0}
            x2={WIDTH}
            y1={curve.horizon}
            y2={curve.horizon}
          />
          <polyline className="ca-sun-ahead" points={points(t, 1)} />
          {/* The way the sun has come: through the night muted, through the day in its colour. */}
          <polyline className="ca-sun-gone" points={points(0, Math.min(t, riseShare))} />
          {t > riseShare ? (
            <polyline
              className="ca-sun-gone ca-sun-gone-day"
              points={points(riseShare, Math.min(t, setShare))}
            />
          ) : null}
          {t > setShare ? <polyline className="ca-sun-gone" points={points(setShare, t)} /> : null}
        </svg>
        <span
          className={cx("ca-sun-dot", up ? "ca-sun-dot-up" : "ca-sun-dot-down")}
          style={{ left: percent(t), top: percent(curve.y(t) / HEIGHT) }}
        />
        {hover !== null ? (
          <>
            <span className="ca-sun-cursor" style={{ left: percent(hover) }} />
            <span
              className="ca-sun-probe"
              style={{ left: percent(hover), top: percent(curve.y(hover) / HEIGHT) }}
            />
          </>
        ) : null}
      </div>
      <div className="ca-sun-times">
        <span className="ca-sun-time" style={{ left: place(riseShare) }}>
          <Icon name="sunrise" size={14} />
          {rise}
        </span>
        <span className="ca-sun-time" style={{ left: place(setShare) }}>
          <Icon name="sunset" size={14} />
          {set}
        </span>
      </div>
    </div>
  );
}
