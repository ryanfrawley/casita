// casa/stock.ts
// The Home page a new house starts with, as Casa text. It is written once, when no Home is
// stored, and never regenerated: from then on it is the admin's page to edit. Everything in it
// is a loop over the house, so areas, devices and entities that arrive later show without a
// change to the page. Pure, so a test can compile it.

const GROUPS: { title: string; domains: [string, string?] }[] = [
  { title: "Doors and covers", domains: ["cover"] },
  { title: "Locks", domains: ["lock"] },
  { title: "Switches", domains: ["switch"] },
  { title: "Buttons", domains: ["button"] },
  { title: "Sensors", domains: ["sensor", "binary_sensor"] },
  { title: "Lights", domains: ["light"] },
];

const quote = (text: string) => JSON.stringify(text);

/** One `Group` use per kind of entity, over `of`. */
const groups = (of: string, indent: string) =>
  GROUPS.map(({ title, domains: [domain, other] }) => {
    const rest = other ? `  other: ${quote(other)}` : "";
    return `${indent}Group { of: ${of}  title: ${quote(title)}  domain: ${quote(domain)}${rest} }`;
  }).join("\n");

const WEATHER = 'filter(entities, (e) => e.domain == "weather")';

export const EMPTY_HOUSE_HINT =
  "Nothing here yet. Add an integration under Integrations, and its devices will appear here as they are found.";

/** The stock Home page. */
export function stockHome(): string {
  return `// Home, as Casita first wrote it. It is yours now: Edit page changes it, and nothing here is
// written again. Each part loops over the house, so new areas and devices show on their own.

// A device: its name and picture, and each of its entities as a row.
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

// An area: thermostats first, then each device, then whatever belongs to no device. Its width
// is the span on its use: the node written in the Grid is the cell.
component AreaCard(of: Area, facts: Bool = true) {
  Area { of: of  facts: facts
    for e in of.entities where e.domain == "climate" { Thermostat { of: e } }
    for d in sort(of.devices, (d) => d.name) { DeviceCard { of: d } }
${groups("of.entities", "    ")}
  }
}

page Home {
  Stack {
    Greeting {}
    Forecast { weather: first(${WEATHER})  when: count(${WEATHER}) > 0 && screen != .Phone }
    Text { style: .Muted  when: count(entities) == 0
      value: ${quote(EMPTY_HOUSE_HINT)} }

    Grid { columns: screen == .Phone ? 1 : screen == .Tablet ? 2 : 3
      for a in sort(areas, (a) => a.name) { AreaCard { of: a  span: 3 } }
      Area { name: "Not in a room"  when: any(entities, (e) => e.area == null)
        for e in entities where e.area == null && e.domain == "climate" { Thermostat { of: e } }
        for d in sort(devices, (d) => d.name) where d.area == null { DeviceCard { of: d } }
${groups("filter(entities, (e) => e.area == null)", "        ")}
      }
    }

    Recent { limit: 10  when: screen != .Phone }
  }
}
`;
}
