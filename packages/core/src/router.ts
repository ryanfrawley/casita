// core/router.ts
// The single path every command takes: resolve → availability → normalize →
// validate → policies → per-entity queue → dispatch → (optional) confirm.

import type {
  AreaId,
  Command,
  CommandErrorCode,
  CommandHandler,
  CommandResult,
  CommandSource,
  Domain,
  Entity,
  EntityId,
  EventBus,
  SendOptions,
  StateRecord,
} from "./types.ts";
import { errorMessage } from "./util.ts";

export type { CommandErrorCode, CommandResult, SendOptions };

// ───────────────────────── Dependencies (narrow views of core services) ─────────────────────────

export interface RegistryView {
  getEntity(id: EntityId): Entity | undefined;
  /** The current id when `id` is an unexpired rename alias. */
  aliasTarget(id: EntityId): EntityId | undefined;
  entitiesInArea(areaId: AreaId): Entity[];
}

export interface StateView {
  get(id: EntityId): StateRecord | undefined;
}

export interface RouterOptions {
  registry: RegistryView;
  states: StateView;
  bus: EventBus;
  handlerTimeoutMs?: number; // how long an integration gets to deliver a command
  confirmTimeoutMs?: number; // how long to wait for a matching state report
  /** Per-domain overrides. Garage openers warn (beep/flash) ~5 s before moving and only report motion after. */
  confirmTimeoutsMs?: Partial<Record<Domain, number>>;
}

// ───────────────────────── Results and errors ─────────────────────────

export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export type AreaCommandOutcome =
  | { entityId: EntityId; result: CommandResult }
  | { entityId: EntityId; error: { code: CommandErrorCode; message: string } };

// ───────────────────────── Policies (middleware) ─────────────────────────

export interface PolicyContext {
  entity: Entity;
  command: Command;
  source: CommandSource;
  state: StateRecord;
}

/** Throw a CommandError (usually "forbidden") to reject. */
export type CommandPolicy = (ctx: PolicyContext) => void | Promise<void>;

// ───────────────────────── Router ─────────────────────────

type Job = {
  entity: Entity;
  command: Command;
  source: CommandSource;
  resolve: (r: CommandResult) => void;
  reject: (e: unknown) => void;
};

/** One in-flight command per entity, plus at most one waiting ("latest wins"). */
type Lane = { running: boolean; next?: Job };

export class CommandRouter {
  private readonly handlers = new Map<EntityId, CommandHandler>();
  private readonly lanes = new Map<EntityId, Lane>();
  private readonly policies: CommandPolicy[] = [];
  private readonly handlerTimeoutMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly confirmTimeoutsMs: Partial<Record<Domain, number>>;

  constructor(private readonly deps: RouterOptions) {
    this.handlerTimeoutMs = deps.handlerTimeoutMs ?? 10_000;
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? 5_000;
    this.confirmTimeoutsMs = { cover: 10_000, ...deps.confirmTimeoutsMs };
  }

  /** Called by the integration host when an integration registers an entity. */
  registerHandler(id: EntityId, handler: CommandHandler): () => void {
    this.handlers.set(id, handler);
    return () => {
      if (this.handlers.get(id) === handler) this.handlers.delete(id);
    };
  }

  handlerFor(id: EntityId): CommandHandler | undefined {
    return this.handlers.get(id);
  }

  use(policy: CommandPolicy): void {
    this.policies.push(policy);
  }

  async send(
    id: EntityId,
    command: Command,
    source: CommandSource,
    opts: SendOptions = {},
  ): Promise<CommandResult> {
    const entity = this.resolve(id, command);

    const state = this.deps.states.get(id);
    if (!state?.available) {
      throw new CommandError("unavailable", `${id} is unavailable`);
    }

    const normalized = normalize(command, entity, state);
    validate(normalized, entity);

    for (const policy of this.policies) {
      await policy({ entity, command: normalized, source, state });
    }

    // Subscribe before dispatch so a fast state report can't slip past us.
    const confirmation = opts.confirm ? this.awaitConfirmation(id, normalized) : undefined;

    try {
      const result = await this.enqueue(entity, normalized, source);
      if (!confirmation) return result;
      const confirmed = await confirmation.promise;
      return { ...result, status: confirmed ? "confirmed" : "unconfirmed" };
    } finally {
      confirmation?.cancel();
    }
  }

  /**
   * Fan a command out to every matching entity in an area. Failures don't stop the others.
   * `only` narrows the targets further (the API uses it to hide entities a user cannot see).
   */
  async sendToArea(
    areaId: AreaId,
    command: Command,
    source: CommandSource,
    opts: SendOptions = {},
    only: (entity: Entity) => boolean = () => true,
  ): Promise<AreaCommandOutcome[]> {
    const targets = this.deps.registry
      .entitiesInArea(areaId)
      .filter((e) => e.domain === command.domain && !e.disabled && only(e));
    return Promise.all(
      targets.map(async (e): Promise<AreaCommandOutcome> => {
        try {
          return { entityId: e.id, result: await this.send(e.id, command, source, opts) };
        } catch (err) {
          const error =
            err instanceof CommandError ? err : new CommandError("failed", errorMessage(err));
          return { entityId: e.id, error: { code: error.code, message: error.message } };
        }
      }),
    );
  }

  // ───────── internals ─────────

  private resolve(id: EntityId, command: Command): Entity {
    const entity = this.deps.registry.getEntity(id);
    if (!entity) {
      const renamedTo = this.deps.registry.aliasTarget(id);
      throw new CommandError(
        "not_found",
        renamedTo ? `${id} was renamed to ${renamedTo}` : `Unknown entity ${id}`,
      );
    }
    if (entity.disabled) throw new CommandError("disabled", `${id} is disabled`);
    if (entity.domain !== command.domain) {
      throw new CommandError(
        "domain_mismatch",
        `${id} is a ${entity.domain}, not a ${command.domain}`,
      );
    }
    return entity;
  }

  private enqueue(entity: Entity, command: Command, source: CommandSource): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let lane = this.lanes.get(entity.id);
      if (!lane) {
        lane = { running: false };
        this.lanes.set(entity.id, lane);
      }
      // Latest wins: a newer command replaces one that hasn't started yet.
      lane.next?.reject(new CommandError("superseded", "Replaced by a newer command"));
      lane.next = { entity, command, source, resolve, reject };
      if (!lane.running) void this.drain(entity.id, lane);
    });
  }

  private async drain(id: EntityId, lane: Lane): Promise<void> {
    lane.running = true;
    while (lane.next) {
      const job = lane.next;
      lane.next = undefined;
      try {
        job.resolve(await this.dispatch(job));
      } catch (err) {
        job.reject(err);
      }
    }
    lane.running = false;
    this.lanes.delete(id);
  }

  private async dispatch(job: Job): Promise<CommandResult> {
    const { entity, command, source } = job;
    const handler = this.handlers.get(entity.id);
    if (!handler) throw new CommandError("unsupported", `${entity.id} does not accept commands`);

    this.deps.bus.emit({ type: "command_issued", entityId: entity.id, command, source });
    const started = Date.now();

    try {
      await withTimeout(handler(command), this.handlerTimeoutMs);
    } catch (err) {
      const error =
        err instanceof CommandError
          ? err
          : new CommandError("failed", err instanceof Error ? err.message : String(err));
      this.deps.bus.emit({
        type: "command_failed",
        entityId: entity.id,
        command,
        source,
        code: error.code,
        error: error.message,
      });
      throw error;
    }

    return { entityId: entity.id, command, status: "sent", latencyMs: Date.now() - started };
  }

  private awaitConfirmation(id: EntityId, command: Command) {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ms = this.confirmTimeoutsMs[command.domain] ?? this.confirmTimeoutMs;
    const promise = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      off = this.deps.bus.on("state_changed", (e) => {
        if (e.entityId === id && satisfies(command, e.new)) resolve(true);
      });
    });

    return {
      promise,
      cancel: () => {
        off();
        if (timer) clearTimeout(timer);
      },
    };
  }
}

// ───────────────────────── Normalization ─────────────────────────

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function normalize(command: Command, entity: Entity, record: StateRecord): Command {
  const caps = entity.capabilities;
  const state = record.state;

  switch (command.domain) {
    case "switch": {
      if (command.action !== "toggle") return command;
      const on = state.domain === "switch" && state.on;
      return { domain: "switch", action: on ? "turn_off" : "turn_on" };
    }

    case "light": {
      if (command.action === "turn_off") {
        return caps.transition ? command : { domain: "light", action: "turn_off" };
      }
      if (command.brightness !== undefined && command.brightness <= 0) {
        return {
          domain: "light",
          action: "turn_off",
          transitionMs: caps.transition ? command.transitionMs : undefined,
        };
      }
      return {
        ...command,
        brightness: command.brightness === undefined ? undefined : clamp(command.brightness, 0, 1),
        colorTempK:
          command.colorTempK === undefined || !caps.colorTemp
            ? command.colorTempK
            : clamp(command.colorTempK, caps.colorTemp.minK, caps.colorTemp.maxK),
        transitionMs: caps.transition ? command.transitionMs : undefined,
      };
    }

    case "cover":
      return command.action === "set_position"
        ? { ...command, position: clamp(command.position, 0, 1) }
        : command;

    case "climate": {
      if (command.action !== "set_target" || !caps.tempRange) return command;
      const { min, max, step } = caps.tempRange;
      return { ...command, temp: clamp(Math.round(command.temp / step) * step, min, max) };
    }

    default:
      return command;
  }
}

// ───────────────────────── Validation ─────────────────────────

function validate(command: Command, entity: Entity): void {
  const caps = entity.capabilities;
  const unsupported = (what: string) => {
    throw new CommandError("unsupported", `${entity.id} does not support ${what}`);
  };

  if (command.domain === "light" && command.action === "turn_on") {
    if (command.brightness !== undefined && !caps.brightness) unsupported("brightness");
    if (command.colorTempK !== undefined && !caps.colorTemp) unsupported("color temperature");
    if (command.rgb !== undefined && !caps.rgb) unsupported("RGB color");
    if (command.rgb?.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) {
      throw new CommandError("invalid", "RGB values must be integers 0–255");
    }
  }

  if (command.domain === "cover" && command.action === "set_position" && !caps.position) {
    unsupported("positioning");
  }

  if (
    command.domain === "climate" &&
    command.action === "set_target" &&
    !Number.isFinite(command.temp)
  ) {
    throw new CommandError("invalid", "Target temperature must be a number");
  }
}

// ───────────────────────── Confirmation matching ─────────────────────────

function satisfies(command: Command, record: StateRecord): boolean {
  const s = record.state;
  switch (command.domain) {
    case "light":
      if (s.domain !== "light") return false;
      if (command.action === "turn_off") return !s.on;
      if (!s.on) return false;
      return (
        command.brightness === undefined ||
        s.brightness === undefined ||
        Math.abs(s.brightness - command.brightness) < 0.02
      );
    case "switch":
      return s.domain === "switch" && s.on === (command.action === "turn_on");
    case "lock":
      return s.domain === "lock" && s.locked === (command.action === "lock");
    case "cover":
      if (s.domain !== "cover") return false;
      if (command.action === "set_position")
        return s.position !== undefined && Math.abs(s.position - command.position) < 0.02;
      if (command.action === "open") return s.position === 1 || s.motion === "opening";
      if (command.action === "close") return s.position === 0 || s.motion === "closing";
      return s.motion === "stopped";
    case "climate":
      if (s.domain !== "climate") return false;
      return command.action === "set_mode"
        ? s.mode === command.mode
        : s.targetTemp === command.temp;
    case "button":
      return s.domain === "button";
  }
}

// ───────────────────────── Helpers ─────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CommandError("timeout", `No response after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
