// The unit system readings are shown in. Devices report in whatever unit they use and that is
// what is stored; conversion happens here, at the moment a value is shown to a person.

export type UnitSystem = "metric" | "imperial";

let system: UnitSystem = "metric";

export function setUnits(next: UnitSystem): void {
  system = next;
}
export const unitSystem = (): UnitSystem => system;

type Rule = [unit: string, convert: (value: number) => number];

const scale =
  (factor: number) =>
  (value: number): number =>
    value * factor;

/** Units that are not the system's own, and what each is shown as instead. */
const RULES: Record<UnitSystem, Record<string, Rule>> = {
  imperial: {
    "°C": ["°F", (c) => (c * 9) / 5 + 32],
    km: ["mi", scale(1 / 1.609344)],
    "km/h": ["mph", scale(1 / 1.609344)],
    m: ["ft", scale(1 / 0.3048)],
    "m/s": ["mph", scale(2.2369363)],
    cm: ["in", scale(1 / 2.54)],
    mm: ["in", scale(1 / 25.4)],
    bar: ["psi", scale(14.503774)],
    kPa: ["psi", scale(0.14503774)],
    kg: ["lb", scale(2.2046226)],
    L: ["gal", scale(0.26417205)],
  },
  metric: {
    "°F": ["°C", (f) => ((f - 32) * 5) / 9],
    mi: ["km", scale(1.609344)],
    mph: ["km/h", scale(1.609344)],
    ft: ["m", scale(0.3048)],
    in: ["mm", scale(25.4)],
    psi: ["bar", scale(1 / 14.503774)],
    lb: ["kg", scale(1 / 2.2046226)],
    gal: ["L", scale(1 / 0.26417205)],
  },
};

/** A reading in the unit system in force; one whose unit has no counterpart comes back as it is. */
export function inUnits(value: number, unit: string): { value: number; unit: string } {
  const rule = Object.hasOwn(RULES[system], unit) ? RULES[system][unit] : undefined;
  return rule ? { value: rule[1](value), unit: rule[0] } : { value, unit };
}

/** A temperature held in degrees Celsius (a thermostat's), as the number to show. */
export const degrees = (celsius: number): number => inUnits(celsius, "°C").value;
/** "°C" or "°F". */
export const degreeUnit = (): string => inUnits(0, "°C").unit;
/** The Celsius for a temperature given in the unit system in force. */
export const toCelsius = (shown: number): number =>
  system === "imperial" ? ((shown - 32) * 5) / 9 : shown;
