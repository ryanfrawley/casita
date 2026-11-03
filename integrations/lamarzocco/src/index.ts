// La Marzocco espresso machines through La Marzocco's cloud, the one its app uses. Power and
// steam are switches; "ready" says the coffee boiler is up to temperature. State arrives on the
// dashboard socket within seconds; while the socket is down, the dashboard is polled instead.

import type { EntityId, IntegrationContext } from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import {
  type CommandOutcome,
  type DashboardSocket,
  type Fetch,
  LaMarzoccoCloud,
  LaMarzoccoError,
  type MachineView,
  type OpenSocket,
  openSocket,
  type Thing,
} from "./api.ts";
import { Installation, type StoredInstallation } from "./signing.ts";

const configSchema = z.strictObject({
  /** The La Marzocco app account's email address. */
  username: z.string().min(1),
  password: z.string().min(1),
  /** One machine's serial number; unset takes every coffee machine on the account. */
  serial: z.string().min(1).optional(),
  /** How often to read the dashboard while the live socket is down. */
  pollSeconds: z.number().int().min(15).default(60),
  /** IANA zone for the "ready at" time; unset uses the server's. */
  timeZone: z.string().optional(),
});
type Config = z.infer<typeof configSchema>;
type Ctx = IntegrationContext<Config>;

export interface LaMarzoccoOptions {
  fetch?: Fetch;
  openSocket?: OpenSocket;
  now?: () => number;
  /** How soon after a command to re-read the dashboard when the socket is down. */
  settleMs?: number;
  /** First wait before reconnecting the socket; doubles to `reconnectMaxMs`. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
}

const STORAGE_KEY = "installation";
/** Read even while the socket is live, in case it has gone quiet without closing. */
const LIVE_POLL_MS = 10 * 60_000;
/** Failed reads in a row before the entities are marked unavailable. */
const MAX_FAILURES = 3;

export const isMachine = (thing: Thing) => thing.type === "CoffeeMachine";

/** The cloud's model names are its own ("LINEA MINI 2023" is a Mini R); these are the app's. */
const MODEL_NAMES: Record<string, string> = {
  LINEAMINI: "Linea Mini",
  LINEAMINIR: "Linea Mini R",
  LINEAMICRA: "Linea Micra",
  GS3: "GS3",
  GS3AV: "GS3 AV",
  GS3MP: "GS3 MP",
};

export const modelName = (thing: Thing): string | undefined =>
  MODEL_NAMES[thing.modelCode ?? ""] ?? thing.modelName ?? thing.modelCode ?? undefined;

/** The name given in the app, unless it is only the serial number; then the model's. */
export function machineName(thing: Thing): string {
  const given = thing.name?.trim();
  if (given && given !== thing.serialNumber) return given;
  return modelName(thing) ?? thing.serialNumber;
}

/** "7:42 am" in the given zone, falling back to the server's for a zone it does not know. */
export function clockIn(timeZone: string | undefined): (ms: number) => string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = format(timeZone);
  } catch {
    formatter = format(undefined);
  }
  return (ms) => formatter.format(ms).toLowerCase().replace(/\s/g, " ");
}

/** On unless told to stand by; falls back to what it is doing when the mode is missing. */
export const poweredOn = (view: MachineView): boolean =>
  view.mode !== undefined
    ? view.mode !== "StandBy"
    : view.status !== undefined && !["StandBy", "Off"].includes(view.status);

class Machine {
  readonly power: EntityId;
  readonly ready: EntityId;
  readonly readyAt: EntityId;
  steam?: EntityId;
  steamReady?: EntityId;
  socket?: DashboardSocket;
  private failures = 0;
  /** Counts socket updates, so a dashboard read that overlapped one does not undo it. */
  private pushes = 0;
  private reported = false;
  private reconnectDelay: number;
  private stopPolling?: () => void;
  private readonly clock: (ms: number) => string;
  private readonly deviceId;

  constructor(
    private readonly ctx: Ctx,
    private readonly cloud: LaMarzoccoCloud,
    private readonly options: Required<Omit<LaMarzoccoOptions, "fetch" | "now">>,
    readonly thing: Thing,
  ) {
    const serial = thing.serialNumber;
    const name = machineName(thing);
    this.clock = clockIn(ctx.config.timeZone);
    this.reconnectDelay = options.reconnectMs;
    this.deviceId = ctx.registerDevice({
      uniqueId: serial,
      name,
      manufacturer: "La Marzocco",
      model: modelName(thing),
    }).id;
    const deviceId = this.deviceId;
    this.power = ctx.registerEntity(
      { uniqueId: `${serial}-power`, domain: "switch", name: `${name} power`, deviceId },
      (command) =>
        this.send("CoffeeMachineChangeMode", {
          mode: command.action === "turn_on" ? "BrewingMode" : "StandBy",
        }),
    ).id;
    this.ready = ctx.registerEntity({
      uniqueId: `${serial}-ready`,
      domain: "binary_sensor",
      name: `${name} ready`,
      deviceId,
    }).id;
    this.readyAt = ctx.registerEntity({
      uniqueId: `${serial}-ready-at`,
      domain: "sensor",
      name: `${name} ready at`,
      deviceId,
    }).id;
  }

  get name(): string {
    return machineName(this.thing);
  }

  get live(): boolean {
    return this.socket !== undefined;
  }

  private entities(): EntityId[] {
    return [this.power, this.ready, this.readyAt, this.steam, this.steamReady].filter(
      (id): id is EntityId => id !== undefined,
    );
  }

  /** Steam entities appear with the first dashboard that has a switchable steam boiler. */
  private steamEntities(): void {
    if (this.steam) return;
    const serial = this.thing.serialNumber;
    const deviceId = this.deviceId;
    this.steam = this.ctx.registerEntity(
      { uniqueId: `${serial}-steam`, domain: "switch", name: `${this.name} steam`, deviceId },
      (command) =>
        this.send("CoffeeMachineSettingSteamBoilerEnabled", {
          boilerIndex: 1,
          enabled: command.action === "turn_on",
        }),
    ).id;
    this.steamReady = this.ctx.registerEntity({
      uniqueId: `${serial}-steam-ready`,
      domain: "binary_sensor",
      name: `${this.name} steam ready`,
      deviceId,
    }).id;
  }

  private async send(name: string, body: Record<string, unknown>): Promise<void> {
    await this.cloud.command(this.thing.serialNumber, name, body);
    // With the socket up, the change arrives on it; without, read it back once it settles.
    if (!this.live) this.ctx.scheduler.after(this.options.settleMs, () => this.read());
  }

  report(view: MachineView): void {
    const { ctx } = this;
    if (!view.connected) {
      // Unavailable needs a state to attach to; a machine offline from the start gets its last
      // known one first.
      if (!this.reported) this.reportStates(view);
      for (const id of this.entities()) ctx.setAvailable(id, false);
      return;
    }
    this.reportStates(view);
  }

  private reportStates(view: MachineView): void {
    const { ctx } = this;
    this.reported = true;
    const coffee = view.coffee;
    ctx.reportState(
      this.power,
      { domain: "switch", on: poweredOn(view) },
      {
        status: view.status,
        mode: view.mode,
        brewing: view.status === "Brewing",
        brewingSince: view.brewingSince,
        targetTemperature: coffee?.targetTemperature,
        noWater: view.noWater,
      },
    );
    ctx.reportState(
      this.ready,
      { domain: "binary_sensor", on: coffee?.status === "Ready" },
      { boiler: coffee?.status },
    );
    const heatingUntil =
      coffee?.status === "HeatingUp" && coffee.readyAt !== undefined ? coffee.readyAt : undefined;
    ctx.reportState(
      this.readyAt,
      { domain: "sensor", value: heatingUntil === undefined ? null : this.clock(heatingUntil) },
      { at: heatingUntil, boiler: coffee?.status },
    );

    const steam = view.steam;
    if (steam?.enabledSupported) this.steamEntities();
    if (steam && this.steam && this.steamReady) {
      ctx.reportState(
        this.steam,
        { domain: "switch", on: steam.enabled },
        { status: steam.status, targetLevel: steam.targetLevel, at: steam.readyAt },
      );
      ctx.reportState(
        this.steamReady,
        { domain: "binary_sensor", on: steam.status === "Ready" },
        { boiler: steam.status },
      );
    }
  }

  /** Reads the dashboard and reports it; a failure counts toward unavailability. */
  async read(): Promise<void> {
    const pushes = this.pushes;
    try {
      const { view } = await this.cloud.dashboard(this.thing.serialNumber);
      this.failures = 0;
      // The socket said something newer while this read was in flight.
      if (this.pushes !== pushes) return;
      this.report(view);
    } catch (err) {
      this.failed(err);
    }
  }

  failed(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.failures++;
    this.ctx.log.warn("La Marzocco dashboard read failed", {
      serial: this.thing.serialNumber,
      error,
      failures: this.failures,
    });
    // One missed read says nothing about the machine; several mean its state is unknown,
    // unless the socket is still delivering it.
    const auth = err instanceof LaMarzoccoError && err.auth;
    if (auth || (this.failures === MAX_FAILURES && !this.live)) {
      for (const id of this.entities()) this.ctx.setAvailable(id, false);
    }
  }

  /** Polls at the fallback rate while the socket is down, and rarely while it is up. */
  schedulePoll(): void {
    this.stopPolling?.();
    const ms = this.live ? LIVE_POLL_MS : this.ctx.config.pollSeconds * 1000;
    this.stopPolling = this.ctx.scheduler.every(ms, () => this.read());
  }

  async connect(): Promise<void> {
    const { ctx } = this;
    if (ctx.signal.aborted) return;
    try {
      this.socket = await this.cloud.connectDashboard(
        this.thing.serialNumber,
        {
          onUpdate: (view, commands) => {
            // Backoff resets once the cloud has actually sent something, not on CONNECTED:
            // a subscription it refuses would otherwise retry at the shortest wait for ever.
            this.reconnectDelay = this.options.reconnectMs;
            if (view) {
              this.pushes++;
              this.failures = 0;
              this.report(view);
            }
            this.outcomes(commands);
          },
          onUnreadable: (detail) =>
            ctx.log.warn("part of a La Marzocco socket message was not understood", {
              serial: this.thing.serialNumber,
              detail,
            }),
          onClose: (error) => {
            this.socket = undefined;
            if (ctx.signal.aborted) return;
            ctx.log.info("La Marzocco socket closed; polling until it is back", {
              serial: this.thing.serialNumber,
              error: error.message,
            });
            this.schedulePoll();
            this.reconnectLater();
          },
        },
        this.options.openSocket,
        undefined,
        ctx.signal,
      );
    } catch (err) {
      if (ctx.signal.aborted) return;
      ctx.log.warn("cannot open La Marzocco's live socket; polling instead", {
        serial: this.thing.serialNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      this.reconnectLater();
      return;
    }
    if (ctx.signal.aborted) {
      this.socket.close();
      this.socket = undefined;
      return;
    }
    this.schedulePoll();
    // Changes made while it was down arrive only on the next change; read them now.
    await this.read();
  }

  private reconnectLater(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, this.options.reconnectMaxMs);
    this.ctx.scheduler.after(delay, () => this.connect());
  }

  /** A command the machine did not carry out is logged, and its state read back. */
  private outcomes(commands: CommandOutcome[]): void {
    let failed = false;
    for (const c of commands) {
      if (c.status !== "Error" && c.status !== "Failed" && c.status !== "Timeout") continue;
      this.ctx.log.warn("the machine did not carry out a command", {
        serial: this.thing.serialNumber,
        status: c.status,
        errorCode: c.errorCode,
      });
      failed = true;
    }
    if (failed) void this.read();
  }

  close(): void {
    this.stopPolling?.();
    this.socket?.close();
    this.socket = undefined;
  }
}

/** The installation's key, made and registered with the cloud on first use. */
async function installation(
  ctx: Ctx,
  fetch?: Fetch,
  now?: () => number,
): Promise<{ key: Installation; justRegistered: boolean }> {
  let stored = await ctx.storage.get<StoredInstallation>(STORAGE_KEY);
  if (!stored) {
    stored = Installation.generate();
    await ctx.storage.set(STORAGE_KEY, stored);
  }
  const key = new Installation(stored);
  if (!stored.registered) {
    await new LaMarzoccoCloud(ctx.config.username, ctx.config.password, key, fetch, now).register();
    await ctx.storage.set(STORAGE_KEY, { ...stored, registered: true });
    ctx.log.info("registered with La Marzocco's cloud", { installationId: key.id });
  }
  return { key, justRegistered: !stored.registered };
}

/** `fetch`, the socket and the clock are injectable for tests. */
export const createLaMarzoccoIntegration = (options: LaMarzoccoOptions = {}) =>
  defineIntegration({
    id: "lamarzocco",
    name: "La Marzocco",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const { username, password, serial } = ctx.config;
      let { key, justRegistered } = await installation(ctx, options.fetch, options.now);
      let cloud = new LaMarzoccoCloud(username, password, key, options.fetch, options.now);

      // Bad credentials or an unreachable cloud reject setup; the host retries with backoff.
      let all: Thing[];
      try {
        all = await cloud.things();
      } catch (err) {
        if (!(err instanceof LaMarzoccoError && err.signIn) || justRegistered) throw err;
        // The cloud answers a forgotten key as it does a wrong password: register a new key
        // once, and if sign-in still fails, it is the password.
        ctx.log.info("La Marzocco refused the sign-in; registering this installation again");
        await ctx.storage.delete(STORAGE_KEY);
        ({ key, justRegistered } = await installation(ctx, options.fetch, options.now));
        cloud = new LaMarzoccoCloud(username, password, key, options.fetch, options.now);
        all = await cloud.things();
      }
      const things = all.filter(isMachine);
      const chosen = serial ? things.filter((t) => t.serialNumber === serial) : things;
      if (chosen.length === 0) {
        throw new Error(
          serial
            ? `No coffee machine ${serial} on this La Marzocco account (it has: ${things.map((t) => t.serialNumber).join(", ") || "none"})`
            : "No coffee machines on this La Marzocco account",
        );
      }

      const resolved = {
        openSocket: options.openSocket ?? openSocket,
        settleMs: options.settleMs ?? 3000,
        reconnectMs: options.reconnectMs ?? 5000,
        reconnectMaxMs: options.reconnectMaxMs ?? 5 * 60_000,
      };
      const machines = chosen.map((thing) => new Machine(ctx, cloud, resolved, thing));
      ctx.signal.addEventListener("abort", () => {
        for (const m of machines) m.close();
      });

      for (const machine of machines) {
        const { view } = await cloud.dashboard(machine.thing.serialNumber);
        machine.report(view);
        machine.schedulePoll();
        // The socket comes up in the background; until it does, polling covers.
        void machine.connect();
      }

      const pick = (s: string | undefined) => {
        const found = s
          ? machines.find((m) => m.thing.serialNumber === s)
          : machines.length === 1
            ? machines[0]
            : undefined;
        if (!found)
          throw new Error(
            s
              ? `Unknown machine ${s}`
              : `Say which machine with serial: ${machines.map((m) => m.thing.serialNumber).join(", ")}`,
          );
        return found;
      };
      ctx.registerAction(
        "refresh",
        z.strictObject({ serial: z.string().optional() }),
        async ({ serial }) => {
          await pick(serial).read();
          return {};
        },
      );
      ctx.registerAction("status", z.strictObject({}), async () => ({
        installationId: key.id,
        machines: machines.map((m) => ({
          serial: m.thing.serialNumber,
          model: modelName(m.thing),
          live: m.live,
        })),
      }));
    },
  });

export default createLaMarzoccoIntegration();
