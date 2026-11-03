// casa/pretend.ts
// Pretend values: an entity's state or one of its attributes as an override says, everything
// else as reported. The page editor previews with them; an automation's test run uses them.

import type { EntityState, StateRecord, WeatherCondition } from "../types.ts";
import type { Host, Value } from "./values.ts";
import { isUnavailable } from "./values.ts";

/** A record for an entity that has reported nothing: available, its domain and no fields. */
function blank(id: string): StateRecord {
  return {
    entityId: id as StateRecord["entityId"],
    state: { domain: id.split(".")[0] } as EntityState,
    available: true,
    changedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** A pretend value for an entity: its state as the override says, everything else as reported. */
export function overridden(record: StateRecord | undefined, id: string, value: Value): StateRecord {
  const domain = id.split(".")[0] as EntityState["domain"];
  const base: StateRecord = record ?? blank(id);
  if (isUnavailable(value)) return { ...base, available: false };
  const on = value === "On";
  let state: EntityState;
  switch (domain) {
    case "light":
      state = { ...(base.state as Extract<EntityState, { domain: "light" }>), domain, on };
      break;
    case "switch":
    case "binary_sensor":
      state = { domain, on } as EntityState;
      break;
    case "sensor":
      state = {
        ...(base.state as Extract<EntityState, { domain: "sensor" }>),
        domain,
        value: value as number | string | null,
      };
      break;
    case "climate":
      state = {
        ...(base.state as Extract<EntityState, { domain: "climate" }>),
        domain,
        mode: String(value).toLowerCase() as "off" | "heat" | "cool" | "auto",
      };
      break;
    case "cover":
      state = {
        domain,
        position: value === "Closed" ? 0 : 1,
        motion: value === "Opening" ? "opening" : value === "Closing" ? "closing" : "stopped",
      };
      break;
    case "lock":
      state = { domain, locked: value === "Locked" };
      break;
    case "weather":
      state = {
        ...(base.state as Extract<EntityState, { domain: "weather" }>),
        domain,
        // `.PartlyCloudyNight` is `partly-cloudy-night`.
        condition: String(value)
          .replace(/([a-z])([A-Z])/g, "$1-$2")
          .toLowerCase() as WeatherCondition,
      };
      break;
    default:
      return base;
  }
  return { ...base, state, available: true };
}

/**
 * One override: `light.hall` pretends the entity's value, `weather.home#rain` one attribute
 * (as plain data: `Unavailable` there is null).
 */
export function pretendOne(
  record: StateRecord | undefined,
  key: string,
  value: Value,
): StateRecord {
  const hash = key.indexOf("#");
  if (hash < 0) return overridden(record, key, value);
  const id = key.slice(0, hash);
  const base = record ?? blank(id);
  const plain = isUnavailable(value) ? null : value;
  return { ...base, attributes: { ...(base.attributes ?? {}), [key.slice(hash + 1)]: plain } };
}

/** The host with these overrides over what it reports. */
export function pretending(host: Host, pretend: Record<string, Value>): Host {
  const keys = Object.keys(pretend);
  return Object.create(host, {
    state: {
      value: (id: string) => {
        let record = host.state(id);
        for (const key of keys) {
          if (key === id || key.startsWith(`${id}#`))
            record = pretendOne(record, key, pretend[key] as Value);
        }
        return record;
      },
    },
  }) as Host;
}
