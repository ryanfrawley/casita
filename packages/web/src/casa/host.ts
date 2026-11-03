// The house as a Casa expression reads it in the browser: the store's House, the viewport,
// the clock, and the editor's pretend values. Every read is a dependency key; the store
// below stamps each key when it changes, so a node re-evaluates only what moved.

import { inUnits, present, type Row } from "@casita/client";
import type {
  Area,
  Device,
  Entity,
  EntityState,
  Host,
  Screen,
  StateRecord,
  Value,
} from "@casita/core/casa";
import { dep, overridden } from "@casita/core/casa";

export { overridden };
import { formatTime } from "@casita/ui";
import type { House, Store } from "../store.ts";

export interface Breakpoints {
  tablet: number;
  desktop: number;
}

export const DEFAULT_BREAKPOINTS: Breakpoints = { tablet: 860, desktop: 1100 };

export const screenFor = (width: number, breakpoints: Breakpoints): Screen =>
  width >= breakpoints.desktop ? "Desktop" : width >= breakpoints.tablet ? "Tablet" : "Phone";

export interface HostInputs {
  house: House;
  screen: Screen;
  now: number;
  timezone: string;
  overrides: ReadonlyMap<string, Value>;
  onRead?: (key: string) => void;
}

/** A host over one snapshot of the house. Cheap to make: the store makes one per change. */
export function browserHost(inputs: HostInputs): Host {
  const { house, overrides } = inputs;
  const entities = house.entities as unknown as Entity[];
  const devices = house.devices as unknown as Device[];
  const areas = house.areas as unknown as Area[];
  return {
    state: (id) => {
      const record = house.states.get(id) as StateRecord | undefined;
      const value = overrides.get(id);
      return value === undefined ? record : overridden(record, id, value);
    },
    entity: (id) => entities.find((e) => e.id === id),
    entities: () => entities,
    devices: () => devices,
    areas: () => areas,
    screen: () => inputs.screen,
    now: () => inputs.now,
    timezone: inputs.timezone,
    present: (_entity, record) => present(record as Row | undefined, inputs.now).text,
    unit: (_entity, record) => {
      const state = record?.state;
      if (state?.domain !== "sensor" || typeof state.value !== "number") return null;
      return inUnits(state.value, state.unit ?? "").unit || null;
    },
    ago: (ms, now) => formatTime(ms, { now }),
    when: (ms, format, now) =>
      formatTime(ms, { format: format === "time" ? "clock" : format, now }),
    // The same places on both sides: `format(x)` is the whole number, as the server gives it.
    format: (value, places) =>
      value.toLocaleString(undefined, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }),

    onRead: inputs.onRead,
  };
}

/**
 * What a Casa page subscribes to: the house, the viewport's size class, the clock, and the
 * editor's pretend values; each read key stamped with when it last changed.
 */
export class CasaStore {
  private stamp = 1;
  private readonly changed = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private house: House;
  private screen: Screen;
  private now = Date.now();
  private overrides: ReadonlyMap<string, Value> = new Map();
  private breakpoints = DEFAULT_BREAKPOINTS;
  private width: number;
  private hostCache?: Host;
  private readonly stops: (() => void)[] = [];

  constructor(
    readonly store: Store,
    options: { width?: () => number; timezone?: string; tick?: boolean } = {},
  ) {
    this.house = store.getState();
    this.measure =
      options.width ?? (() => (typeof window === "undefined" ? 1200 : window.innerWidth));
    this.width = this.measure();
    this.screen = screenFor(this.width, this.breakpoints);
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.stops.push(store.subscribe(() => this.onHouse(store.getState())));
    if (typeof window !== "undefined") {
      const onResize = () => this.setWidth(this.measure());
      window.addEventListener("resize", onResize);
      this.stops.push(() => window.removeEventListener("resize", onResize));
    }
    if (options.tick !== false) {
      const timer = setInterval(() => this.tick(), 60_000);
      this.stops.push(() => clearInterval(timer));
    }
  }

  private readonly measure: () => number;
  readonly timezone: string;

  stop(): void {
    for (const stop of this.stops) stop();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** The current stamp; a node remembers it with its dependencies. */
  get version(): number {
    return this.stamp;
  }

  /** Whether any of these keys changed after `since`. */
  changedSince(deps: Iterable<string>, since: number): boolean {
    for (const key of deps) if ((this.changed.get(key) ?? 0) > since) return true;
    return false;
  }

  host(): Host {
    this.hostCache ??= browserHost({
      house: this.house,
      screen: this.screen,
      now: this.now,
      timezone: this.timezone,
      overrides: this.overrides,
    });
    return this.hostCache;
  }

  get currentHouse(): House {
    return this.house;
  }

  get currentScreen(): Screen {
    return this.screen;
  }

  /** The editor's pretend values; an empty map clears them. */
  setOverrides(overrides: ReadonlyMap<string, Value>): void {
    const touched = new Set([...this.overrides.keys(), ...overrides.keys()]);
    this.overrides = overrides;
    this.bump([...touched].map(dep.state));
  }

  /** The active theme's breakpoints, which decide what `screen` reads. */
  setBreakpoints(breakpoints: Breakpoints): void {
    this.breakpoints = breakpoints;
    this.setWidth(this.width, true);
  }

  /** The editor narrows the preview to a chosen width. */
  setWidth(width: number, force = false): void {
    this.width = width;
    const screen = screenFor(width, this.breakpoints);
    if (screen === this.screen && !force) return;
    this.screen = screen;
    this.bump([dep.screen]);
  }

  tick(now = Date.now()): void {
    this.now = now;
    this.bump([dep.now]);
  }

  private onHouse(next: House): void {
    const prev = this.house;
    this.house = next;
    const keys: string[] = [];
    if (
      prev.entities !== next.entities ||
      prev.devices !== next.devices ||
      prev.areas !== next.areas
    ) {
      keys.push(dep.registry);
    }
    if (prev.states !== next.states) {
      for (const [id, record] of next.states)
        if (prev.states.get(id) !== record) keys.push(dep.state(id));
      for (const id of prev.states.keys()) if (!next.states.has(id)) keys.push(dep.state(id));
    }
    if (prev.units !== next.units) keys.push(dep.now);
    this.bump(keys, true);
  }

  private bump(keys: string[], always = false): void {
    if (!keys.length && !always) return;
    this.stamp++;
    for (const key of keys) this.changed.set(key, this.stamp);
    this.hostCache = undefined;
    for (const listener of this.listeners) listener();
  }
}
