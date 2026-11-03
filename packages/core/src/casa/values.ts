// casa/values.ts
// Run-time values and the host an expression reads the house through. The same evaluator
// runs in the browser over the House store and on the server over the state store; the host
// is what differs.

import type { Area, Device, Entity, StateRecord } from "../types.ts";

export interface Unavailable {
  $: "unavailable";
}
export const UNAVAILABLE: Unavailable = { $: "unavailable" };

export interface EntityValue {
  $: "entity";
  id: string;
}
export interface AttributeValue {
  $: "attr";
  id: string;
  name: string;
}
export interface AreaValue {
  $: "area";
  id: string;
}
export interface DeviceValue {
  $: "device";
  id: string;
}
export interface NowValue {
  $: "now";
}
/** `e.attr`: the record of an entity's state fields and attributes. */
export interface RecordValue {
  $: "record";
  fields: Record<string, unknown>;
}
export interface FnValue {
  $: "fn";
  params: string[];
  call: (args: Value[]) => Value;
}

export type Value =
  | number
  | string
  | boolean
  | null
  | Unavailable
  | EntityValue
  | AttributeValue
  | AreaValue
  | DeviceValue
  | NowValue
  | RecordValue
  | FnValue
  | Value[];

export const isUnavailable = (v: unknown): v is Unavailable =>
  typeof v === "object" && v !== null && (v as { $?: string }).$ === "unavailable";
const tagged = (v: unknown, tag: string): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (v as { $?: string }).$ === tag;
export const isEntity = (v: unknown): v is EntityValue => tagged(v, "entity");
export const isAttribute = (v: unknown): v is AttributeValue => tagged(v, "attr");
export const isArea = (v: unknown): v is AreaValue => tagged(v, "area");
export const isDevice = (v: unknown): v is DeviceValue => tagged(v, "device");
export const isFn = (v: unknown): v is FnValue => tagged(v, "fn");
export const isRecord = (v: unknown): v is RecordValue => tagged(v, "record");
export const isNow = (v: unknown): v is NowValue => tagged(v, "now");
/** Null or Unavailable: what every operation passes through. */
export const isAbsent = (v: unknown): v is null | Unavailable => v === null || isUnavailable(v);

export type Screen = "Phone" | "Tablet" | "Desktop";

/** What an expression may read. Every read is reported to `onRead` with a dependency key. */
export interface Host {
  state(id: string): StateRecord | undefined;
  entity(id: string): Entity | undefined;
  entities(): readonly Entity[];
  devices(): readonly Device[];
  areas(): readonly Area[];
  screen(): Screen;
  /** Epoch ms, as of the last minute tick. */
  now(): number;
  timezone: string;
  /** The words `present.ts` gives a state, and the unit system's unit for an entity. */
  present(entity: Entity, record: StateRecord | undefined): string;
  unit(entity: Entity, record: StateRecord | undefined): string | null;
  ago(ms: number, now: number): string;
  /** An instant as a date ("Wed 7 Oct"), a clock time ("10:42 pm"), or both. */
  when(ms: number, format: "date" | "time" | "datetime", now: number): string;
  format(value: number, places: number): string;
  onRead?(dependency: string): void;
}

/** Dependency keys, as `onRead` reports them and the browser subscribes to them. */
export const dep = {
  state: (id: string) => `state:${id}`,
  registry: "registry",
  screen: "screen",
  now: "now",
  var: (name: string) => `var:${name}`,
};

/** `5m`, `1h30m`, `2s`: a duration as Casa writes it. */
export function duration(ms: number): string {
  const parts: string[] = [];
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join("");
}
