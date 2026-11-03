// casa/runtime.ts
// Runs every server handler: a page's, whose triggers are entity state, a schedule or the
// clock, and an automation's, which are nothing else. One registration per page or automation,
// armed on start and again when it changes, through the same bus, scheduler and router.

import type { LoggerFactory } from "../log.ts";
import { createScheduler } from "../scheduler.ts";
import type {
  Area,
  Command,
  CommandResult,
  CommandSource,
  Device,
  Entity,
  EntityId,
  EventBus,
  EventOf,
  StateRecord,
} from "../types.ts";
import { deepEqual, errorMessage } from "../util.ts";
import type { AutomationStore } from "./automations.ts";
import type { CServerHandler, CTrigger } from "./compiled.ts";
import { attributeFields, clock, type Env, equal, evaluate, stateValue } from "./eval.ts";
import { pretending } from "./pretend.ts";
import { run } from "./run.ts";
import type { PageStore } from "./store.ts";
import { duration, type Host, type Value } from "./values.ts";

export interface PageRuntimeDeps {
  pages: PageStore;
  automations: AutomationStore;
  bus: EventBus;
  states: { get(id: EntityId): StateRecord | undefined };
  registry: {
    getEntity(id: EntityId): Entity | undefined;
    listEntities(): Entity[];
    listDevices(): Device[];
    listAreas(): Area[];
  };
  router: {
    send(
      id: EntityId,
      command: Command,
      source: CommandSource,
      opts?: unknown,
    ): Promise<CommandResult>;
  };
  /** What `run` reaches: the integration host. */
  integrations?: {
    runAction(integrationId: string, name: string, params: unknown): Promise<unknown>;
  };
  logFor: LoggerFactory;
  timezone: string;
  now?: () => number;
  /** How many runs each registration remembers; 20 by default. */
  runLog?: number;
}

export type HandlerStatus = "running" | "error" | "stopped";

/** One firing of a handler, or of a timer one left behind, as the editor shows it. */
export interface RunEntry {
  at: number;
  /** Source line of the handler. */
  line: number;
  /** What fired it: `switch.porch changed`, `every 5m`, `at 22:30`, or `after 5m` for a timer. */
  trigger: string;
  calls: { entityId: string; command: Command; error?: string }[];
  /** The integration actions it ran, with `run`. */
  actions: { integrationId: string; action: string; params: unknown; error?: string }[];
  /** Timers this run armed, in ms. */
  armed: number[];
  error?: string;
}

export interface RegisteredInfo {
  /** The command source: `page:home` or `automation:hall_light`. */
  automationId: string;
  status: HandlerStatus;
  error?: string;
  handlers: number;
  lastRunAt?: number;
}

interface RegisterOptions {
  handlers: CServerHandler[];
  /** Off: the handlers stay unarmed and the status is `stopped`. */
  enabled: boolean;
  /** Entity ids the handlers depend on; one that is gone makes the status `error`. */
  entities: string[];
  /** Device ids they look up; the same. */
  devices: string[];
  /**
   * A firing cancels every timer the registration has pending (an automation), or only
   * those its own handler left (a page, where handlers are independent).
   */
  restart: boolean;
}

interface Scope {
  generation: number;
  pending: Set<() => void>;
}

interface Registered {
  key: string;
  abort: AbortController;
  handlers: number;
  /** The handlers as registered, so an unchanged save keeps its timers. */
  compiled: string;
  enabled: boolean;
  entities: string[];
  devices: string[];
  status: HandlerStatus;
  error?: string;
  runs: RunEntry[];
  /** Each handler's firing by its line, for a test run; armed or not. */
  fires: Map<number, Fire>;
}

/** Runs a handler's body now: logged under `trigger`, reading through `host` when given. */
type Fire = (trigger?: string, host?: Host) => Promise<RunEntry | undefined>;

/** What a test run pretends: an entity's value (`sensor.x`) or one attribute (`weather.home#x`). */
export type Pretend = Record<string, Value>;

/** The wording a server handler gets from `present()`: the state as one word or number. */
const plainPresent = (_entity: Entity, record: StateRecord | undefined): string => {
  if (!record?.available) return "Unavailable";
  const value = stateValue(record.state);
  return value === null ? "Unknown" : String(value);
};

const describe = (trigger: CTrigger): string => {
  switch (trigger.kind) {
    case "every":
      return `every ${duration(trigger.ms)}`;
    case "at":
      return `at ${String(Math.floor(trigger.minutes / 60)).padStart(2, "0")}:${String(trigger.minutes % 60).padStart(2, "0")}`;
    case "changed":
      return `${trigger.entity}${trigger.attr ? `.${trigger.attr}` : ""} changed`;
  }
};

const shownValue = (v: Value): string => (typeof v === "string" ? JSON.stringify(v) : String(v));

export class PageRuntime {
  private readonly registered = new Map<string, Registered>();
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: PageRuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    for (const { pageId, handlers } of this.deps.pages.handlers())
      this.registerPage(pageId, handlers);
    for (const automation of this.deps.automations.list()) this.registerAutomation(automation.id);
    const { bus } = this.deps;
    this.offs.push(
      bus.on("page_changed", (e) => {
        const page = this.deps.pages.handlers().find((p) => p.pageId === e.pageId);
        this.registerPage(e.pageId, page?.handlers ?? []);
      }),
      bus.on("automation_changed", (e) => this.registerAutomation(e.automationId)),
      // An entity that goes or comes back changes whether an automation can work.
      bus.on("entity_removed", () => this.recheckEntities()),
      bus.on("entity_renamed", () => this.recheckEntities()),
      bus.on("device_renamed", () => this.recheckEntities()),
      bus.on("entity_added", () => this.recheckEntities()),
    );
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const key of [...this.registered.keys()]) this.unregister(key);
  }

  /** What is registered, for the API and the tests. */
  list(): RegisteredInfo[] {
    return [...this.registered.values()].map((r) => this.info(r));
  }

  /** One registration's status, or undefined when nothing by that key is registered. */
  status(key: string): RegisteredInfo | undefined {
    const r = this.registered.get(key);
    return r ? this.info(r) : undefined;
  }

  /** The remembered runs, newest first. */
  runs(key: string): RunEntry[] {
    return [...(this.registered.get(key)?.runs ?? [])].reverse();
  }

  /**
   * Runs one handler now, as if its trigger had fired, and resolves with the run once its
   * statements have (timers it arms run later, as usual). `pretend` overrides what the
   * handler reads. A registration with one handler needs no line.
   */
  async test(key: string, opts: { line?: number; pretend?: Pretend } = {}): Promise<RunEntry> {
    const entry = this.registered.get(key);
    if (!entry) throw new Error(`Nothing is registered as ${key}`);
    const lines = [...entry.fires.keys()];
    if (!lines.length) throw new Error(`${key} has no handlers`);
    const line = opts.line ?? (lines.length === 1 ? lines[0] : undefined);
    if (line === undefined)
      throw new Error(`Say which handler to test: line ${lines.join(", line ")}`);
    const fire = entry.fires.get(line);
    if (!fire)
      throw new Error(`No handler starts on line ${line}; try line ${lines.join(", line ")}`);
    const pretend = Object.entries(opts.pretend ?? {});
    const label = `test${pretend.length ? `, pretending ${pretend.map(([k, v]) => `${k} = ${shownValue(v)}`).join(", ")}` : ""}`;
    const run = await fire(
      label,
      pretend.length ? pretending(this.host(), opts.pretend ?? {}) : undefined,
    );
    if (!run) throw new Error(`${key} is being replaced; try again`);
    return run;
  }

  registerPage(pageId: string, handlers: CServerHandler[]): void {
    this.register(`page:${pageId}`, {
      handlers,
      enabled: true,
      entities: [],
      devices: [],
      restart: false,
    });
  }

  /** Registers the stored automation, or drops it when the store no longer has it. */
  registerAutomation(id: string): void {
    const key = `automation:${id}`;
    const automation = this.deps.automations.get(id);
    if (!automation) {
      this.unregister(key);
      return;
    }
    this.register(key, {
      handlers: automation.compiled,
      enabled: automation.enabled,
      entities: automation.entities,
      devices: automation.devices,
      restart: true,
    });
  }

  /**
   * Replaces the registration atomically: the old handlers are gone before the new ones
   * listen. Registering what is already registered changes nothing, so a save that left the
   * handlers as they were keeps the timers they have pending.
   */
  register(key: string, opts: RegisterOptions): void {
    const compiled = JSON.stringify(opts.handlers);
    const current = this.registered.get(key);
    if (current && current.compiled === compiled && current.enabled === opts.enabled) {
      current.entities = opts.entities;
      current.devices = opts.devices;
      this.recheck(current);
      return;
    }
    this.drop(key);
    const abort = new AbortController();
    const entry: Registered = {
      key,
      abort,
      handlers: opts.handlers.length,
      compiled,
      enabled: opts.enabled,
      entities: opts.entities,
      devices: opts.devices,
      status: "stopped",
      runs: current?.runs ?? [],
      fires: new Map(),
    };
    this.registered.set(key, entry);
    // A disabled registration listens for nothing, but can still be tested.
    this.arm(entry, opts, opts.enabled);
    if (!opts.enabled) {
      this.setStatus(entry, "stopped");
      return;
    }
    this.setStatus(entry, this.missing(entry) ? "error" : "running", this.missing(entry));
  }

  private arm(entry: Registered, opts: RegisterOptions, listen: boolean): void {
    const { signal } = entry.abort;
    const log = this.deps.logFor({ service: "casa", source: entry.key });
    const scheduler = createScheduler(signal, this.deps.timezone, log);
    const source: CommandSource = { kind: "automation", automationId: entry.key };
    const host = this.host();
    const shared: Scope = { generation: 0, pending: new Set() };

    for (const handler of opts.handlers) {
      const scope: Scope = opts.restart ? shared : { generation: 0, pending: new Set() };
      const fire: Fire = async (trigger, through) => {
        if (signal.aborted) return undefined;
        // A firing cancels what earlier ones left for later, and outranks one still running.
        const generation = ++scope.generation;
        for (const cancel of [...scope.pending]) cancel();
        scope.pending.clear();
        let current = this.remember(entry, handler.line, trigger ?? describe(handler.trigger));
        const first = current;
        const actions = {
          call: async (id: string, command: Command) => {
            const call: RunEntry["calls"][number] = { entityId: id, command };
            current.calls.push(call);
            try {
              await this.deps.router.send(id as EntityId, command, source);
            } catch (err) {
              call.error = errorMessage(err);
              log.error("command refused", {
                line: handler.line,
                entityId: id,
                command,
                error: call.error,
              });
              this.fail(
                entry,
                `line ${handler.line}: ${id} refused ${command.action}: ${call.error}`,
              );
            }
          },
          run: async (integrationId: string, action: string, params: Record<string, unknown>) => {
            const ran: RunEntry["actions"][number] = { integrationId, action, params };
            current.actions.push(ran);
            try {
              const integrations = this.deps.integrations;
              if (!integrations) throw new Error("no integrations here");
              await integrations.runAction(integrationId, action, params);
            } catch (err) {
              ran.error = errorMessage(err);
              log.error("action failed", {
                line: handler.line,
                integrationId,
                action,
                params,
                error: ran.error,
              });
              this.fail(
                entry,
                `line ${handler.line}: ${integrationId} ${action} failed: ${ran.error}`,
              );
            }
          },
          set: () => {},
          after: (ms: number, fn: () => Promise<void>) => {
            // Superseded while a command was in flight: its timers are not wanted.
            if (scope.generation !== generation) return;
            current.armed.push(ms);
            const cancel = scheduler.after(ms, async () => {
              scope.pending.delete(cancel);
              current = this.remember(entry, handler.line, `after ${duration(ms)}`);
              try {
                await fn();
              } catch (err) {
                this.failed(entry, current, handler.line, err, log);
              }
            });
            scope.pending.add(cancel);
          },
        };
        const env: Env = { host: through ?? host, vars: new Map<string, Value>() };
        try {
          await run(handler.body, env, actions);
        } catch (err) {
          this.failed(entry, current, handler.line, err, log);
        }
        return first;
      };
      entry.fires.set(handler.line, fire);
      if (!listen) continue;

      const { trigger } = handler;
      switch (trigger.kind) {
        case "every":
          scheduler.every(trigger.ms, async () => {
            await fire();
          });
          break;
        case "at": {
          const h = Math.floor(trigger.minutes / 60);
          const m = trigger.minutes % 60;
          scheduler.cron(`${m} ${h} * * *`, async () => {
            await fire();
          });
          break;
        }
        case "changed": {
          const off = this.deps.bus.on("state_changed", (e) => {
            if (e.entityId !== trigger.entity) return;
            if (!this.matches(trigger, e, host)) return;
            void fire();
          });
          signal.addEventListener("abort", off, { once: true });
          break;
        }
      }
    }
    if (listen && opts.handlers.length)
      log.info("handlers armed", { handlers: opts.handlers.length });
  }

  /** Disarms and forgets the registration, telling subscribers it stopped. */
  private unregister(key: string): void {
    const current = this.drop(key);
    if (current && current.status !== "stopped") {
      this.deps.bus.emit({ type: "automation_status", automationId: key, status: "stopped" });
    }
  }

  private drop(key: string): Registered | undefined {
    const current = this.registered.get(key);
    if (!current) return undefined;
    current.abort.abort();
    this.registered.delete(key);
    return current;
  }

  private info(r: Registered): RegisteredInfo {
    return {
      automationId: r.key,
      status: r.status,
      error: r.error,
      handlers: r.handlers,
      lastRunAt: r.runs.at(-1)?.at,
    };
  }

  private remember(entry: Registered, line: number, trigger: string): RunEntry {
    const run: RunEntry = { at: this.now(), line, trigger, calls: [], actions: [], armed: [] };
    entry.runs.push(run);
    const keep = this.deps.runLog ?? 20;
    if (entry.runs.length > keep) entry.runs.splice(0, entry.runs.length - keep);
    return run;
  }

  private failed(
    entry: Registered,
    run: RunEntry,
    line: number,
    err: unknown,
    log: { error(msg: string, fields?: Record<string, unknown>): void },
  ): void {
    run.error = errorMessage(err);
    log.error("handler failed", { line, error: run.error });
    this.fail(entry, `line ${line}: ${run.error}`);
  }

  /** Records the error; a running registration keeps running. */
  private fail(entry: Registered, error: string): void {
    entry.error = error;
    this.deps.bus.emit({
      type: "automation_status",
      automationId: entry.key,
      status: entry.status,
      error,
    });
  }

  private setStatus(entry: Registered, status: HandlerStatus, error?: string): void {
    entry.status = status;
    entry.error = error;
    this.deps.bus.emit({ type: "automation_status", automationId: entry.key, status, error });
  }

  /** The reason the registration cannot work, when an entity or device it names is gone. */
  private missing(entry: Registered): string | undefined {
    const { registry } = this.deps;
    const devices = new Set(registry.listDevices().map((d) => d.id as string));
    const gone = [
      ...entry.entities.filter((id) => !registry.getEntity(id as EntityId)),
      ...entry.devices.filter((id) => !devices.has(id)).map((id) => `device.${id}`),
    ];
    if (!gone.length) return undefined;
    return `${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} gone; the automation waits on it`;
  }

  private recheck(entry: Registered): void {
    if (!entry.enabled) return;
    const missing = this.missing(entry);
    const status: HandlerStatus = missing ? "error" : "running";
    if (status !== entry.status || missing !== entry.error) this.setStatus(entry, status, missing);
  }

  private recheckEntities(): void {
    for (const entry of this.registered.values()) this.recheck(entry);
  }

  /** Whether a state change is the one a `changed` trigger waits for. */
  private matches(
    trigger: Extract<CServerHandler["trigger"], { kind: "changed" }>,
    e: EventOf<"state_changed">,
    host: Host,
  ): boolean {
    const env: Env = { host, vars: new Map() };
    if (trigger.attr) {
      const before = e.old ? attributeFields(e.old)[trigger.attr] : undefined;
      const after = attributeFields(e.new)[trigger.attr];
      if (deepEqual(before, after)) return false;
      const to = trigger.to ? evaluate(trigger.to, env) : undefined;
      const from = trigger.from ? evaluate(trigger.from, env) : undefined;
      return (
        (to === undefined || equal(after as Value, to)) &&
        (from === undefined || equal((before ?? null) as Value, from))
      );
    }
    const before = e.old?.available ? stateValue(e.old.state) : null;
    const after = e.new.available ? stateValue(e.new.state) : null;
    // Only the value: an update that touched attributes alone is not a change.
    if (equal(before, after)) return false;
    if (trigger.to !== undefined && !equal(after, evaluate(trigger.to, env))) return false;
    if (trigger.from !== undefined && !equal(before, evaluate(trigger.from, env))) return false;
    return true;
  }

  private host(): Host {
    const { states, registry, timezone } = this.deps;
    return {
      state: (id) => states.get(id as EntityId),
      entity: (id) => registry.getEntity(id as EntityId),
      entities: () => registry.listEntities(),
      devices: () => registry.listDevices(),
      areas: () => registry.listAreas(),
      // Never read: the compiler keeps `screen` out of server handlers.
      screen: () => "Desktop",
      now: () => this.now(),
      timezone,
      present: plainPresent,
      unit: (_entity, record) =>
        record?.state.domain === "sensor" ? (record.state.unit ?? null) : null,
      ago: (ms, now) => {
        const minutes = Math.max(0, Math.round((now - ms) / 60_000));
        if (minutes < 1) return "just now";
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
      },
      when: (ms, format) => {
        const parts = clock(ms, timezone);
        const date = parts.date;
        const time = `${String(Math.floor(parts.minutes / 60)).padStart(2, "0")}:${String(parts.minutes % 60).padStart(2, "0")}`;
        return format === "date" ? date : format === "time" ? time : `${date} ${time}`;
      },
      format: (value, places) => value.toFixed(places),
    };
  }
}
