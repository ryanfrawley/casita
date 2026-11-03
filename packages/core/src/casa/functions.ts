// casa/functions.ts
// The fixed function library: one table the checker reads signatures from and the evaluator
// runs. Each is total over Null and Unavailable, which pass through.

import {
  BOOL,
  DURATION,
  ENTITY,
  list,
  NUMBER,
  STRING,
  type Type,
  typeVar,
  union,
} from "./types.ts";
import { type FnValue, type Host, isAbsent, isEntity, isFn, type Value } from "./values.ts";

const T = typeVar("T");

export interface ParamSpec {
  type: Type;
  optional?: boolean;
  /** A lambda parameter: its own parameters' types, in terms of the bound generics. */
  lambda?: Type[];
}

export interface FunctionSpec {
  params: ParamSpec[];
  /** Further arguments of this type may follow. */
  rest?: Type;
  returns: Type;
  run: (args: Value[], host: Host) => Value;
}

const absent = (args: Value[]) => args.find(isAbsent);
const numeric = (f: (...n: number[]) => number) => (args: Value[]) => {
  const bad = absent(args);
  if (bad !== undefined) return bad;
  return f(...(args as number[]));
};
const stringy = (f: (...s: string[]) => Value) => (args: Value[]) => {
  const bad = absent(args);
  if (bad !== undefined) return bad;
  return f(...(args as string[]));
};

const roundTo = (x: number, places: number) => {
  const factor = 10 ** places;
  // Half away from zero, unlike Math.round for negatives.
  return (Math.sign(x) * Math.round(Math.abs(x) * factor)) / factor;
};

/** `date(t)`, `time(t)`, `datetime(t)`: an epoch-ms instant in the host's words. */
const when = (format: "date" | "time" | "datetime"): FunctionSpec => ({
  params: [{ type: NUMBER }],
  returns: STRING,
  run: (args, host) => {
    const bad = absent(args);
    if (bad !== undefined) return bad;
    // A date reads "today" or "yesterday" against the clock, so the clock is read.
    host.onRead?.("now");
    return host.when(args[0] as number, format, host.now());
  },
});

const apply = (fn: Value, args: Value[]): Value => (isFn(fn) ? (fn as FnValue).call(args) : null);

/** What a lambda makes of each item, keeping only the numbers: an unavailable reading is left out. */
const numbersOf = (items: Value[], fn: Value): number[] =>
  items.map((item) => apply(fn, [item])).filter((v): v is number => typeof v === "number");

export const FUNCTIONS: Record<string, FunctionSpec> = {
  round: {
    params: [{ type: NUMBER }, { type: NUMBER, optional: true }],
    returns: NUMBER,
    run: numeric((x, places = 0) => roundTo(x, places)),
  },
  floor: { params: [{ type: NUMBER }], returns: NUMBER, run: numeric(Math.floor) },
  ceil: { params: [{ type: NUMBER }], returns: NUMBER, run: numeric(Math.ceil) },
  abs: { params: [{ type: NUMBER }], returns: NUMBER, run: numeric(Math.abs) },
  clamp: {
    params: [{ type: NUMBER }, { type: NUMBER }, { type: NUMBER }],
    returns: NUMBER,
    run: numeric((x, lo, hi) => Math.min(hi, Math.max(lo, x))),
  },
  min: {
    params: [{ type: NUMBER }, { type: NUMBER }],
    rest: NUMBER,
    returns: NUMBER,
    run: numeric(Math.min),
  },
  max: {
    params: [{ type: NUMBER }, { type: NUMBER }],
    rest: NUMBER,
    returns: NUMBER,
    run: numeric(Math.max),
  },
  format: {
    params: [{ type: NUMBER }, { type: NUMBER, optional: true }],
    returns: STRING,
    run: (args, host) => {
      const bad = absent(args);
      if (bad !== undefined) return bad;
      return host.format(args[0] as number, (args[1] as number | undefined) ?? 0);
    },
  },
  unit: {
    params: [{ type: ENTITY }],
    returns: STRING,
    run: (args, host) => {
      const e = args[0];
      if (!isEntity(e)) return isAbsent(e) ? e : null;
      const entity = host.entity(e.id);
      host.onRead?.(`state:${e.id}`);
      return entity ? host.unit(entity, host.state(e.id)) : null;
    },
  },
  ago: {
    params: [{ type: NUMBER }],
    returns: STRING,
    run: (args, host) => {
      const bad = absent(args);
      if (bad !== undefined) return bad;
      host.onRead?.("now");
      return host.ago(args[0] as number, host.now());
    },
  },
  date: when("date"),
  time: when("time"),
  datetime: when("datetime"),
  present: {
    params: [{ type: ENTITY }],
    returns: STRING,
    run: (args, host) => {
      const e = args[0];
      if (!isEntity(e)) return isAbsent(e) ? e : null;
      const entity = host.entity(e.id);
      host.onRead?.(`state:${e.id}`);
      host.onRead?.("now");
      return entity ? host.present(entity, host.state(e.id)) : null;
    },
  },
  count: {
    params: [{ type: list(T) }],
    returns: NUMBER,
    run: (args) =>
      Array.isArray(args[0]) ? args[0].length : isAbsent(args[0]) ? (args[0] as Value) : 0,
  },
  any: {
    params: [{ type: list(T) }, { type: BOOL, lambda: [T] }],
    returns: BOOL,
    run: (args) =>
      Array.isArray(args[0])
        ? args[0].some((item) => apply(args[1] as Value, [item]) === true)
        : isAbsent(args[0])
          ? (args[0] as Value)
          : false,
  },
  all: {
    params: [{ type: list(T) }, { type: BOOL, lambda: [T] }],
    returns: BOOL,
    run: (args) =>
      Array.isArray(args[0])
        ? args[0].every((item) => apply(args[1] as Value, [item]) === true)
        : isAbsent(args[0])
          ? (args[0] as Value)
          : true,
  },
  /** The items a lambda says yes to, in order; an item it answers absent for is left out. */
  filter: {
    params: [{ type: list(T) }, { type: BOOL, lambda: [T] }],
    returns: list(T),
    run: (args) =>
      Array.isArray(args[0])
        ? args[0].filter((item) => apply(args[1] as Value, [item]) === true)
        : isAbsent(args[0])
          ? (args[0] as Value)
          : [],
  },
  /** The numbers a lambda picks from a list; an item that is absent or not a number is left out. */
  sum: {
    params: [{ type: list(T) }, { type: NUMBER, lambda: [T] }],
    returns: NUMBER,
    run: (args) => {
      if (!Array.isArray(args[0])) return isAbsent(args[0]) ? (args[0] as Value) : null;
      return numbersOf(args[0], args[1] as Value).reduce((a, b) => a + b, 0);
    },
  },
  /** The mean of the numbers a lambda picks from a list; null when it picks none. */
  avg: {
    params: [{ type: list(T) }, { type: NUMBER, lambda: [T] }],
    returns: NUMBER,
    run: (args) => {
      if (!Array.isArray(args[0])) return isAbsent(args[0]) ? (args[0] as Value) : null;
      const numbers = numbersOf(args[0], args[1] as Value);
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    },
  },
  first: {
    params: [{ type: list(T) }],
    returns: T,
    run: (args) =>
      Array.isArray(args[0]) ? (args[0][0] ?? null) : isAbsent(args[0]) ? (args[0] as Value) : null,
  },
  sort: {
    params: [{ type: list(T) }, { type: union(NUMBER, STRING), lambda: [T] }],
    returns: list(T),
    run: (args) => {
      if (!Array.isArray(args[0])) return isAbsent(args[0]) ? (args[0] as Value) : [];
      const keyed = args[0].map((item) => ({ item, key: apply(args[1] as Value, [item]) }));
      keyed.sort((a, b) => {
        if (typeof a.key === "number" && typeof b.key === "number") return a.key - b.key;
        return String(a.key).localeCompare(String(b.key));
      });
      return keyed.map((k) => k.item);
    },
  },
  lower: { params: [{ type: STRING }], returns: STRING, run: stringy((s) => s.toLowerCase()) },
  upper: { params: [{ type: STRING }], returns: STRING, run: stringy((s) => s.toUpperCase()) },
  trim: { params: [{ type: STRING }], returns: STRING, run: stringy((s) => s.trim()) },
  contains: {
    params: [{ type: STRING }, { type: STRING }],
    returns: BOOL,
    run: stringy((s, sub) => s.includes(sub)),
  },
  starts: {
    params: [{ type: STRING }, { type: STRING }],
    returns: BOOL,
    run: stringy((s, p) => s.startsWith(p)),
  },
  since: {
    params: [{ type: NUMBER }],
    returns: DURATION,
    run: (args, host) => {
      const bad = absent(args);
      if (bad !== undefined) return bad;
      host.onRead?.("now");
      return host.now() - (args[0] as number);
    },
  },
  between: {
    params: [{ type: NUMBER }, { type: NUMBER }, { type: NUMBER }],
    returns: BOOL,
    run: (args) => {
      const bad = absent(args);
      if (bad !== undefined) return bad;
      const [x, lo, hi] = args as number[];
      return (x as number) >= (lo as number) && (x as number) <= (hi as number);
    },
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);
