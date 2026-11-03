// casa/builtins.ts
// The built-in nodes: each a thin wrapper over a `packages/ui` component. A new built-in is
// an entry here and a renderer in the web app, not a change to the language.

import type { Domain } from "../types.ts";
import {
  AREA,
  ATTRIBUTE,
  BOOL,
  COLOR,
  component,
  DEVICE,
  DURATION,
  ENTITY,
  entityOf,
  enumOf,
  event,
  list,
  NUMBER,
  STRING,
  type Type,
  token,
  typeVar,
  union,
} from "./types.ts";

export interface PropSpec {
  type: Type;
  required?: boolean;
  /** The emitted value the renderer uses when the page gives none (a theme path, a number…). */
  default?: unknown;
  /** The property is an icon name, checked against the gallery's list. */
  icon?: boolean;
}

export interface Builtin {
  name: string;
  props: Record<string, PropSpec>;
  /** Whether child nodes may be placed inside. */
  children: boolean;
  /** Domains `of` may be from; unset means any. */
  ofDomains?: readonly Domain[];
  /** Still accepted, but no longer drawn: the warning says what took its place. */
  retired?: string;
}

/** The most columns a Grid has. */
export const GRID_COLUMNS_MAX = 3;

/** The deepest zoom a Map has: OpenStreetMap's tiles go no further. */
export const MAP_ZOOM_MAX = 19;

/** On every node. */
export const COMMON_PROPS: Record<string, PropSpec> = {
  when: { type: BOOL, default: true },
  key: { type: STRING },
  span: { type: NUMBER, default: 1 },
  /** Inside a Grid, how the node sits in its cell; left out, it fills the cell's width. */
  align: { type: enumOf("Start", "Center", "End") },
  /** Inside a Grid, where the node sits on its cell's height; left out, it fills it. */
  valign: { type: enumOf("Top", "Center", "Bottom") },
};

const READING = union(ENTITY, ATTRIBUTE);
const RANGE = enumOf("Hour", "Day", "Week");
const SIZE = enumOf("Sm", "Md", "Lg");
const T = typeVar("T");

/**
 * The header slots. Each names the component a heading is drawn by and what it is given:
 * the area and the name and icon written on it, the card's own name and icon (a Card stands
 * for nothing else), the section's title. The defaults are the bundled components of these
 * names (`headers.ts`).
 */
export const HEADER_SLOTS = {
  Area: { name: "AreaHeader", params: { of: AREA, name: STRING, icon: STRING } },
  Card: {
    name: "CardHeader",
    /** `onAccent` is the ink that reads on `accent`: `accents.onSky` for `accents.sky`. */
    params: {
      name: STRING,
      subtitle: STRING,
      icon: STRING,
      active: BOOL,
      accent: COLOR,
      onAccent: COLOR,
    },
  },
  Section: { name: "SectionHeader", params: { title: STRING } },
} as const;

const reading = (extra: Record<string, PropSpec> = {}): Record<string, PropSpec> => ({
  of: { type: READING, required: true },
  label: { type: STRING },
  tone: { type: COLOR },
  ...extra,
});

// `of` is typed as any entity; the domain check (E012) names the built-in and the domain.
const control = (domains: readonly Domain[], extra: Record<string, PropSpec> = {}): Builtin => ({
  name: "",
  props: {
    of: { type: ENTITY, required: true },
    label: { type: STRING },
    ...extra,
  },
  children: false,
  ofDomains: domains,
});

const BUILTIN_LIST: Builtin[] = [
  // ───────── layout ─────────
  {
    name: "Stack",
    props: {
      /** `.Row` puts content-sized things beside each other (an icon by a name); equal
       * columns of full-width content are a Grid's. */
      direction: { type: enumOf("Column", "Row"), default: "Column" },
      gap: { type: union(token("space"), NUMBER), default: "space.md" },
      /** The children's own `align` would mean their cell in a Grid; a Stack's is its children. */
      align: { type: enumOf("Start", "Center", "End", "Stretch") },
      /** Where the children sit along the Stack; `.Between` puts the first and last at its ends. */
      justify: { type: enumOf("Start", "Center", "End", "Between"), default: "Start" },
      /** A `.Row` keeps to one line, its text giving way; true lets it wrap onto more. */
      wrap: { type: BOOL, default: false },
    },
    children: true,
  },
  {
    name: "Grid",
    props: {
      /** 1 to `GRID_COLUMNS_MAX`; left out, one per child up to that many (E037 either way). */
      columns: { type: NUMBER },
      gap: { type: union(token("space"), NUMBER), default: "space.md" },
      rowHeight: { type: enumOf("Auto", "Equal"), default: "Equal" },
    },
    children: true,
  },
  {
    name: "Card",
    props: {
      accent: { type: COLOR },
      size: { type: SIZE, default: "Md" },
      /** False hides the heading; a component name draws it in place of `CardHeader`. */
      header: {
        type: union(BOOL, component(HEADER_SLOTS.Card.params)),
        default: HEADER_SLOTS.Card.name,
      },
      /** False hides the theme's lines between the body's blocks; their spacing stays. */
      dividers: { type: BOOL, default: true },
      name: { type: STRING },
      /** A line under the name, in the theme's `card.subtitle`; nothing when left out. */
      subtitle: { type: STRING },
      /** What the card is about: its heading opens that thing's details when pressed. */
      of: { type: union(ENTITY, DEVICE, AREA) },
      icon: { type: STRING, icon: true },
      active: { type: BOOL },
      onPress: { type: event() },
    },
    children: true,
  },
  {
    name: "Area",
    props: {
      /** The area; left out, a frame for what is in no area. */
      of: { type: AREA },
      /** With `of`, the heading is the area's own name and icon, each replaced when given.
       * Without, the heading is drawn only as far as asked: `name` puts up the title, `icon`
       * the icon, and with neither, nor a `header`, there is no heading row. */
      name: { type: STRING },
      icon: { type: STRING, icon: true },
      facts: { type: BOOL, default: true },
      columns: { type: NUMBER, default: 1 },
      /** False hides the heading; a component name draws it in place of `AreaHeader`, given
       * the area, name and icon. */
      header: { type: union(BOOL, component(HEADER_SLOTS.Area.params)) },
    },
    children: true,
  },
  {
    name: "Section",
    props: {
      title: { type: STRING },
      collapsible: { type: BOOL, default: false },
      header: {
        type: component(HEADER_SLOTS.Section.params),
        default: HEADER_SLOTS.Section.name,
      },
    },
    children: true,
  },
  {
    name: "Spacer",
    props: { size: { type: token("space"), default: "space.md" } },
    children: false,
  },

  // ───────── text ─────────
  {
    name: "Text",
    props: {
      value: { type: STRING, required: true },
      style: { type: enumOf("Body", "Muted", "Label", "Display"), default: "Body" },
      color: { type: COLOR },
      /** Set one by one, over the style: a size in px, a weight, a face (`font.display`,
       * `room.name.font`). */
      size: { type: NUMBER },
      weight: { type: NUMBER },
      font: { type: token("font") },
    },
    children: false,
  },
  {
    name: "Icon",
    props: {
      name: { type: STRING, required: true, icon: true },
      color: { type: COLOR },
      /** `.Sm` `.Md` `.Lg`, or a number of px (`room.icon.size`). */
      size: { type: union(SIZE, NUMBER) },
      /** A box behind the icon: its shape, border, background, and the room around the icon. */
      shape: { type: token("shape") },
      border: { type: token("border") },
      background: { type: COLOR },
      padding: { type: NUMBER },
    },
    children: false,
  },

  // ───────── readings ─────────
  { name: "Row", props: reading({ onPress: { type: event() } }), children: false },
  { name: "Headline", props: reading({ unit: { type: BOOL, default: true } }), children: false },
  {
    name: "Value",
    // A stat can also carry words of the page's own: `text: date(sensor.x#at.value)`.
    props: {
      of: { type: READING },
      label: { type: STRING },
      tone: { type: COLOR },
      text: { type: STRING },
    },
    children: false,
  },
  {
    name: "Bar",
    props: reading({
      low: { type: NUMBER },
      target: { type: NUMBER },
      max: { type: NUMBER },
      color: { type: COLOR },
    }),
    children: false,
  },
  { name: "Status", props: reading(), children: false },
  {
    name: "History",
    props: reading({
      range: { type: RANGE, default: "Day" },
      /** How far back the bar reaches, in place of `range`: `6h`, `3d`. */
      duration: { type: DURATION },
      color: { type: COLOR, default: "chart.series1" },
      height: { type: NUMBER, default: 120 },
    }),
    children: false,
  },
  {
    name: "Timeline",
    props: reading({
      range: { type: RANGE, default: "Day" },
      duration: { type: DURATION },
      height: { type: NUMBER, default: 48 },
    }),
    children: false,
  },

  {
    /**
     * A still map. With `of`, it follows the entity's `latitude` and `longitude` attributes (a
     * car's location) and points along its `heading`; `latitude` and `longitude` are a fixed
     * place, or where to look while the entity has none.
     */
    name: "Map",
    props: {
      of: { type: ENTITY },
      latitude: { type: NUMBER },
      longitude: { type: NUMBER },
      /** 0, the world, to `MAP_ZOOM_MAX`, a street; 15 is a neighbourhood. */
      zoom: { type: NUMBER, default: 15 },
      /** Rounded up to whole grid units: three (200px) by default. */
      height: { type: NUMBER, default: 200 },
      /** A pin at the centre. */
      marker: { type: BOOL, default: true },
      /** What a screen reader calls the map; left out, the entity's name, or "Map". */
      label: { type: STRING },
    },
    children: false,
  },

  {
    /** A reading on its health bands: UV by the WHO's, particles and indexes by the EPA's or EEA's. */
    name: "Scale",
    props: {
      of: { type: READING, required: true },
      scale: { type: enumOf("UV", "PM25", "PM10", "AQI", "EAQI"), required: true },
      label: { type: STRING },
    },
    children: false,
  },
  {
    /** The day as the sun's path, from the weather's sunrise and sunset. */
    name: "SunPath",
    props: {
      weather: { type: entityOf("weather"), required: true },
      label: { type: STRING },
    },
    children: false,
  },

  // ───────── controls ─────────
  { ...control(["switch", "light"], { onToggle: { type: event(BOOL) } }), name: "Toggle" },
  { ...control(["light"]), name: "Dimmer" },
  { ...control(["climate"]), name: "Thermostat" },
  { ...control(["cover"]), name: "CoverControl" },
  { ...control(["lock"]), name: "LockControl" },
  {
    name: "Button",
    props: {
      label: { type: STRING, required: true },
      icon: { type: STRING, icon: true },
      onPress: { type: event() },
      of: { type: ENTITY },
    },
    children: false,
    ofDomains: ["button"],
  },
  {
    /** One segment per entity, each lit while its entity is on or open; a door asks first. */
    name: "ButtonGroup",
    props: {
      of: { type: list(ENTITY), required: true },
      /** Each segment's words, in `of`'s order; left out, the entity's name. */
      labels: { type: list(STRING) },
      /** What a screen reader calls the group; left out, "Buttons". */
      label: { type: STRING },
    },
    children: false,
    ofDomains: ["cover", "switch", "light", "button"],
  },
  {
    name: "Segmented",
    props: {
      options: { type: list(T), required: true },
      value: { type: T, required: true },
      labels: { type: list(STRING) },
      onChange: { type: event(T) },
    },
    children: false,
  },

  // ───────── page sections ─────────
  { name: "Greeting", props: { weather: { type: entityOf("weather") } }, children: false },
  {
    name: "Forecast",
    props: {
      weather: { type: entityOf("weather"), required: true },
      days: { type: NUMBER, default: 5 },
    },
    children: false,
  },
  { name: "Recent", props: { limit: { type: NUMBER, default: 10 } }, children: false },
  /** Retired: the search lives in the app's header now. Accepted, with a warning, and draws nothing. */
  {
    name: "Search",
    props: {},
    children: false,
    retired: "the search is in the header on every page now; this node draws nothing",
  },
];

export const BUILTINS: ReadonlyMap<string, Builtin> = new Map(BUILTIN_LIST.map((b) => [b.name, b]));

export const BUILTIN_NAMES: readonly string[] = BUILTIN_LIST.map((b) => b.name);

/** Every property a built-in accepts, its own and the common ones. */
export const propsOf = (builtin: Builtin): Record<string, PropSpec> => ({
  ...COMMON_PROPS,
  ...builtin.props,
});
