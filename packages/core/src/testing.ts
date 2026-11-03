// Shared fixtures for core unit tests.

import { Bus } from "./bus.ts";
import { openDatabase } from "./db/index.ts";
import { Registry } from "./registry.ts";
import { StateStore } from "./state.ts";
import type { CoreEvent } from "./types.ts";

export async function createCore() {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const db = await openDatabase(":memory:");
  const bus = new Bus();
  const events: CoreEvent[] = [];
  bus.onAny((e) => events.push(e));
  const registry = new Registry({ db, bus, now });
  const states = new StateStore({ db, registry, bus, now });
  return { clock, now, db, bus, events, registry, states };
}
