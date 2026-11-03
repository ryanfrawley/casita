// How each built-in draws: a thin wrapper over a `packages/ui` component, given the node's
// evaluated properties. A new built-in is an entry in the compiler's catalogue and one here.

import {
  formatNumber,
  inUnits,
  placeOn,
  present,
  type Row,
  SCALES,
  type ScaleName,
} from "@casita/client";
import {
  type CChild,
  type CNode,
  type CRepeat,
  type EntityValue,
  GRID_COLUMNS_MAX,
  isArea,
  isAttribute,
  isDevice,
  isEntity,
  type Value,
} from "@casita/core/casa";
import {
  Area,
  AreaColumns,
  Badge,
  Button,
  ButtonGroup,
  cx,
  EntityCard,
  EntityRow,
  Forecast,
  gridHeight,
  Icon,
  MapView,
  ScaleBar,
  SegmentedControl,
  SunPath,
  Timestamp,
  WeatherEffect,
  WidgetBlockView,
  WidgetCard,
  weatherHost,
} from "@casita/ui";
import {
  type CSSProperties,
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useHouse, useStore, useThemes } from "../context.tsx";
import { ClimateCard, EntityControls, EntityDimmer, EntityLine, hasDimmer } from "../controls.tsx";
import type { Thing } from "../detail.tsx";
import { HistoryBlock } from "../history-block.tsx";
import {
  attributeText,
  type EntityView,
  entityView,
  facts,
  forecastView,
  greeting,
  type Intent,
  intents,
  segmentOf,
  sunPathView,
} from "../model.ts";
import { useThemeChoice } from "../shell.tsx";
import type { House } from "../store.ts";
import { isDark } from "../theme.ts";
import { HeaderView, useCasa, useExpr, useRepeatItems, type Vars } from "./render.tsx";

export interface BuiltinProps {
  node: CNode;
  props: Record<string, Value>;
  on: Record<string, (...args: Value[]) => Promise<void>>;
  /** The scope the node's properties were evaluated in, for a view that reads its children. */
  vars: Vars;
  children?: ReactNode;
}

type View = (props: BuiltinProps) => ReactNode;

// ───────── helpers ─────────

const str = (v: Value | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: Value | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: Value | undefined, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

/** A theme path as the CSS custom property the theme's rule defines. */
export const themeVar = (path: string | undefined, fallback?: string): string | undefined =>
  path ? `var(--${path.replace(/\./g, "-")})` : fallback;

/** A length given as a theme path (`space.md`) or a number of px. */
const lengthOf = (v: Value | undefined, fallback?: string): string | undefined =>
  typeof v === "number" ? `${v}px` : themeVar(str(v), fallback);

/** The design system's four accents, when the colour is one of them. */
const ACCENTS = ["lamp", "sky", "sage", "ember"] as const;
type Accent = (typeof ACCENTS)[number];
const accentOf = (path: string | undefined): Accent | undefined => {
  const name = path?.replace(/^(accents|palette)\./, "");
  return ACCENTS.find((accent) => accent === name);
};

/** The entity a reading is of: its id, and the attribute when it is one. */
const readingOf = (v: Value | undefined): { id: string; attr?: string } | undefined =>
  isEntity(v) ? { id: v.id } : isAttribute(v) ? { id: v.id, attr: v.name } : undefined;

/** The entity's row view, recomputed only when its own record, pending state or entity changes. */
function useEntityView(id: string | undefined): EntityView | undefined {
  const store = useStore();
  const { casa } = useCasa();
  const last = useRef<{
    record: unknown;
    pending: unknown;
    entity: unknown;
    units: unknown;
    view?: EntityView;
  }>();
  return useSyncExternalStore(store.subscribe, () => {
    if (!id) return undefined;
    const house = store.getState();
    const entity = house.entities.find((candidate) => candidate.id === id);
    const record = casa.host().state(id);
    const pending = house.pending.get(id);
    const cur = last.current;
    if (
      cur &&
      cur.record === record &&
      cur.pending === pending &&
      cur.entity === entity &&
      cur.units === house.units
    ) {
      return cur.view;
    }
    const view = entity
      ? entityView({ ...house, states: new Map([[id, record as unknown as Row]]) } as House, entity)
      : undefined;
    last.current = { record, pending, entity, units: house.units, view };
    return view;
  });
}

/** Each entity's row view, as `useEntityView`; the same list until one of them changes. */
function useEntityViews(ids: readonly string[]): (EntityView | undefined)[] {
  const store = useStore();
  const { casa } = useCasa();
  const last = useRef<{ key: string; parts: unknown[]; views: (EntityView | undefined)[] }>();
  return useSyncExternalStore(store.subscribe, () => {
    const house = store.getState();
    const parts = ids.flatMap((id) => [
      house.entities.find((candidate) => candidate.id === id),
      casa.host().state(id),
      house.pending.get(id),
    ]);
    parts.push(house.units);
    const key = ids.join("\n");
    const cur = last.current;
    if (cur && cur.key === key && cur.parts.every((part, i) => part === parts[i])) return cur.views;
    const views = ids.map((id, i) => {
      const entity = parts[i * 3] as Row | undefined;
      const record = parts[i * 3 + 1];
      return entity
        ? entityView({ ...house, states: new Map([[id, record as Row]]) } as House, entity)
        : undefined;
    });
    last.current = { key, parts, views };
    return views;
  });
}

/** A reading's words and numbers, as a card block wants them. */
function useReading(of: Value | undefined, label: Value | undefined) {
  const reading = readingOf(of);
  const view = useEntityView(reading?.id);
  const name = str(label) ?? reading?.attr ?? view?.name ?? reading?.id ?? "";
  if (!reading || !view) return { name, text: "—", available: false, view, reading };
  if (reading.attr) {
    const fields = {
      ...((view.record?.state ?? {}) as Row),
      ...((view.record?.attributes ?? {}) as Row),
    };
    const value = fields[reading.attr];
    return {
      name,
      text: view.available ? attributeText(value) : "Unavailable",
      available: view.available,
      value,
      view,
      reading,
    };
  }
  return { name, text: view.summary, available: view.available, view, reading };
}

/**
 * The theme path of the ink that reads on an accent: `accents.onSky` for `accents.sky`.
 * A colour from elsewhere (`palette.warn`) has no on-colour of its own; the text role's
 * `text.onAccent` stands in, as it does for the components' default accent.
 */
export const onAccentOf = (path: string): string => {
  const match = /^accents\.([a-z])(\w*)$/.exec(path);
  return match ? `accents.on${(match[1] as string).toUpperCase()}${match[2]}` : "text.onAccent";
};

/** A Casa card's accent on its wrapper, for the ui components under it. */
const accentStyle = (path: string | undefined): CSSProperties | undefined =>
  path && !accentOf(path) ? ({ "--casa-accent": themeVar(path) } as CSSProperties) : undefined;

// ───────── layout ─────────

const JUSTIFY: Record<string, string> = {
  Start: "flex-start",
  Center: "center",
  End: "flex-end",
  Between: "space-between",
};

const Stack: View = ({ props, children }) => {
  const row = props.direction === "Row";
  const align = str(props.align)?.toLowerCase();
  return (
    <div
      className={`app-casa-stack${row ? " app-casa-stack-row" : ""}${row && bool(props.wrap, false) ? " app-casa-stack-wrap" : ""}`}
      style={{
        gap: lengthOf(props.gap, "var(--casa-stack-gap)"),
        alignItems: align === "start" ? "flex-start" : align === "end" ? "flex-end" : align,
        justifyContent: JUSTIFY[str(props.justify) ?? "Start"],
      }}
    >
      {children}
    </div>
  );
};

export const GridContext = createContext<number | null>(null);

/** The columns a Grid draws: `columns` clamped to 1..3, or one per child up to 3. */
export const gridColumnsOf = (node: CNode, columns: Value | undefined): number => {
  const asked =
    typeof columns === "number" && Number.isFinite(columns)
      ? Math.round(columns)
      : node.children.length;
  return Math.max(1, Math.min(GRID_COLUMNS_MAX, asked));
};

const Grid: View = ({ node, props, children }) => {
  const columns = gridColumnsOf(node, props.columns);
  return (
    <GridContext.Provider value={columns}>
      <div
        className="app-casa-grid"
        // The count and the gap are on the element too: a one-column grid of rows in a card
        // draws a divider between them, halfway up the gap. With no `gap` given, the rows are
        // a grid step apart and the columns further, `space.xl`, so side-by-side blocks do
        // not run together.
        data-columns={columns}
        style={
          {
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            "--casa-grid-gap": lengthOf(props.gap, "var(--casa-grid-row-gap)"),
            "--casa-grid-col-gap": props.gap == null ? "var(--space-xl)" : "var(--casa-grid-gap)",
            gap: "var(--casa-grid-gap)",
            columnGap: "var(--casa-grid-col-gap)",
            alignItems: props.rowHeight === "Auto" ? "start" : "stretch",
          } as CSSProperties
        }
      >
        {children}
      </div>
    </GridContext.Provider>
  );
};

const SIZE: Record<string, "sm" | "md" | "lg"> = { Sm: "sm", Md: "md", Lg: "lg" };

/**
 * The one `Row` a card holds, when that is all it holds: written as the row itself, or as a
 * `for` whose body is the row. A `when` on the row means it may not be there, so it is not one.
 */
function loneRowOf(node: CNode): { row: CNode; repeat?: CRepeat } | undefined {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  const isRow = (child: CChild | undefined): child is CNode =>
    child?.t === "node" && child.type === "Row" && !("when" in child.props);
  if (isRow(only)) return { row: only };
  if (only?.t === "for" && only.children.length === 1 && isRow(only.children[0])) {
    // Through a loop, only `Row { of: e }` of the loop's own `e` counts: the item is the entity.
    const of = only.children[0].props.of;
    if (of && "e" in of && of.e[0] === "var" && of.e[1] === only.var)
      return { row: only.children[0], repeat: only };
  }
  return undefined;
}

/**
 * The entity a lone row is of, followed live: the row's `of` evaluated in the card's scope,
 * or, through a `for`, the loop's single item. `undefined` when the loop has several, so the
 * card is drawn as a card after all; `null` when the row is of nothing, or the loop is empty.
 */
function useLoneEntity(
  lone: { row: CNode; repeat?: CRepeat } | undefined,
  vars: Vars,
): string | null | undefined {
  const of = lone?.row.props.of;
  const direct = useExpr(lone && !lone.repeat && of && "e" in of ? of.e : undefined, vars);
  const items = useRepeatItems(lone?.repeat, vars);
  if (!lone) return undefined;
  if (!lone.repeat) return isEntity(direct) ? direct.id : null;
  if (!items || items.length > 1) return undefined;
  const item = items[0];
  return isEntity(item) ? item.id : null;
}

/** What a card is `of`, as a thing a sheet can show; nothing for anything else. */
const thingOf = (v: Value | undefined): Thing | undefined =>
  isEntity(v)
    ? { kind: "entity", id: v.id }
    : isDevice(v)
      ? { kind: "device", id: v.id }
      : isArea(v)
        ? { kind: "area", id: v.id }
        : undefined;

const Card: View = ({ node, props, on, vars, children }) => {
  const { onLocate, onOpenThing } = useCasa();
  const accentPath = str(props.accent);
  const accent = accentOf(accentPath) ?? "lamp";
  const name = str(props.name) ?? "";
  const press = on.onPress;
  // The card's heading opens what the card is of.
  const of = thingOf(props.of);
  const open = of ? () => onOpenThing(of) : undefined;
  // A card that is one row is drawn as that row, as Home has always drawn a lone switch.
  const lone = loneRowOf(node);
  const loneId = useLoneEntity(lone, vars);
  const body = (
    <>
      {lone && loneId !== undefined ? (
        <LoneRow
          card={{ name, icon: str(props.icon), accent, active: bool(props.active, false) }}
          id={loneId ?? undefined}
          onOpen={open}
        />
      ) : (
        <WidgetCard
          name={name}
          icon={str(props.icon)}
          accent={accent}
          size={SIZE[str(props.size) ?? "Md"]}
          active={bool(props.active, false)}
          header={props.header !== false}
          heading={
            props.header === false ? undefined : (
              <Pressable open={open} label={`${name} details`}>
                <HeaderView
                  name={str(props.header) ?? "CardHeader"}
                  args={{
                    name,
                    subtitle: str(props.subtitle) ?? null,
                    icon: str(props.icon) ?? "plug",
                    active: bool(props.active, false),
                    accent: accentPath ?? "accents.lamp",
                    onAccent: onAccentOf(accentPath ?? "accents.lamp"),
                  }}
                />
              </Pressable>
            )
          }
          // A card written with no body is its heading alone; one whose body came out empty says so.
          emptyText={node.children.length ? "Nothing on this card." : null}
          className={`app-casa-card${bool(props.dividers, true) ? "" : " ca-widget-undivided"}`}
        >
          {children}
        </WidgetCard>
      )}
    </>
  );
  const style = accentStyle(accentPath);
  const locate = onLocate
    ? (event: MouseEvent) => {
        if (!event.altKey) return;
        event.stopPropagation();
        onLocate(node.at);
      }
    : undefined;
  if (!press && !style && !locate) return body;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the card's controls are keyboard-reachable themselves
    // biome-ignore lint/a11y/noStaticElementInteractions: a press on the card's face is a convenience, not its only control
    <div
      className={press ? "app-casa-press" : undefined}
      style={style}
      onClick={(event) => {
        locate?.(event);
        if (press && !event.altKey) press();
      }}
    >
      {body}
    </div>
  );
};

/** A card's heading as a button to what the card is of; the heading itself when it is of nothing. */
function Pressable({
  open,
  label,
  children,
}: {
  open?: () => void;
  label: string;
  children: ReactNode;
}) {
  // Either way the heading takes the head's width, so a `justify: .Between` in it has room.
  if (!open) return <div className="app-casa-heading">{children}</div>;
  return (
    <button type="button" className="ca-widget-open" aria-label={label} onClick={open}>
      {children}
    </button>
  );
}

/**
 * The lone row's card: the entity's state as the line and its control at the edge. Its
 * heading opens what the card is of, else the entity.
 */
function LoneRow({
  card,
  id,
  onOpen: openOf,
}: {
  card: { name: string; icon?: string; accent: Accent; active: boolean };
  id?: string;
  onOpen?: () => void;
}) {
  const { onOpen } = useCasa();
  const view = useEntityView(id);
  if (!id || !view)
    return (
      <WidgetCard
        name={card.name}
        icon={card.icon}
        accent={card.accent}
        emptyText="Nothing on this card."
        className="app-casa-card"
      />
    );
  return (
    <EntityCard
      name={card.name || view.name}
      icon={card.icon ?? view.icon ?? view.domain}
      accent={card.accent}
      active={card.active}
      summary={view.summary}
      status={view.available ? undefined : "unavailable"}
      className="app-casa-card"
      actions={<EntityControls view={view} />}
      onOpen={openOf ?? (() => onOpen(view.id))}
    >
      {/* The body, with its gutter and line, only when there is a dimmer to put in it. */}
      {hasDimmer(view) ? <EntityDimmer view={view} className="app-ecard-dimmer" /> : null}
    </EntityCard>
  );
}

const AreaView: View = ({ props, children }) => {
  const house = useHouse();
  const store = useStore();
  const areaValue = isArea(props.of) ? props.of : undefined;
  const area = areaValue ? house.areas.find((a) => a.id === areaValue.id) : undefined;
  const areaId = area ? String(area.id) : undefined;
  const [busy, setBusy] = useState(false);
  const views = useMemo(() => {
    const inArea = house.entities.filter(
      (e) =>
        !e.hidden && !e.disabled && (areaId ? e.effectiveAreaId === areaId : !e.effectiveAreaId),
    );
    return inArea.map((e) => entityView(house, e));
  }, [house, areaId]);
  const lightsOn = views.filter((v) => v.domain === "light" && v.state === "on").length;
  const lightsOff = async () => {
    if (!areaId) return;
    setBusy(true);
    try {
      await store.request("send_area_command", {
        areaId,
        command: { domain: "light", action: "turn_off" },
        confirm: true,
      });
    } finally {
      setBusy(false);
    }
  };
  // With an area, the heading is its own name and icon unless told otherwise; without one, it
  // is drawn only when asked for: a name, an icon, or a header to draw it. `header: false`
  // hides it either way.
  const name = str(props.name) || (area ? String(area.name) : undefined) || undefined;
  const icon =
    str(props.icon) ||
    (area ? (typeof area.icon === "string" && area.icon) || "house" : undefined) ||
    undefined;
  const header = str(props.header);
  const headed = props.header !== false && Boolean(area || name || icon || header);
  return (
    <Area
      name={name ?? ""}
      areaId={areaId}
      // The heading is the name alone: no icon, nothing counted under it.
      icon={null}
      active={views.some((v) => v.state === "on")}
      bare={!headed}
      facts={bool(props.facts, true) ? facts(views) : []}
      // A frame for what is in no area has no area to hand a heading; it keeps the plain one.
      header={
        areaValue && headed ? (
          <HeaderView
            name={header ?? "AreaHeader"}
            args={{ of: areaValue, name: name ?? null, icon: icon ?? null }}
          />
        ) : undefined
      }
      actions={
        areaId && lightsOn > 0 ? (
          <Button size="sm" disabled={busy} onClick={lightsOff}>
            {busy ? "Turning off…" : "Turn off lights"}
          </Button>
        ) : undefined
      }
      className="app-casa-area"
    >
      <AreaCells>{children}</AreaCells>
    </Area>
  );
};

/**
 * An Area's cards sit in the ui Area's grid, which fills as many columns as fit; the count the
 * browser settled on is the grid context, so a card's `span` means there what it means in a
 * Grid, and one wider than the area takes the whole row.
 */
function AreaCells({ children }: { children: ReactNode }) {
  const columns = useContext(AreaColumns);
  return <GridContext.Provider value={columns}>{children}</GridContext.Provider>;
}

const Section: View = ({ props, children }) => {
  const title = str(props.title);
  const heading = title ? (
    <HeaderView name={str(props.header) ?? "SectionHeader"} args={{ title }} />
  ) : null;
  if (bool(props.collapsible, false)) {
    return (
      <details className="app-casa-section" open>
        <summary className="app-casa-section-title">{heading}</summary>
        <div className="app-casa-section-body">{children}</div>
      </details>
    );
  }
  return (
    <section className="app-casa-section">
      {heading ? <h2 className="app-casa-section-title">{heading}</h2> : null}
      <div className="app-casa-section-body">{children}</div>
    </section>
  );
};

const Spacer: View = ({ props }) => (
  <div style={{ height: themeVar(str(props.size), "var(--grid-step)") }} />
);

// ───────── text ─────────

const TEXT_CLASS: Record<string, string> = {
  Body: "ca-text-body",
  Muted: "ca-text-body app-muted",
  Label: "ca-text-label",
  Display: "ca-text-display",
};

/** A line of text, given a size in px, keeps a lead a little over a third of it. */
const LINE_HEIGHT = 1.35;

const Text: View = ({ props }) => {
  // A size or weight is a number, or a theme path (`room.name.size`) known only in CSS.
  const size = lengthOf(props.size);
  const weight = typeof props.weight === "number" ? props.weight : themeVar(str(props.weight));
  // The colour goes through `--casa-text`, so a stylesheet may light the text (a card's
  // heading on hover, as `--casa-text-lit`) over what the page said.
  const color = themeVar(str(props.color));
  return (
    <span
      className={TEXT_CLASS[str(props.style) ?? "Body"]}
      style={{
        ...(color ? ({ "--casa-text": color } as CSSProperties) : undefined),
        color: color ? "var(--casa-text-lit, var(--casa-text))" : "var(--casa-text-lit)",
        fontSize: size,
        lineHeight: size === undefined ? undefined : LINE_HEIGHT,
        fontWeight: weight,
        fontFamily: themeVar(str(props.font)),
      }}
    >
      {str(props.value) ?? ""}
    </span>
  );
};

const ICON_SIZE: Record<string, number> = { Sm: 16, Md: 22, Lg: 32 };

/**
 * An icon, in a box when the page gives it a shape. The shape is a theme path whose group
 * also says whether the box is drawn at all (`--room-icon-box: none`) and how much taller
 * than wide it stands (`--room-icon-lift`).
 */
const IconView: View = ({ props }) => {
  // A size is `.Sm` `.Md` `.Lg`, a number of px, or a theme path such as `room.icon.size`;
  // the last is only known in CSS, so the svg takes it from a custom property.
  const named = typeof props.size === "string" ? ICON_SIZE[props.size] : undefined;
  const sizePx = typeof props.size === "number" ? props.size : named;
  const sizeCss = sizePx !== undefined ? `${sizePx}px` : lengthOf(props.size, "22px");
  const shape = str(props.shape);
  const icon = <Icon name={str(props.name) ?? "circle-dot"} size={sizePx ?? 22} />;
  const sized = { "--casa-icon-size": sizeCss } as CSSProperties;
  if (!shape) {
    return (
      <span
        className="app-casa-icon"
        style={{ ...sized, color: themeVar(str(props.color)), display: "inline-flex" }}
      >
        {icon}
      </span>
    );
  }
  const group = shape.replace(/\.shape$/, "").replace(/\./g, "-");
  // `--room-icon-box: none` is set only when the shape is `none`; otherwise the value stands.
  const unlessNoBox = (value: string) => `var(--${group}-box, ${value})`;
  const lift = `var(--${group}-lift, 0px)`;
  const padding = lengthOf(props.padding, "0px");
  const side = `calc(${sizeCss} + 2 * ${padding})`;
  return (
    <span
      className="app-casa-icon app-casa-icon-box"
      style={{
        ...sized,
        width: side,
        height: `calc(${side} + ${lift})`,
        paddingTop: lift,
        borderRadius: themeVar(shape),
        border: unlessNoBox(themeVar(str(props.border), "none") as string),
        background: unlessNoBox(themeVar(str(props.background), "transparent") as string),
        color: themeVar(str(props.color)),
      }}
    >
      {icon}
    </span>
  );
};

// ───────── readings ─────────

const RowView: View = ({ props, on }) => {
  const { onOpen } = useCasa();
  const reading = useReading(props.of, props.label);
  if (!reading.view) return null;
  if (reading.reading?.attr) {
    return (
      <EntityRow
        name={reading.name}
        entityId={reading.reading.id}
        domain={reading.view.domain as "light"}
        icon={reading.view.icon}
        state={reading.available ? "off" : "unavailable"}
        value={reading.text}
      />
    );
  }
  const view = str(props.label) ? { ...reading.view, name: reading.name } : reading.view;
  if (on.onPress) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the row's controls are keyboard-reachable
      // biome-ignore lint/a11y/noStaticElementInteractions: a press on the row is a convenience, not its only control
      <div className="app-casa-press" onClick={() => on.onPress?.()}>
        <EntityLine view={view} />
      </div>
    );
  }
  return <EntityLine view={view} onOpen={onOpen} />;
};

/** The big number of a sensor, in the house's units. */
function headlineOf(
  view: EntityView | undefined,
  attr?: string,
): { value: string; unit?: string } | undefined {
  const state = (view?.record?.state ?? {}) as Row;
  if (!view?.available) return undefined;
  if (attr) {
    const value = { ...state, ...((view.record?.attributes ?? {}) as Row) }[attr];
    return typeof value === "number"
      ? { value: formatNumber(value) }
      : { value: attributeText(value) };
  }
  if (view.domain === "sensor" && typeof state.value === "number") {
    const shown = inUnits(state.value, typeof state.unit === "string" ? state.unit : "");
    return { value: formatNumber(shown.value), unit: shown.unit || undefined };
  }
  return { value: present(view.record, Date.now()).text };
}

const Headline: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  const number = headlineOf(reading.view, reading.reading?.attr);
  return (
    <WidgetBlockView
      block={{
        kind: "headline",
        key: "h",
        value: number?.value ?? "—",
        unit: bool(props.unit, true) ? number?.unit : undefined,
        caption: number ? reading.name : `${reading.name} · ${reading.text}`,
      }}
    />
  );
};

const ValueView: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  const text = str(props.text) ?? reading.text;
  return (
    <WidgetBlockView
      block={{
        kind: "stats",
        key: "v",
        stats: [{ key: "v", label: reading.name, value: text }],
      }}
    />
  );
};

/** 0 to 100 for a bar: a percent sensor, a dimmer, a cover, or the value against `max`. */
function percentOf(
  view: EntityView | undefined,
  attr: string | undefined,
  max: number | undefined,
): number | undefined {
  if (!view?.available) return undefined;
  const state = (view.record?.state ?? {}) as Row;
  const raw = attr
    ? { ...state, ...((view.record?.attributes ?? {}) as Row) }[attr]
    : view.domain === "sensor"
      ? state.value
      : view.domain === "light"
        ? view.state === "on"
          ? (view.brightness ?? 0) * 100
          : 0
        : view.domain === "cover" && typeof state.position === "number"
          ? state.position * 100
          : undefined;
  if (typeof raw !== "number") return undefined;
  const percent = max ? (raw / max) * 100 : raw;
  return Math.max(0, Math.min(100, percent));
}

const BAR_TONE: Record<string, "lamp" | "sky" | "sage" | "ember" | "neutral"> = {
  "accents.lamp": "lamp",
  "accents.sky": "sky",
  "accents.sage": "sage",
  "accents.ember": "ember",
  "palette.lamp": "lamp",
  "palette.sky": "sky",
  "palette.sage": "sage",
  "palette.ember": "ember",
  "text.muted": "neutral",
};

const Bar: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  const max = num(props.max);
  const percent = percentOf(reading.view, reading.reading?.attr, max);
  const low = num(props.low);
  const target = num(props.target);
  const colour = str(props.color) ?? str(props.tone);
  const tone = colour ? (BAR_TONE[colour] ?? "accent") : "accent";
  const style = colour && tone === "accent" ? accentStyle(colour) : undefined;
  const block = (
    <WidgetBlockView
      block={{
        kind: "bar",
        key: "b",
        label: reading.name,
        value: reading.text,
        percent: percent ?? 0,
        tone,
        marker:
          target !== undefined
            ? {
                percent: max ? (target / max) * 100 : target,
                text: `target ${formatNumber(target)}`,
              }
            : undefined,
        low: low !== undefined && percent !== undefined && percent <= low,
      }}
    />
  );
  return style ? <div style={style}>{block}</div> : block;
};

const Status: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  return (
    <div className="ca-widget-status app-casa-status">
      {reading.name} · {reading.text}
    </div>
  );
};

const RANGE: Record<string, "hour" | "day" | "week"> = { Hour: "hour", Day: "day", Week: "week" };

const History: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  const id = reading.reading?.id;
  if (!id || !reading.view) return null;
  return (
    <WidgetBlockView
      block={{
        kind: "figure",
        key: "f",
        label: reading.name,
        children: (
          <HistoryBlock
            entityId={id}
            domain={reading.view.domain}
            label={reading.name}
            range={RANGE[str(props.range) ?? "Day"] ?? "day"}
            durationMs={num(props.duration)}
          />
        ),
      }}
    />
  );
};

/** An entity's position, when its attributes carry one: a car's location, a phone's. */
const positionOf = (
  view: EntityView | undefined,
): { latitude: number; longitude: number; heading?: number } | undefined => {
  const attributes = (view?.available ? (view.record?.attributes ?? {}) : {}) as Row;
  const { latitude, longitude, heading } = attributes;
  if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
  return { latitude, longitude, heading: typeof heading === "number" ? heading : undefined };
};

const MapNode: View = ({ props }) => {
  const of = isEntity(props.of) ? props.of.id : undefined;
  const view = useEntityView(of);
  const { theme } = useThemeChoice();
  const themes = useThemes();
  // The entity's place first; the page's own while it has none.
  const place = positionOf(view) ?? {
    latitude: num(props.latitude),
    longitude: num(props.longitude),
    heading: undefined,
  };
  // A block of its own: in a card's body the divider and spacing go on it, outside the map's
  // rounded frame, not across the map's edge.
  return (
    <div className="app-casa-map">
      <MapView
        latitude={place.latitude}
        longitude={place.longitude}
        heading={place.heading}
        zoom={num(props.zoom)}
        // Whole grid units, whatever height the page asks for, so the card stays on the grid.
        height={gridHeight(num(props.height) ?? 200)}
        marker={bool(props.marker, true)}
        label={str(props.label) ?? view?.name ?? "Map"}
        dark={isDark(theme, themes)}
      />
    </div>
  );
};

/** The scales by the names a page gives them. */
const SCALE_NAMES: Record<string, ScaleName> = {
  UV: "uv",
  PM25: "pm25",
  PM10: "pm10",
  AQI: "aqi",
  EAQI: "eaqi",
};

const ScaleNode: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  const scale = SCALES[SCALE_NAMES[str(props.scale) ?? ""] ?? "uv"];
  const raw = reading.reading?.attr
    ? reading.value
    : (reading.view?.record?.state as Row | undefined)?.value;
  const value =
    reading.available && typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  return (
    <ScaleBar
      label={str(props.label) ?? scale.title}
      value={value === undefined ? "—" : reading.text}
      bands={scale.bands}
      placed={value === undefined ? undefined : placeOn(scale, value)}
    />
  );
};

/** The minute, as the page's clock ticks it: what a view of the time of day redraws on. */
function useMinute(): number {
  const { casa } = useCasa();
  return useSyncExternalStore(casa.subscribe, () => Math.floor(Date.now() / 60_000)) * 60_000;
}

const SunPathNode: View = ({ props }) => {
  const id = isEntity(props.weather) ? props.weather.id : undefined;
  const view = useEntityView(id);
  const now = useMinute();
  const sun = sunPathView(view?.record as Row | undefined, now);
  if (!sun) return null;
  return (
    <SunPath
      label={str(props.label) ?? `${sun.headline}. Sunrise ${sun.rise}, sunset ${sun.set}.`}
      rise={sun.rise}
      set={sun.set}
      dayStart={sun.dayStart}
      dayEnd={sun.dayEnd}
      riseAt={sun.riseAt}
      setAt={sun.setAt}
      now={sun.now}
      latitude={sun.latitude}
      longitude={sun.longitude}
      timeZone={sun.timeZone}
      headline={sun.headline}
      detail={sun.detail}
    />
  );
};

// ───────── controls ─────────

const Control: View = ({ props }) => {
  const { onOpen } = useCasa();
  const reading = useReading(props.of, props.label);
  if (!reading.view) return null;
  const view = str(props.label) ? { ...reading.view, name: reading.name } : reading.view;
  return <EntityLine view={view} onOpen={onOpen} />;
};

const Thermostat: View = ({ props }) => {
  const reading = useReading(props.of, props.label);
  if (!reading.view) return null;
  // Given something that is not a thermostat (a loop variable can be anything), it is a row.
  if (reading.view.domain !== "climate") return <EntityLine view={reading.view} />;
  return <ClimateCard view={reading.view} />;
};

const ButtonView: View = ({ props, on }) => {
  const store = useStore();
  const { onFailure } = useCasa();
  const of = isEntity(props.of) ? (props.of as EntityValue) : undefined;
  // Busy from the press until its handler and its entity's command have been answered, as
  // a toggle is pending until the device reports: nothing is shown ahead of the house.
  const [busy, setBusy] = useState(false);
  const press = async () => {
    setBusy(true);
    try {
      await on.onPress?.();
      if (!of) return;
      const intent = intents.press();
      const outcome = await store.command(of.id, intent.command, intent.waiting);
      if (!outcome.ok) onFailure(outcome.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-casa-control">
      <Button size="sm" icon={str(props.icon)} busy={busy} onClick={() => void press()}>
        {str(props.label) ?? ""}
      </Button>
    </div>
  );
};

const ButtonGroupView: View = ({ props }) => {
  const store = useStore();
  const { onFailure } = useCasa();
  const entities = (Array.isArray(props.of) ? props.of : []).filter(isEntity) as EntityValue[];
  const labels = Array.isArray(props.labels) ? props.labels : [];
  const views = useEntityViews(entities.map((entity) => entity.id));
  // The device's report ends a segment's wait, as a toggle's; only the press is local.
  const send = async (id: string, intent: Intent) => {
    const outcome = await store.command(id, intent.command, intent.waiting);
    if (!outcome.ok) onFailure(outcome.message);
  };
  return (
    <div className="app-casa-control">
      <ButtonGroup
        label={str(props.label) ?? "Buttons"}
        items={entities.map((entity, i) => {
          const view = views[i];
          const segment = view ? segmentOf(view) : undefined;
          const intent = segment?.intent;
          return {
            key: `${entity.id}-${i}`,
            label: str(labels[i]) ?? view?.name ?? entity.id,
            active: segment?.active,
            pending: segment?.pending,
            disabled: segment?.disabled ?? true,
            confirm: segment?.confirm,
            onPress: () => {
              if (intent) void send(entity.id, intent);
            },
          };
        })}
      />
    </div>
  );
};

const Segmented: View = ({ props, on }) => {
  const options = Array.isArray(props.options) ? props.options : [];
  const labels = Array.isArray(props.labels) ? props.labels : [];
  const choices = options.map((option, i) => ({
    value: String(option),
    label: str(labels[i]) ?? String(option),
  }));
  return (
    <div className="app-casa-control">
      <SegmentedControl
        label="Choose"
        options={choices}
        value={props.value === null || props.value === undefined ? undefined : String(props.value)}
        onChange={(value) => {
          const chosen = options.find((option) => String(option) === value) ?? value;
          on.onChange?.(chosen as Value);
        }}
      />
    </div>
  );
};

// ───────── page sections ─────────

const Greeting: View = ({ props }) => {
  const house = useHouse();
  const { casa } = useCasa();
  const now = casa.host().now();
  const weather = forecastView(house, now);
  const name = String(house.me?.displayName || house.me?.username || "");
  const shown = props.weather === undefined || props.weather === null || isEntity(props.weather);
  return (
    <header
      className={cx(
        "app-page-head app-casa-greeting",
        shown && weather?.current && weatherHost(weather.current.condition),
      )}
    >
      {shown && weather?.current ? <WeatherEffect condition={weather.current.condition} /> : null}
      <div className="app-greeting">
        <h1 className="ca-text-display ca-wx-far">
          {greeting(now)}
          {name ? `, ${name}` : ""}
        </h1>
        {shown && weather?.rain ? (
          <div>
            <Badge tone="neutral" icon="umbrella" className="ca-wx-near">
              {weather.rain}
            </Badge>
          </div>
        ) : null}
      </div>
      {shown && weather?.outside ? (
        <section className="app-outside" aria-label="Weather outside">
          <div className="app-outside-now">
            <Icon name={weather.outside.icon} size={32} />
            <div>
              <span className="app-outside-temp ca-wx-far">{weather.outside.temperature}</span>
              <small>{weather.outside.unit}</small>
            </div>
          </div>
          <span className="app-outside-line ca-wx-near">{weather.outside.line}</span>
        </section>
      ) : null}
    </header>
  );
};

const ForecastView: View = ({ props }) => {
  const house = useHouse();
  const { casa } = useCasa();
  const weather = forecastView(house, casa.host().now());
  if (!weather?.days.length) return null;
  const days = num(props.days);
  return (
    <div className="app-weather">
      <Forecast
        title={weather.title}
        unit={weather.unit}
        days={days ? weather.days.slice(0, days) : weather.days}
      />
    </div>
  );
};

const Recent: View = ({ props }) => {
  const house = useHouse();
  const limit = num(props.limit) ?? 10;
  if (!house.recent.length) return null;
  return (
    <section className="app-recent">
      <h2 className="ca-text-heading">Recent</h2>
      <ul>
        {house.recent.slice(0, limit).map((item) => (
          <li key={`${item.entityId}-${item.at}`}>
            <span>
              <strong>{item.name}</strong> {item.text}
            </span>
            <Timestamp value={item.at} className="app-muted" />
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Retired: the search is in the app's header now. */
const Search: View = () => null;

export const BUILTIN_VIEWS: Record<string, View> = {
  Stack,
  Grid,
  Card,
  Area: AreaView,
  Section,
  Spacer,
  Text,
  Icon: IconView,
  Row: RowView,
  Headline,
  Value: ValueView,
  Bar,
  Status,
  History,
  Timeline: History,
  Map: MapNode,
  Scale: ScaleNode,
  SunPath: SunPathNode,
  Toggle: Control,
  Dimmer: Control,
  Thermostat,
  CoverControl: Control,
  LockControl: Control,
  Button: ButtonView,
  ButtonGroup: ButtonGroupView,
  Segmented,
  Greeting,
  Forecast: ForecastView,
  Recent,
  Search,
};
