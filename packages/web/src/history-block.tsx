// A reading's history on a card: the entity's own history view, slim enough for a card's body.

import { CasitaError, type Row } from "@casita/client";
import { EmptyState, Skeleton, StateTimeline, TimeSeriesChart } from "@casita/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useHouse, useStore } from "./context.tsx";
import { HISTORY_RANGES, type HistoryView, historyKind, historyView, rawRecords } from "./model.ts";

/** A chart this tall, with its label, fills a three-unit block; a state bar this tall, with its
 * 16px label and 20px axis, is one unit exactly. */
const CHART_HEIGHT = 150;
const BAR_HEIGHT = 20;
const LIMIT = 10_000;
/** A reading every few seconds is not a reason to ask for the whole range that often. */
const REFRESH_MS = 60_000;

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: HistoryView; from: number; to: number };

export function HistoryBlock({
  entityId,
  domain,
  label,
  range,
  durationMs,
}: {
  entityId: string;
  domain: string;
  label: string;
  range: "hour" | "day" | "week";
  /** How far back to reach, in place of the range. */
  durationMs?: number;
}) {
  const store = useStore();
  const house = useHouse();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  // Fetched again when the entity reports, but no more than once a minute; and when the house's
  // units change, since the chart is drawn in them.
  const updatedAt = Number(house.states.get(entityId)?.updatedAt ?? 0);
  const tick = Math.floor(updatedAt / REFRESH_MS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and units are when to refetch
  useEffect(() => {
    let current = true;
    const to = Date.now();
    const from = to - (durationMs && durationMs > 0 ? durationMs : HISTORY_RANGES[range].ms);
    store.request("get_history", { entityId, from, to, limit: LIMIT, includePrevious: true }).then(
      (result) => {
        if (!current) return;
        const records = rawRecords((result as { records: Row[] }).records);
        setLoaded({ status: "ready", view: historyView(domain, records, from), from, to });
      },
      (err: unknown) => {
        if (!current) return;
        const message = err instanceof CasitaError ? err.message : "Couldn't load its history";
        setLoaded({ status: "error", message });
      },
    );
    return () => {
      current = false;
    };
  }, [store, entityId, domain, range, durationMs, tick, house.units]);

  // The block's kind is on the wrapper, so the figure around it can be the right number of
  // grid units before the history has even arrived.
  const kind = historyKind(domain);
  const wrap = (content: ReactNode) => (
    <div className={`app-history-figure app-history-${kind}`}>{content}</div>
  );
  if (loaded.status === "loading")
    return wrap(
      <Skeleton
        shape="block"
        height={kind === "values" ? CHART_HEIGHT : BAR_HEIGHT + 20}
        width="100%"
      />,
    );
  if (loaded.status === "error") {
    return wrap(<EmptyState size="inline" icon="triangle-alert" title={loaded.message} />);
  }
  const { view, from, to } = loaded;
  if (view.series?.some((series) => series.points.some(([, value]) => value !== null))) {
    return wrap(
      <TimeSeriesChart
        label={label}
        series={view.series}
        unit={view.unit}
        xDomain={[from, to]}
        height={CHART_HEIGHT}
        directLabels={false}
      />,
    );
  }
  if (view.segments?.length) {
    return wrap(
      <StateTimeline
        label={label}
        segments={view.segments}
        states={view.states}
        xDomain={[from, to]}
        height={BAR_HEIGHT}
        axis
      />,
    );
  }
  return wrap(<EmptyState size="inline" icon="history" title="Nothing recorded in this range" />);
}
