// casa/legacy.ts
// The Home page as a Casa text, generated once from what the house arranged by form: area
// widths and chips, device cards, custom cards, hidden devices. A room with nothing arranged
// is drawn by a loop, so devices and rooms that arrive later still show. Pure, so the first
// render of the generated page can be checked against today's Home.

import type { Database } from "bun:sqlite";
import { DOMAIN_NAMES } from "./lexer.ts";

// The shapes the arrangement was stored in (the `cards` table, `devices.card`, `areas.display`),
// as they were before Casa. Nothing else reads them now; migration 010 drops the columns.

export interface LegacyReading {
  /** An entity id, or `<entityId>#<key>` for a key of that entity's attributes. */
  id: string;
  display: "row" | "value" | "headline" | "bar" | "status" | "history";
  label?: string;
  tone?: "accent" | "neutral" | "lamp" | "sky" | "sage" | "ember";
  /** `bar` only: another reading whose value is drawn as a tick. */
  target?: string;
  low?: number;
  range?: "hour" | "day" | "week";
}

export interface LegacyCard {
  name?: string;
  icon?: string;
  accent?: "lamp" | "sky" | "sage" | "ember";
  /** `any`, `never`, or an entity id that must be on. */
  activeWhen?: string;
  size?: "sm" | "md" | "lg";
  header?: boolean;
  readings: LegacyReading[];
}

export interface LegacyArea {
  id: string;
  name: string;
  display?: { columns?: 1 | 2 | 3; facts?: boolean };
}

export interface LegacyDevice {
  id: string;
  name: string;
  areaId?: string;
  card?: LegacyCard;
  homeHidden?: boolean;
}

export interface LegacyEntity {
  id: string;
  domain: string;
  hidden?: boolean;
  disabled?: boolean;
}

export interface LegacyCustomCard {
  id: string;
  areaId?: string;
  config: LegacyCard;
}

export interface LegacyHouse {
  areas: readonly LegacyArea[];
  devices: readonly LegacyDevice[];
  entities: readonly LegacyEntity[];
  cards: readonly LegacyCustomCard[];
}

const parse = <T>(json: string | null | undefined): T | undefined => {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
};

/**
 * The house as arranged before Casa, read straight from the database: the registry no longer
 * carries cards or how rooms are drawn, and after migration 010 the columns are gone, so each
 * is read only when it is still there.
 */
export function legacyHouse(db: Database): LegacyHouse {
  const columns = (table: string) =>
    new Set(
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
  const areaColumns = columns("areas");
  const deviceColumns = columns("devices");
  const hasCards = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cards'",
    )
    .get();
  const areas = db
    .query<{ id: string; name: string; display: string | null }, []>(
      `SELECT id, name, ${areaColumns.has("display") ? "display" : "NULL AS display"} FROM areas`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      display: parse<LegacyArea["display"]>(row.display),
    }));
  const devices = db
    .query<
      {
        id: string;
        name: string;
        area_id: string | null;
        card: string | null;
        home_hidden: number;
      },
      []
    >(
      `SELECT id, name, area_id, ${deviceColumns.has("card") ? "card" : "NULL AS card"},
         ${deviceColumns.has("home_hidden") ? "home_hidden" : "0 AS home_hidden"} FROM devices`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      areaId: row.area_id ?? undefined,
      card: parse<LegacyCard>(row.card),
      homeHidden: row.home_hidden ? true : undefined,
    }));
  const entities = db
    .query<{ id: string; domain: string; hidden: number; disabled: number }, []>(
      "SELECT id, domain, hidden, disabled FROM entities",
    )
    .all()
    .map((row) => ({
      id: row.id,
      domain: row.domain,
      hidden: row.hidden ? true : undefined,
      disabled: row.disabled ? true : undefined,
    }));
  const cards = hasCards
    ? db
        .query<{ id: string; area_id: string | null; config: string }, []>(
          "SELECT id, area_id, config FROM cards ORDER BY created_at, id",
        )
        .all()
        .flatMap((row) => {
          const config = parse<LegacyCard>(row.config);
          return config ? [{ id: row.id, areaId: row.area_id ?? undefined, config }] : [];
        })
    : [];
  return { areas, devices, entities, cards };
}

const quote = (text: string) => JSON.stringify(text);

/** The groups a room draws for its entities that belong to no device, in today's order. */
const GROUPS: { title: string; domains: string[] }[] = [
  { title: "Doors and covers", domains: ["cover"] },
  { title: "Locks", domains: ["lock"] },
  { title: "Switches", domains: ["switch"] },
  { title: "Buttons", domains: ["button"] },
  { title: "Sensors", domains: ["sensor", "binary_sensor"] },
  { title: "Lights", domains: ["light"] },
];

/** The components every generated Home shares: a default device card and a group card. */
const PRELUDE = `// Generated from the cards and rooms arranged before Casa. Edit freely: this is the page now.

// A device as Home drew it with nothing chosen: its name, and every entity as a row.
component DeviceCard(of: Device) {
  Card { name: of.name  icon: of.icon  active: any(of.entities, (e) => e.value == .On)
    for e in of.entities where e.domain != "climate" { Row { of: e } }
  }
}

// The entities of one kind that belong to no device, as one card.
component Group(of: List<Entity>, title: String, domain: String, other: String = "") {
  Card { name: title
    when: any(of, (e) => e.device == null && (e.domain == domain || e.domain == other))
    active: any(of, (e) => e.device == null && e.value == .On)
    for e in of where e.device == null && (e.domain == domain || e.domain == other) { Row { of: e } }
  }
}

// An area with nothing arranged: thermostats first, then each device, then what has none. Its width is the span on its use: the node written in the Grid
// is the cell.
component AreaCard(of: Area, facts: Bool = true) {
  Area { of: of  facts: facts
    for e in of.entities where e.domain == "climate" { Thermostat { of: e } }
    for d in sort(of.devices, (d) => d.name) { DeviceCard { of: d } }
${GROUPS.map((g) => `    Group { of: of.entities  title: ${quote(g.title)}  domain: ${quote(g.domains[0] as string)}${g.domains[1] ? `  other: ${quote(g.domains[1])}` : ""} }`).join("\n")}
  }
}
`;

const TONE: Record<string, string | undefined> = {
  accent: undefined,
  neutral: "text.muted",
  lamp: "accents.lamp",
  sky: "accents.sky",
  sage: "accents.sage",
  ember: "accents.ember",
};
const RANGE: Record<string, string> = { hour: ".Hour", day: ".Day", week: ".Week" };
const SIZE: Record<string, string> = { sm: ".Sm", md: ".Md", lg: ".Lg" };
const READING: Record<string, string> = {
  row: "Row",
  value: "Value",
  headline: "Headline",
  bar: "Bar",
  status: "Status",
  history: "History",
};

const isEntityId = (id: string) => {
  const [domain, object] = id.split(".");
  return (
    (DOMAIN_NAMES as readonly string[]).includes(domain ?? "") && /^[a-z0-9_]+$/.test(object ?? "")
  );
};

/** `sensor.x#humidity` as a Casa reference, or undefined when it is not one Casa can name. */
function readingRef(id: string, known: Set<string>): string | undefined {
  const [entityId, attr] = id.split("#");
  if (!entityId || !known.has(entityId) || !isEntityId(entityId)) return undefined;
  if (attr && !/^[a-z_][a-zA-Z0-9_]*$/.test(attr)) return undefined;
  return attr ? `${entityId}#${attr}` : entityId;
}

function reading(item: LegacyReading, known: Set<string>, indent: string): string | undefined {
  const of = readingRef(item.id, known);
  if (!of) return undefined;
  const props = [`of: ${of}`];
  if (item.label) props.push(`label: ${quote(item.label)}`);
  if (item.display === "bar") {
    const tone = item.tone ? TONE[item.tone] : undefined;
    if (tone) props.push(`color: ${tone}`);
    if (item.low !== undefined) props.push(`low: ${item.low}`);
    const target = item.target ? readingRef(item.target, known) : undefined;
    if (target) props.push(`target: ${target}.value`);
  }
  if (item.display === "history" && item.range) props.push(`range: ${RANGE[item.range]}`);
  return `${indent}${READING[item.display]} { ${props.join("  ")} }`;
}

/** The domains whose state reads as On or Off. */
const ON_OFF = new Set(["light", "switch", "binary_sensor"]);

/** The `active:` expression for a card's `activeWhen`. */
function activeOf(config: LegacyCard, entities: string, known: Set<string>): string {
  const when = config.activeWhen ?? "any";
  if (when === "never" || entities === "[]") return "false";
  if (when !== "any" && known.has(when) && isEntityId(when)) {
    return ON_OFF.has(when.split(".")[0] ?? "") ? `${when}.value == .On` : "false";
  }
  return `any(${entities}, (e) => e.value == .On)`;
}

function card(
  config: LegacyCard,
  name: string,
  entities: string,
  known: Set<string>,
  indent: string,
  /** The device the card is of, whose own picture it takes when none was chosen for it. */
  device?: string,
): string {
  const props = [`name: ${quote(config.name ?? name)}`];
  if (config.icon) props.push(`icon: ${quote(config.icon)}`);
  else if (device) props.push(`icon: ${device}.icon`);
  if (config.accent) props.push(`accent: accents.${config.accent}`);
  if (config.size && config.size !== "md") props.push(`size: ${SIZE[config.size]}`);
  if (config.header === false) props.push("header: false");
  props.push(`active: ${activeOf(config, entities, known)}`);
  const rows = config.readings
    .map((item) => reading(item, known, `${indent}  `))
    .filter((line): line is string => line !== undefined);
  return `${indent}Card { ${props.join("  ")}\n${rows.join("\n")}${rows.length ? "\n" : ""}${indent}}`;
}

/** Whether a room needs writing out, because something in it was arranged by hand. */
function arranged(area: LegacyArea | undefined, house: LegacyHouse): boolean {
  if (!area) return true;
  if (area.display && (area.display.columns !== undefined || area.display.facts !== undefined))
    return true;
  if (house.devices.some((d) => d.areaId === area.id && (d.card || d.homeHidden))) return true;
  return house.cards.some((c) => c.areaId === area.id);
}

export function homeFromLegacy(house: LegacyHouse): string {
  const known = new Set(
    house.entities.filter((e) => !e.hidden && !e.disabled).map((e) => e.id as string),
  );
  const weather = house.entities.find((e) => e.domain === "weather" && !e.hidden && !e.disabled);
  const areas = [...house.areas].sort((a, b) => a.name.localeCompare(b.name));
  const explicit = areas.filter((a) => arranged(a, house));
  const lines: string[] = [];

  const room = (area: LegacyArea | undefined) => {
    const display = area?.display ?? {};
    const props = area
      ? [`of: area.${area.id}`, `span: ${display.columns ?? 3}`]
      : ['name: "Not in a room"', "when: any(entities, (e) => e.area == null)"];
    if (display.facts === false) props.push("facts: false");
    lines.push(`      Area { ${props.join("  ")}`);
    const entities = area ? `area.${area.id}.entities` : "entities";
    const inRoom = area ? "" : "e.area == null && ";
    lines.push(
      `        for e in ${entities} where ${inRoom}e.domain == "climate" { Thermostat { of: e } }`,
    );
    // Devices arranged by hand are written out; every other device comes through a loop,
    // so one that arrives later shows too. A hidden device is left out of both.
    const devices = house.devices
      .filter((d) => (area ? d.areaId === area.id : !d.areaId))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const device of devices) {
      if (device.homeHidden || !device.card) continue;
      lines.push(
        card(
          device.card,
          device.name,
          `device.${device.id}.entities`,
          known,
          "        ",
          `device.${device.id}`,
        ),
      );
    }
    const skipped = devices.filter((d) => d.homeHidden || d.card).map((d) => `d != device.${d.id}`);
    const clauses = [...(area ? [] : ["d.area == null"]), ...skipped];
    const list = area ? `area.${area.id}.devices` : "devices";
    const where = clauses.length ? ` where ${clauses.join(" && ")}` : "";
    lines.push(`        for d in sort(${list}, (d) => d.name)${where} { DeviceCard { of: d } }`);
    for (const custom of house.cards.filter((c) => (area ? c.areaId === area.id : !c.areaId))) {
      // "Anything on" means the things that can be on: a sensor's reading never is.
      const shown = custom.config.readings
        .map((r) => r.id.split("#")[0] as string)
        .filter(
          (id, i, all) =>
            known.has(id) && all.indexOf(id) === i && ON_OFF.has(id.split(".")[0] ?? ""),
        );
      lines.push(card(custom.config, custom.id, `[${shown.join(", ")}]`, known, "        "));
    }
    for (const group of GROUPS) {
      const other = group.domains[1] ? `  other: ${quote(group.domains[1])}` : "";
      const domain = quote(group.domains[0] as string);
      lines.push(
        `        Group { of: ${entities}  title: ${quote(group.title)}  domain: ${domain}${other} }`,
      );
    }
    lines.push("      }");
  };

  lines.push(PRELUDE);
  lines.push("page Home {");
  lines.push("  Stack {");
  lines.push(weather ? `    Greeting { weather: ${weather.id} }` : "    Greeting {}");
  if (weather) lines.push(`    Forecast { weather: ${weather.id}  when: screen != .Phone }`);
  lines.push("");
  lines.push("    Grid { columns: screen == .Phone ? 1 : screen == .Tablet ? 2 : 3");
  for (const area of explicit) room(area);
  const others = explicit.length
    ? ` where ${explicit.map((a) => `a != area.${a.id}`).join(" && ")}`
    : "";
  lines.push(`      for a in sort(areas, (a) => a.name)${others} {`);
  lines.push("        AreaCard { of: a  span: 3 }");
  lines.push("      }");
  room(undefined);
  lines.push("    }");
  lines.push("");
  lines.push("    Recent { limit: 10  when: screen != .Phone }");
  lines.push("  }");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
