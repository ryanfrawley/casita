// Rachio irrigation controllers through Rachio's cloud API. Each enabled zone is a switch
// that runs it; state comes from polling, since webhooks need a publicly reachable server.

import type { EntityId, IntegrationContext } from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import { DAILY_LIMIT, type Fetch, RachioApi, type RachioDevice, RachioError } from "./api.ts";

const configSchema = z.strictObject({
  /** From the Rachio app: Account Settings, Get API Key. */
  apiKey: z.string().min(1),
  /** How often to ask each controller what it is doing. Raised automatically to fit the daily limit. */
  pollSeconds: z.number().int().min(15).default(60),
  /** How long a zone runs when its switch is turned on. */
  defaultRunMinutes: z.number().min(1).max(180).default(10),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

export interface RachioOptions {
  fetch?: Fetch;
  now?: () => number;
  /** How soon after a command to poll again, so its effect shows up promptly. */
  settleMs?: number;
}

/** The controller list changes rarely; refreshing it costs two requests. */
const REFRESH_EVERY_MS = 15 * 60_000;
/** Kept back from the daily limit for commands and restarts. */
const RESERVE = 500;
/** Failed polls in a row before the entities are marked unavailable. */
const MAX_FAILURES = 3;

interface Controller {
  device: RachioDevice;
  zones: { zoneId: string; entityId: EntityId }[];
  enabled: EntityId;
  rainDelay: EntityId;
  rainSensor: EntityId;
  nextRun: EntityId;
  /** The zone that was running at the last poll. */
  running?: string;
}

const everything = (c: Controller): EntityId[] => [
  ...c.zones.map((z) => z.entityId),
  c.enabled,
  c.rainDelay,
  c.rainSensor,
  c.nextRun,
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When the controller will next water on a schedule, as far as its schedules say:
 * "today", "tomorrow", or a weekday, plus Rachio's timing phrase ("end by sunrise").
 * Undefined when no enabled schedule runs on fixed weekdays.
 */
export function nextRun(
  device: RachioDevice,
  now: number,
): { when: string; schedule: string; summary?: string } | undefined {
  // A zone name the runtime does not know falls back to the server's zone, not to an error.
  let timeZone = device.timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    timeZone = undefined;
  }
  const local = (ms: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, ...options }).format(ms);
  const today = WEEKDAYS.indexOf(local(now, { weekday: "short" }));
  const date = (ms: number) => local(ms, { year: "numeric", month: "2-digit", day: "2-digit" });

  let best: { days: number; when: string; schedule: string; summary?: string } | undefined;
  for (const rule of [...device.scheduleRules, ...device.flexScheduleRules]) {
    if (!rule.enabled) continue;
    const weekdays = rule.scheduleJobTypes.flatMap((type) => {
      const match = /^DAY_OF_WEEK_([0-6])$/.exec(type);
      return match ? [Number(match[1])] : [];
    });
    if (weekdays.length === 0) continue;
    // A schedule due today has already run if one of its zones was watered today.
    const ranToday = rule.zones.some((z) => {
      const watered = device.zones.find((zone) => zone.id === z.zoneId)?.lastWateredDate;
      return watered !== undefined && date(watered) === date(now);
    });
    const days = Math.min(
      ...weekdays.map((day) => {
        const ahead = (day - today + 7) % 7;
        return ahead === 0 && ranToday ? 7 : ahead;
      }),
    );
    if (best && best.days <= days) continue;
    const day =
      days === 0
        ? "today"
        : days === 1
          ? "tomorrow"
          : // A week out is the same weekday as today, so say which one is meant.
            `${days === 7 ? "next " : ""}${WEEKDAYS[(today + days) % 7] ?? ""}`;
    const timing = /\b((?:end|start)s? (?:by|at|before|after) .+|at \d.+)$/i.exec(
      rule.summary ?? "",
    )?.[1];
    best = {
      days,
      when: timing ? `${day}, ${timing}` : day,
      schedule: rule.name,
      summary: rule.summary,
    };
  }
  return best && { when: best.when, schedule: best.schedule, summary: best.summary };
}

/** Seconds between polls so that a day of polling `controllers` stays inside the budget. */
export function pollInterval(pollSeconds: number, controllers: number): number {
  const refreshes = (86_400_000 / REFRESH_EVERY_MS) * 2;
  const budget = DAILY_LIMIT - RESERVE - refreshes;
  return Math.max(pollSeconds, Math.ceil((Math.max(1, controllers) * 86_400) / budget));
}

class Account {
  private readonly controllers = new Map<string, Controller>();
  private failures = 0;
  /** Last-watered times are out of date: a run ended and the list has not been re-read since. */
  private stale = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly api: RachioApi,
    private readonly now: () => number,
    private readonly settleMs: number,
  ) {}

  get size(): number {
    return this.controllers.size;
  }

  /** Reads the controllers and zones and registers them. */
  async refresh(): Promise<void> {
    const { ctx, api } = this;
    const devices = await api.devices();
    // Controllers and zones that are gone (removed, or disabled in the app) go from here too.
    for (const [id, old] of this.controllers) {
      const current = devices.find((d) => d.id === id);
      const live = new Set(current?.zones.filter((z) => z.enabled).map((z) => z.id));
      for (const zone of old.zones) if (!live.has(zone.zoneId)) ctx.removeEntity(zone.entityId);
      if (current) continue;
      for (const id of [old.enabled, old.rainDelay, old.rainSensor, old.nextRun])
        ctx.removeEntity(id);
      this.controllers.delete(id);
    }
    for (const device of devices) {
      const deviceId = ctx.registerDevice({
        uniqueId: device.id,
        name: device.name,
        manufacturer: "Rachio",
        model: device.model,
      }).id;
      // What a command changed is read back after it settles: from the schedule, or from the
      // controller list first for a change that only shows there.
      const after = (call: Promise<unknown>, reread = false) =>
        call.then(
          () =>
            void ctx.scheduler.after(this.settleMs, () =>
              reread ? this.rereadAndPoll() : this.poll(),
            ),
        );

      const zones = device.zones
        .filter((zone) => zone.enabled)
        .sort((a, b) => a.zoneNumber - b.zoneNumber)
        .map((zone) => ({
          zoneId: zone.id,
          entityId: ctx.registerEntity(
            { uniqueId: zone.id, domain: "switch", name: `${device.name} ${zone.name}`, deviceId },
            (command) =>
              after(
                command.action === "turn_on"
                  ? api.startZone(zone.id, ctx.config.defaultRunMinutes * 60)
                  : api.stopWater(device.id),
              ),
          ).id,
        }));
      const enabled = ctx.registerEntity(
        {
          uniqueId: `${device.id}-enabled`,
          domain: "switch",
          name: `${device.name} schedules`,
          deviceId,
        },
        // Standby is a field of the controller list, which the poll does not read.
        (command) => after(api.setEnabled(device.id, command.action === "turn_on"), true),
      ).id;
      const rainDelay = ctx.registerEntity({
        uniqueId: `${device.id}-rain-delay`,
        domain: "binary_sensor",
        name: `${device.name} rain delay`,
        deviceId,
      }).id;
      const rainSensor = ctx.registerEntity({
        uniqueId: `${device.id}-rain-sensor`,
        domain: "binary_sensor",
        name: `${device.name} rain sensor`,
        deviceId,
      }).id;
      const next = ctx.registerEntity({
        uniqueId: `${device.id}-next-run`,
        domain: "sensor",
        name: `${device.name} next run`,
        deviceId,
      }).id;
      this.controllers.set(device.id, {
        device,
        zones,
        enabled,
        rainDelay,
        rainSensor,
        nextRun: next,
        running: this.controllers.get(device.id)?.running,
      });
    }
  }

  /** Asks each controller what is running and reports every entity's state. */
  async poll(): Promise<void> {
    const { ctx, api } = this;
    // Carried over from a poll whose re-read failed, so it is tried again.
    let stale = this.stale;
    try {
      for (const controller of this.controllers.values()) {
        const { device } = controller;
        if (device.status === "OFFLINE") {
          for (const id of everything(controller)) ctx.setAvailable(id, false);
          continue;
        }
        const schedule = await api.currentSchedule(device.id);
        const running = schedule.status === "PROCESSING" ? schedule.zoneId : undefined;
        for (const zone of controller.zones) {
          const on = zone.zoneId === running;
          const endsAt =
            on && schedule.zoneStartDate && schedule.zoneDuration
              ? schedule.zoneStartDate + schedule.zoneDuration * 1000
              : undefined;
          const details = device.zones.find((z) => z.id === zone.zoneId);
          ctx.reportState(
            zone.entityId,
            { domain: "switch", on },
            {
              endsAt,
              lastWateredAt: details?.lastWateredDate,
              lastWateredSeconds: details?.lastWateredDuration,
            },
          );
        }
        // "Last watered" comes with the controller list, so read that again once a run ends.
        if (controller.running && !running) stale = true;
        controller.running = running;
        ctx.reportState(controller.rainSensor, {
          domain: "binary_sensor",
          on: device.rainSensorTripped === true,
        });
        const next = nextRun(device, this.now());
        ctx.reportState(
          controller.nextRun,
          { domain: "sensor", value: next?.when ?? null },
          { schedule: next?.schedule, summary: next?.summary },
        );
        ctx.reportState(controller.enabled, { domain: "switch", on: device.on });
        const until = device.rainDelayExpirationDate ?? 0;
        ctx.reportState(
          controller.rainDelay,
          { domain: "binary_sensor", on: until > this.now() },
          { until },
        );
      }
      this.failures = 0;
      this.stale = stale;
      if (stale) {
        await this.refresh(); // if this throws, `stale` stays set and the next poll tries again
        this.stale = false;
        await this.poll();
      }
    } catch (err) {
      this.failed(err);
    }
  }

  /** Reads the controller list again, then reports; a failed read counts as a failed poll. */
  async rereadAndPoll(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.failed(err);
      return;
    }
    await this.poll();
  }

  failed(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.failures++;
    this.ctx.log.warn("Rachio poll failed", { error, failures: this.failures });
    // One missed poll says nothing about the controllers; several mean their state is unknown.
    if (this.failures !== MAX_FAILURES && !(err instanceof RachioError && err.retryAt)) return;
    for (const c of this.controllers.values()) {
      for (const id of everything(c)) this.ctx.setAvailable(id, false);
    }
  }

  /** The controller named, or the only one. */
  controller(deviceId: string | undefined): Controller {
    const found = deviceId
      ? this.controllers.get(deviceId)
      : this.controllers.size === 1
        ? [...this.controllers.values()][0]
        : undefined;
    if (!found) {
      const ids = [...this.controllers.values()]
        .map((c) => `${c.device.name} (${c.device.id})`)
        .join(", ");
      throw new Error(
        deviceId ? `Unknown controller ${deviceId}` : `Say which controller with deviceId: ${ids}`,
      );
    }
    return found;
  }

  zoneId(entityId: string): string {
    for (const c of this.controllers.values()) {
      const zone = c.zones.find((z) => z.entityId === entityId);
      if (zone) return zone.zoneId;
    }
    throw new Error(`${entityId} is not a Rachio zone`);
  }
}

/** `fetch` and the clock are injectable for tests. */
export const createRachioIntegration = (options: RachioOptions = {}) =>
  defineIntegration({
    id: "rachio",
    name: "Rachio",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const now = options.now ?? Date.now;
      const api = new RachioApi(ctx.config.apiKey, options.fetch, now);
      const account = new Account(ctx, api, now, options.settleMs ?? 3000);

      // A bad key or an unreachable API rejects setup; the host retries with backoff.
      await account.refresh();
      await account.poll();

      // Worked out again before every wait, since controllers can be added to the account.
      const interval = () => pollInterval(ctx.config.pollSeconds, account.size);
      const seconds = interval();
      if (seconds > ctx.config.pollSeconds) {
        ctx.log.info("polling slower than configured to stay inside Rachio's daily limit", {
          seconds,
        });
      }
      const pollLater = () => {
        ctx.scheduler.after(interval() * 1000, async () => {
          await account.poll();
          pollLater();
        });
      };
      pollLater();
      ctx.scheduler.every(REFRESH_EVERY_MS, () =>
        account.refresh().catch((err) => account.failed(err)),
      );

      const settle = <T>(result: T): T => {
        ctx.scheduler.after(options.settleMs ?? 3000, () => account.poll());
        return result;
      };
      ctx.registerAction(
        "run_zone",
        z.strictObject({ entityId: z.string(), minutes: z.number().min(1).max(180) }),
        async ({ entityId, minutes }) => {
          await api.startZone(account.zoneId(entityId), minutes * 60);
          return settle({ entityId, minutes });
        },
      );
      ctx.registerAction(
        "stop_water",
        z.strictObject({ deviceId: z.string().optional() }),
        async ({ deviceId }) => {
          await api.stopWater(account.controller(deviceId).device.id);
          return settle({});
        },
      );
      ctx.registerAction(
        "rain_delay",
        z.strictObject({ deviceId: z.string().optional(), hours: z.number().min(0).max(168) }),
        async ({ deviceId, hours }) => {
          const controller = account.controller(deviceId);
          await api.rainDelay(controller.device.id, hours * 3600);
          // The delay's end comes from the controller list, so read that again.
          await account.refresh();
          return settle({ hours });
        },
      );
      ctx.registerAction("status", z.strictObject({}), async () => ({
        controllers: account.size,
        pollSeconds: interval(),
        requestsRemainingToday: api.remaining ?? null,
      }));
    },
  });

export default createRachioIntegration();
