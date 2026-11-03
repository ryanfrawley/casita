import { CasitaError, type Row } from "@casita/client";
import {
  Button,
  Combobox,
  EmptyState,
  Pill,
  SegmentedControl,
  Skeleton,
  StateHistoryCard,
  TimeSeriesCard,
  Toast,
} from "@casita/ui";
import { useEffect, useState } from "react";
import { useHouse, useStore } from "../context.tsx";
import {
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryView,
  historyCsvUrl,
  historyKind,
  historyRangeOf,
  historyResolution,
  historySearch,
  historySelection,
  historyView,
  rawRecords,
} from "../model.ts";

const LIMIT = 10_000;

interface Loaded {
  from: number;
  to: number;
  /** entity id → its history, or why it could not be had. */
  views: Map<string, HistoryView | { error: string }>;
  truncated: string[];
}

function useHistories(entities: Row[], range: HistoryRange): Loaded | undefined {
  const store = useStore();
  const { units } = useHouse();
  const [loaded, setLoaded] = useState<Loaded>();
  const key = entities.map((entity) => `${entity.id}:${entity.domain}`).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the entities; units changes how the same records read
  useEffect(() => {
    let current = true;
    setLoaded(undefined);
    const to = Date.now();
    const from = to - HISTORY_RANGES[range].ms;
    const truncated: string[] = [];
    Promise.all(
      entities.map(async (entity): Promise<[string, HistoryView | { error: string }]> => {
        const id = String(entity.id);
        const domain = String(entity.domain);
        try {
          const result = (await store.request("get_history", {
            entityId: id,
            from,
            to,
            limit: LIMIT,
            resolution: historyResolution(domain, range),
            includePrevious: true,
          })) as { records: Row[] };
          if (result.records.length >= LIMIT) truncated.push(String(entity.name));
          return [id, historyView(domain, rawRecords(result.records), from)];
        } catch (err) {
          const error = err instanceof CasitaError ? err.message : "Couldn't load its history";
          return [id, { error }];
        }
      }),
    ).then((entries) => {
      if (current) setLoaded({ from, to, views: new Map(entries), truncated });
    });
    return () => {
      current = false;
    };
  }, [store, key, range, units]);
  return loaded;
}

export function History() {
  const house = useHouse();
  const [selected, setSelected] = useState(() => historySelection(location.search));
  const [range, setRange] = useState<HistoryRange>(() => historyRangeOf(location.search));
  // The address names what is shown, so a chart can be bookmarked or sent to someone.
  useEffect(() => {
    history.replaceState(null, "", `${location.pathname}${historySearch(selected, range)}`);
  }, [selected, range]);

  const entities = selected
    .map((id) => house.entities.find((entity) => entity.id === id))
    .filter((entity): entity is Row => entity !== undefined);
  const loaded = useHistories(entities, range);
  const domain: [number, number] | undefined = loaded ? [loaded.from, loaded.to] : undefined;

  const values = entities.filter((entity) => historyKind(String(entity.domain)) === "values");
  const states = entities.filter((entity) => historyKind(String(entity.domain)) === "states");
  const view = (entity: Row) => loaded?.views.get(String(entity.id));
  const failures = entities.flatMap((entity) => {
    const got = view(entity);
    return got && "error" in got ? [`${entity.name}: ${got.error}`] : [];
  });

  return (
    <div className="app-page">
      <header className="app-page-head">
        <h1 className="ca-text-title">History</h1>
        <SegmentedControl
          label="Range"
          value={range}
          onChange={(value) => setRange(value as HistoryRange)}
          options={Object.entries(HISTORY_RANGES).map(([value, { label }]) => ({ value, label }))}
        />
      </header>
      <div className="app-history-pick">
        <Combobox
          label="Add an entity"
          placeholder="A name or an id"
          mono
          options={house.entities
            .filter((entity) => !selected.includes(String(entity.id)) && entity.domain !== "button")
            .map((entity) => ({
              value: String(entity.id),
              label: String(entity.name),
              description: String(entity.id),
              icon: String(entity.domain),
            }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          onChange={(id) => setSelected([...selected, id])}
        />
        <div className="app-history-chosen">
          {entities.map((entity) => (
            <Pill
              key={String(entity.id)}
              selected
              icon="x"
              title={`Remove ${entity.name}`}
              onClick={() => setSelected(selected.filter((id) => id !== entity.id))}
            >
              {String(entity.name)}
            </Pill>
          ))}
        </div>
      </div>

      {entities.length === 0 ? (
        <EmptyState
          icon="history"
          title="What did the house do?"
          description="Add an entity to see its readings or its states over time."
        />
      ) : !loaded || !domain ? (
        <Skeleton shape="block" width="100%" height={240} />
      ) : (
        <>
          {failures.map((failure) => (
            <Toast key={failure} tone="error" message={failure} />
          ))}
          {loaded.truncated.length ? (
            <Toast
              tone="neutral"
              message={`There is more than fits for ${loaded.truncated.join(", ")}; the newest part of the range is missing. Try a shorter range.`}
            />
          ) : null}
          {values.map((entity) => {
            const got = view(entity);
            if (!got || "error" in got) return null;
            const drawn = got.series?.some((s) => s.points.some(([, value]) => value !== null));
            return drawn && got.series ? (
              <TimeSeriesCard
                key={String(entity.id)}
                title={String(entity.name)}
                subtitle={String(entity.id)}
                series={got.series}
                unit={got.unit}
                xDomain={domain}
              />
            ) : (
              <EmptyState
                key={String(entity.id)}
                size="inline"
                icon="history"
                title={`Nothing recorded for ${entity.name} in this range`}
              />
            );
          })}
          {states.length ? (
            <StateHistoryCard
              title="States"
              xDomain={domain}
              summaryState={null}
              states={Object.assign(
                {},
                ...states.map((entity) => {
                  const got = view(entity);
                  return got && !("error" in got) ? got.states : undefined;
                }),
              )}
              rows={states.map((entity) => {
                const got = view(entity);
                return {
                  id: String(entity.id),
                  label: String(entity.name),
                  segments: got && !("error" in got) ? (got.segments ?? []) : [],
                };
              })}
            />
          ) : null}
          <section className="app-history-export">
            <h2 className="ca-text-heading">Download</h2>
            <p className="ca-text-caption app-muted">
              Every raw record in this range, as CSV, one file per entity.
            </p>
            <div className="app-history-chosen">
              {entities.map((entity) => (
                <a
                  key={String(entity.id)}
                  className="ca-btn ca-btn-secondary ca-btn-sm"
                  href={historyCsvUrl(String(entity.id), loaded.from, loaded.to)}
                  download={`${entity.id}.csv`}
                >
                  {String(entity.name)}
                </a>
              ))}
            </div>
          </section>
        </>
      )}
      {selected.length > entities.length && house.phase === "ready" ? (
        <p className="ca-text-caption app-muted">
          {selected.length - entities.length} of the entities in this address are not here any more.{" "}
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setSelected(entities.map((entity) => String(entity.id)))}
          >
            Forget them
          </Button>
        </p>
      ) : null}
    </div>
  );
}
