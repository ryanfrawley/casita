// What the Automations page knows without a browser: how a name becomes an id, and the
// templates "New automation" starts from, filled with the entities the admin picked so that
// what is created compiles on the first save.

/** A name as the language takes it: PascalCase, like a page's. */
export const AUTOMATION_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** `HallLight` → `hall_light`: the id an automation is stored and addressed by. */
export function automationIdOf(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export interface TemplateField {
  key: string;
  label: string;
  /** Entities of these domains are offered. */
  domains: string[];
}

export interface Template {
  id: string;
  label: string;
  description: string;
  fields: TemplateField[];
  source(name: string, picks: Record<string, string>): string;
}

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    description: "An empty automation to write from scratch.",
    fields: [],
    source: (name) =>
      `automation ${name} {\n  // on light.hall changed to .On { … }\n  // every 10m { … }\n  // at 22:30 { … }\n}\n`,
  },
  {
    id: "motion",
    label: "Motion light",
    description: "A light turns on with motion and off five minutes after it stops.",
    fields: [
      { key: "sensor", label: "Motion sensor", domains: ["binary_sensor"] },
      { key: "light", label: "Light", domains: ["light", "switch"] },
    ],
    source: (name, { sensor, light }) =>
      `automation ${name} {
  on ${sensor} changed {
    if ${sensor}.value == .On {
      call ${light}.turn_on
    } else if ${sensor}.available {
      after 5m { call ${light}.turn_off }
    }
  }
}
`,
  },
  {
    id: "schedule",
    label: "Schedule",
    description: "Something turns on at one time of day and off at another.",
    fields: [{ key: "target", label: "Turns on and off", domains: ["light", "switch"] }],
    source: (name, { target }) =>
      `automation ${name} {
  at 18:00 { call ${target}.turn_on }
  at 23:00 { call ${target}.turn_off }
}
`,
  },
  {
    id: "mirror",
    label: "Follow another",
    description: "One thing turns on and off as another does.",
    fields: [
      { key: "leader", label: "When this changes", domains: ["light", "switch", "binary_sensor"] },
      { key: "follower", label: "This follows", domains: ["light", "switch"] },
    ],
    source: (name, { leader, follower }) =>
      `automation ${name} {
  on ${leader} changed to .On { call ${follower}.turn_on }
  on ${leader} changed to .Off { call ${follower}.turn_off }
}
`,
  },
];

/** The template's source, or undefined while a field is still unpicked. */
export function templateSource(
  template: Template,
  name: string,
  picks: Record<string, string>,
): string | undefined {
  if (template.fields.some((f) => !picks[f.key])) return undefined;
  return template.source(name, picks);
}

/** Why a name cannot be used, or undefined when it can. */
export function nameProblem(name: string, taken: Iterable<string>): string | undefined {
  if (!name) return "Give it a name";
  if (!AUTOMATION_NAME.test(name)) return "A name is PascalCase, such as HallLight";
  const id = automationIdOf(name);
  for (const existing of taken) if (existing === id) return `There is already an automation ${id}`;
  return undefined;
}
