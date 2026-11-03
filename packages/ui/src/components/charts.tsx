import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type ChartTone,
  linePath,
  niceTicks,
  type Point,
  type StateSegment,
  seriesColor,
  sortedPoints,
  type TimeSeries,
  TONE_FILL,
  timeInState,
  timeTicks,
  valueAt,
  valueRange,
} from "../chart-math.ts";
import { formatClock, formatDuration, formatTick, formatWhen } from "../time.ts";
import { cx } from "../util.ts";

export type { ChartTone, StateSegment, TimePoint, TimeSeries } from "../chart-math.ts";

type KeyShape = "line" | "step" | "rect" | "band" | "hatch";
export interface LegendItem {
  label: string;
  /** A CSS colour, usually a token: `var(--series-1)`. */
  fill?: string;
  shape?: KeyShape;
}

const keyStyle = (fill?: string) => ({ "--key": fill }) as CSSProperties;

/** The element's width, kept current as it resizes; `fallback` until it is measured. */
function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || fallback);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, fallback]);
  return width;
}

function HatchDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width={8}
        height={8}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line x1={0} y1={0} x2={0} y2={8} className="ca-hatch" />
      </pattern>
    </defs>
  );
}

// ───────── frame, legend, tooltip ─────────

export interface ChartLegendProps {
  items: LegendItem[];
  className?: string;
}

/** A row of series keys: a short line, step, swatch or hatch beside each label. */
export function ChartLegend({ items, className }: ChartLegendProps) {
  return (
    <ul className={cx("ca-legend", className)}>
      {items.map((item) => (
        <li key={item.label}>
          <span
            className={cx("ca-key", `ca-key-${item.shape ?? "line"}`)}
            style={keyStyle(item.fill)}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface ChartFrameProps {
  title?: string;
  subtitle?: string;
  legend?: LegendItem[] | null;
  className?: string;
  children?: ReactNode;
}

/** The card every chart sits in: title, subtitle and legend. */
export function ChartFrame({ title, subtitle, legend, className, children }: ChartFrameProps) {
  return (
    <figure className={cx("ca-chart", className)}>
      <figcaption className="ca-chart-head">
        <div className="ca-chart-titles">
          {title ? <div className="ca-chart-title">{title}</div> : null}
          {subtitle ? <div className="ca-chart-sub">{subtitle}</div> : null}
        </div>
      </figcaption>
      {legend?.length ? <ChartLegend items={legend} /> : null}
      {children}
    </figure>
  );
}

interface Tip {
  key?: number;
  x: number;
  y: number;
  /** Centred over `x` instead of beside it. */
  above?: boolean;
  head?: string;
  rows: { fill?: string; shape?: KeyShape; value: string; label: string }[];
}

const TIP_WIDTH = 200;

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const beside = tip.x + 14;
  const flip = beside + TIP_WIDTH > width;
  const style: CSSProperties = tip.above
    ? { left: Math.max(0, Math.min(width - TIP_WIDTH, tip.x - TIP_WIDTH / 2)), top: tip.y }
    : flip
      ? { right: width - tip.x + 14, top: tip.y }
      : { left: beside, top: tip.y };
  return (
    <div className={cx("ca-tip", tip.above && "ca-tip-above")} role="status" style={style}>
      <div className="ca-tip-head">{tip.head}</div>
      {tip.rows.map((row) => (
        <div className="ca-tip-row" key={`${row.label}|${row.value}`}>
          {row.fill ? (
            <span
              className={cx("ca-key", `ca-key-${row.shape ?? "line"}`)}
              style={keyStyle(row.fill)}
            />
          ) : null}
          <strong>{row.value}</strong>
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

// ───────── values over time ─────────

export interface TimeBand {
  from: number;
  /** Absent while the period is still going. */
  to?: number;
  tone: ChartTone;
  label?: string;
}

export interface TimeSeriesChartProps {
  /** At most three; past that, split into another chart. */
  series: TimeSeries[];
  label?: string;
  unit?: string;
  decimals?: number;
  yDomain?: [number, number];
  xDomain?: [number, number];
  height?: number;
  /** Shaded periods behind the lines: heating, cooling, unavailable. */
  bands?: TimeBand[];
  formatValue?: (value: number | null) => string;
  /** Default true: each line's last value and name at its right end, when they don't collide. */
  directLabels?: boolean;
  className?: string;
}

const MARGIN = { left: 44, top: 12, bottom: 28 };

/** Values over time on one y-axis: measured lines, stepped set points, and shaded periods. */
export function TimeSeriesChart({
  series: given,
  label = "Chart",
  unit = "",
  decimals = 1,
  yDomain,
  xDomain,
  height = 240,
  bands = [],
  formatValue,
  directLabels,
  className,
}: TimeSeriesChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 640);
  const [hover, setHover] = useState<number | null>(null);
  const hatch = useId();
  const format =
    formatValue ?? ((v: number | null) => (v == null ? "Unavailable" : v.toFixed(decimals) + unit));

  const series = given.slice(0, 3).map((s, i) => ({
    ...s,
    sorted: sortedPoints(s),
    stroke: seriesColor(s, i),
  }));
  const all = series.flatMap((s) => s.sorted);
  const times = [...new Set(all.map((point) => point.t))].sort((a, b) => a - b);
  const t0 = xDomain ? xDomain[0] : (times[0] ?? 0);
  const t1 = xDomain ? xDomain[1] : (times.at(-1) ?? 0);
  const values = all.flatMap((point) => (point.v == null ? [] : [point.v]));
  let [y0, y1] = yDomain ?? valueRange(values);
  const ticks = yDomain
    ? niceTicks(y0, y1, 4).filter((v) => v >= y0 && v <= y1)
    : niceTicks(y0, y1, 4);
  if (!yDomain) {
    y0 = ticks[0] ?? y0;
    y1 = ticks.at(-1) ?? y1;
  }

  const innerHeight = height - MARGIN.top - MARGIN.bottom;
  const Y = (v: number) => MARGIN.top + innerHeight - ((v - y0) / (y1 - y0 || 1)) * innerHeight;
  const ends = series.map(
    (s) => s.sorted.findLast((point) => point.v != null) as Point | undefined,
  );
  const endY = ends.map((end) => (end?.v != null ? Y(end.v) : null));
  const collide = endY.some((a, i) =>
    endY.some((b, j) => i < j && a != null && b != null && Math.abs(a - b) < 30),
  );
  const showDirect = directLabels !== false && !collide;
  const innerWidth = Math.max(40, width - MARGIN.left - (showDirect ? 112 : 16));
  const X = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0 || 1)) * innerWidth;
  const axis = timeTicks(t0, t1, innerWidth);

  const move = (event: PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const t = t0 + ((event.clientX - box.left - MARGIN.left) / innerWidth) * (t1 - t0);
    let best = 0;
    for (const [i, time] of times.entries()) {
      if (Math.abs(time - t) < Math.abs((times[best] ?? 0) - t)) best = i;
    }
    setHover(best);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const from = hover ?? times.length - 1;
      const next = from + (event.key === "ArrowRight" ? 1 : -1);
      setHover(Math.max(0, Math.min(times.length - 1, next)));
    }
    if (event.key === "Escape") setHover(null);
  };

  const at = hover == null ? undefined : times[hover];
  let tip: Tip | null = null;
  if (at != null) {
    const band = bands.find((b) => at >= b.from && at <= (b.to ?? t1));
    tip = {
      x: X(at),
      y: MARGIN.top,
      head: formatWhen(at),
      rows: [
        ...series.map((s) => ({
          fill: s.stroke,
          shape: (s.step ? "step" : "line") as KeyShape,
          value: format(valueAt(s.sorted, at, s.step)?.v ?? null),
          label: s.label,
        })),
        ...(band?.label ? [{ value: band.label, label: "" }] : []),
      ],
    };
  }

  return (
    <div ref={ref} className={cx("ca-plot", "ca-tsc", className)} style={{ height }}>
      <svg
        width={width}
        height={height}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is how a keyboard reads the values
        tabIndex={0}
        role="img"
        aria-label={`${label}. Use left and right arrows to read values.`}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
        onKeyDown={key}
        onBlur={() => setHover(null)}
      >
        <HatchDefs id={hatch} />
        {bands.map((band) => {
          const x = X(Math.max(t0, band.from));
          const w = X(Math.min(t1, band.to ?? t1)) - x;
          return (
            <rect
              key={`${band.from}-${band.tone}`}
              x={x}
              y={MARGIN.top}
              width={Math.max(0, w)}
              height={innerHeight}
              className="ca-band"
              style={{
                fill:
                  band.tone === "unavailable"
                    ? `url(#${hatch})`
                    : (TONE_FILL[band.tone] ?? "var(--ink-muted)"),
              }}
            />
          );
        })}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + innerWidth}
              y1={Y(v)}
              y2={Y(v)}
              className="ca-grid"
            />
            <text
              x={MARGIN.left - 8}
              y={Y(v)}
              className="ca-axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {v + (unit.length <= 2 ? unit : "")}
            </text>
          </g>
        ))}
        {axis.ticks.map((t) => (
          <text key={t} x={X(t)} y={height - 8} className="ca-axis" textAnchor="middle">
            {formatTick(t, axis.step)}
          </text>
        ))}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + innerWidth}
          y1={MARGIN.top + innerHeight}
          y2={MARGIN.top + innerHeight}
          className="ca-baseline"
        />
        {at != null ? (
          <line
            x1={X(at)}
            x2={X(at)}
            y1={MARGIN.top}
            y2={MARGIN.top + innerHeight}
            className="ca-crosshair"
          />
        ) : null}
        {series.map((s) => (
          <path
            key={s.id ?? s.label}
            d={linePath(s.sorted, X, Y, s.step, X(t1))}
            className="ca-line"
            style={{ stroke: s.stroke }}
          />
        ))}
        {series.map((s, i) => {
          const end = ends[i];
          return end?.v != null && !s.step ? (
            <circle
              key={s.id ?? s.label}
              cx={X(end.t)}
              cy={Y(end.v)}
              r={4}
              className="ca-dot"
              style={{ fill: s.stroke }}
            />
          ) : null;
        })}
        {at != null
          ? series.map((s) => {
              const point = valueAt(s.sorted, at, s.step);
              return point?.v != null ? (
                <circle
                  key={s.id ?? s.label}
                  cx={s.step ? X(at) : X(point.t)}
                  cy={Y(point.v)}
                  r={4}
                  className="ca-dot"
                  style={{ fill: s.stroke }}
                />
              ) : null;
            })
          : null}
        {showDirect
          ? series.map((s, i) => {
              const end = ends[i];
              return end?.v != null ? (
                <g
                  key={s.id ?? s.label}
                  transform={`translate(${MARGIN.left + innerWidth + 10},${Y(end.v)})`}
                >
                  <text className="ca-endval" dominantBaseline="middle" y={-6}>
                    {format(end.v)}
                  </text>
                  <text className="ca-endlab" dominantBaseline="middle" y={9}>
                    {s.label}
                  </text>
                </g>
              ) : null;
            })
          : null}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** Legend items for a TimeSeriesChart's series and labelled bands, in draw order. */
export function timeSeriesLegend(series: TimeSeries[], bands: TimeBand[] = []): LegendItem[] {
  const items: LegendItem[] = series.slice(0, 3).map((s, i) => ({
    label: s.label,
    fill: seriesColor(s, i),
    shape: s.step ? "step" : "line",
  }));
  for (const band of bands) {
    if (!band.label || items.some((item) => item.label === band.label)) continue;
    const unavailable = band.tone === "unavailable";
    items.push({
      label: band.label,
      fill: unavailable ? "var(--unavailable)" : TONE_FILL[band.tone],
      shape: unavailable ? "hatch" : "band",
    });
  }
  return items;
}

export interface TimeSeriesCardProps extends TimeSeriesChartProps {
  title?: string;
  subtitle?: string;
}

/** TimeSeriesChart in a card, with title, subtitle and (for two or more keys) a legend. */
export function TimeSeriesCard({ title, subtitle, className, ...chart }: TimeSeriesCardProps) {
  const legend = timeSeriesLegend(chart.series, chart.bands);
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      legend={legend.length > 1 ? legend : null}
      className={className}
    >
      <TimeSeriesChart {...chart} label={chart.label ?? title} />
    </ChartFrame>
  );
}

// ───────── states over time ─────────

export type StateDefs = Record<string, { label: string; tone: ChartTone }>;

const STATE_DEFAULTS: StateDefs = {
  on: { label: "On", tone: "on" },
  off: { label: "Off", tone: "off" },
  unavailable: { label: "Unavailable", tone: "unavailable" },
};
const stateDef = (states: StateDefs, key: string) =>
  states[key] ?? { label: key, tone: "off" as const };

export interface TimeAxisProps {
  xDomain: [number, number];
  className?: string;
}

/** Time labels for a range, on their own: sits under one or more StateTimelines. */
export function TimeAxis({ xDomain: [t0, t1], className }: TimeAxisProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 480);
  const axis = timeTicks(t0, t1, width);
  return (
    <div ref={ref} className={cx("ca-taxis", className)} aria-hidden>
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decoration; its parent is hidden from assistive technology */}
      <svg width={width} height={20}>
        {axis.ticks.map((t) => {
          const x = ((t - t0) / (t1 - t0 || 1)) * width;
          return (
            <text
              key={t}
              x={x}
              y={14}
              className="ca-axis"
              textAnchor={x < 16 ? "start" : x > width - 16 ? "end" : "middle"}
            >
              {formatTick(t, axis.step)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

export interface StateTimelineProps {
  segments: StateSegment[];
  xDomain: [number, number];
  /** How each state reads and is drawn; on, off and unavailable are known already. */
  states?: StateDefs;
  label?: string;
  height?: number;
  /** Draws the time labels underneath. */
  axis?: boolean;
  /** Draws tick lines behind the bar, for rows stacked in a card. */
  grid?: boolean;
  className?: string;
}

/** One entity's state over time, as a single bar: on/off, locked/unlocked, heat/idle. */
export function StateTimeline({
  segments,
  xDomain,
  states: given,
  label,
  height: barHeight = 20,
  axis,
  grid,
  className,
}: StateTimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, 480);
  const [tip, setTip] = useState<Tip | null>(null);
  const hatch = useId();
  const states = { ...STATE_DEFAULTS, ...given };
  const [t0, t1] = xDomain;
  const rowHeight = grid ? Math.max(barHeight + 12, 32) : barHeight;
  const middle = rowHeight / 2;
  const top = middle - barHeight / 2;
  const X = (t: number) => ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0 || 1)) * width;
  const ticks = timeTicks(t0, t1, width).ticks;

  return (
    <div className={cx("ca-stl", className)}>
      <div
        ref={ref}
        className="ca-plot"
        style={{ height: rowHeight }}
        onPointerLeave={() => setTip(null)}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a group of images inside an svg has no element of its own */}
        <svg
          width={width}
          height={rowHeight}
          role="group"
          aria-label={`${label ? `${label} ` : ""}state history`}
        >
          <HatchDefs id={hatch} />
          {grid
            ? ticks.map((t) => (
                <line key={t} x1={X(t)} x2={X(t)} y1={0} y2={rowHeight} className="ca-grid" />
              ))
            : null}
          {segments.map((segment, i) => {
            const def = stateDef(states, segment.state);
            const end = segment.to ?? t1;
            const x0 = X(segment.from);
            const x1 = X(end);
            // A 2px gap between neighbours, so two segments of one state still read as two.
            const w = Math.max(1, x1 - x0 - (i < segments.length - 1 ? 2 : 0));
            const radius = Math.min(3, w / 2);
            const unavailable = def.tone === "unavailable";
            const until = segment.to != null ? formatClock(end) : "now";
            const show = () =>
              setTip({
                key: i,
                x: (x0 + x1) / 2,
                y: top - 6,
                above: true,
                head: label,
                rows: [
                  {
                    value: def.label,
                    label: `${formatClock(segment.from)} – ${until} · ${formatDuration(end - segment.from)}`,
                  },
                ],
              });
            return (
              // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a focusable picture of one period, not a control
              <g
                key={segment.from}
                // Focus is how a keyboard reads each period.
                tabIndex={0}
                role="img"
                className="ca-seg-hit"
                aria-label={`${def.label} from ${formatClock(segment.from)} to ${until}`}
                onPointerEnter={show}
                onFocus={show}
                onBlur={() => setTip(null)}
              >
                <rect x={x0} y={0} width={Math.max(w, 1)} height={rowHeight} fill="transparent" />
                <rect
                  x={x0}
                  y={top}
                  width={w}
                  height={barHeight}
                  rx={radius}
                  className="ca-seg-bar"
                  style={{
                    fill: unavailable ? `url(#${hatch})` : (TONE_FILL[def.tone] ?? "var(--line)"),
                  }}
                />
                {/* Borders are inset by half their stroke so they stay inside the bar's edge. */}
                {unavailable && w > 1 ? (
                  <rect
                    x={x0 + 0.5}
                    y={top + 0.5}
                    width={w - 1}
                    height={barHeight - 1}
                    rx={Math.max(0, radius - 0.5)}
                    className="ca-seg-edge"
                  />
                ) : null}
                {w > 1.5 ? (
                  <rect
                    x={x0 + 0.75}
                    y={top + 0.75}
                    width={w - 1.5}
                    height={barHeight - 1.5}
                    rx={Math.max(0, radius - 0.75)}
                    className={cx("ca-seg-ring", tip?.key === i && "ca-seg-hover")}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
        <Tooltip tip={tip} width={width} />
      </div>
      {axis ? <TimeAxis xDomain={xDomain} /> : null}
    </div>
  );
}

export interface StateHistoryCardProps {
  rows: { id?: string; label: string; segments: StateSegment[] }[];
  xDomain: [number, number];
  states?: StateDefs;
  /** The state whose total time is shown at each row's end. Default `on`; `null` shows none. */
  summaryState?: string | null;
  title?: string;
  subtitle?: string;
  labelWidth?: number;
  className?: string;
}

/** A card of StateTimelines, one row per entity, with a shared axis, legend and time-in-state totals. */
export function StateHistoryCard({
  rows,
  xDomain,
  states: given,
  summaryState = "on",
  title,
  subtitle,
  labelWidth = 152,
  className,
}: StateHistoryCardProps) {
  const states = { ...STATE_DEFAULTS, ...given };
  const used = [...new Set(rows.flatMap((row) => row.segments.map((segment) => segment.state)))];
  const legend = used.map((key): LegendItem => {
    const def = stateDef(states, key);
    const unavailable = def.tone === "unavailable";
    return {
      label: def.label,
      fill: unavailable ? "var(--unavailable)" : TONE_FILL[def.tone],
      shape: unavailable ? "hatch" : "rect",
    };
  });
  const grid = {
    gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)${summaryState ? " 96px" : ""}`,
  };
  return (
    <ChartFrame title={title} subtitle={subtitle} legend={legend} className={className}>
      <div className="ca-shc">
        {rows.map((row) => (
          <div key={row.id ?? row.label} className="ca-shc-row" style={grid}>
            <div className="ca-shc-label">{row.label}</div>
            <StateTimeline
              segments={row.segments}
              xDomain={xDomain}
              states={given}
              label={row.label}
              grid
            />
            {summaryState ? (
              <div className="ca-shc-sum">
                {stateDef(states, summaryState).label}{" "}
                {formatDuration(timeInState(row.segments, summaryState, xDomain))}
              </div>
            ) : null}
          </div>
        ))}
        <div className="ca-shc-row" style={grid}>
          <div />
          <TimeAxis xDomain={xDomain} />
          {summaryState ? <div /> : null}
        </div>
      </div>
    </ChartFrame>
  );
}
