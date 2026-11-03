// What the Sensors list knows without a browser: the templates "New sensor" starts from,
// filled with the entities the admin picked so that what is created compiles on the first
// save. A sensor's name becomes its id as an automation's does.

import {
  automationIdOf,
  type Template,
  type TemplateField,
  templateSource,
} from "./automations.ts";

export type { Template, TemplateField };
export { automationIdOf as sensorIdOf, templateSource };

export const SENSOR_TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    description: "An empty sensor to write from scratch.",
    fields: [],
    source: (name) =>
      `sensor ${name} {
  // input door = binary_sensor.kitchen_door
  name: "${name}"
  type: String
  // value: door.value == .On ? "Open" : "Closed"
  value: ""
}
`,
  },
  {
    id: "door",
    label: "Door and lock",
    description: "A door's contact sensor and its lock as one reading: Open, Unlocked or Secured.",
    fields: [
      { key: "door", label: "Door sensor", domains: ["binary_sensor"] },
      { key: "bolt", label: "Lock", domains: ["lock"] },
    ],
    source: (name, { door, bolt }) =>
      `sensor ${name} {
  input door = ${door}
  input bolt = ${bolt}
  name: "${words(name)}"
  type: String
  value: door.value == .On ? "Open" : bolt.value == .Unlocked ? "Unlocked" : "Secured"
}
`,
  },
  {
    id: "secure",
    label: "Secure",
    description: "Yes or no: the door is closed and its lock is locked.",
    fields: [
      { key: "door", label: "Door sensor", domains: ["binary_sensor"] },
      { key: "bolt", label: "Lock", domains: ["lock"] },
    ],
    source: (name, { door, bolt }) =>
      `sensor ${name} {
  input door = ${door}
  input bolt = ${bolt}
  name: "${words(name)}"
  type: Bool  class: .Door
  value: door.value == .Off && bolt.value == .Locked
}
`,
  },
  {
    id: "average",
    label: "Average",
    description: "The mean of two readings; add more to the list in the editor.",
    fields: [
      { key: "a", label: "First reading", domains: ["sensor"] },
      { key: "b", label: "Second reading", domains: ["sensor"] },
    ],
    source: (name, { a, b }) =>
      `sensor ${name} {
  input readings = [${a}, ${b}]
  name: "${words(name)}"
  type: Number  unit: "°C"  class: .Temperature
  value: avg(readings, (r) => r.value)
}
`,
  },
];

/** `KitchenDoor` → `Kitchen door`: the name the entity is given, from the sensor's. */
export function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .map((word, i) => (i > 0 && !/^[A-Z]{2,}$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/** Why a name cannot be used, or undefined when it can. */
export function sensorNameProblem(name: string, taken: Iterable<string>): string | undefined {
  if (!name) return "Give it a name";
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return "A name is PascalCase, such as KitchenDoor";
  const id = automationIdOf(name);
  for (const existing of taken) if (existing === id) return `There is already a sensor ${id}`;
  return undefined;
}
