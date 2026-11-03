// A Qolsys IQ Panel (sold as ADT Command, among others) through its local Control4 interface.
// The panel keeps owning the sensors, arming and the siren; this integration mirrors its zones
// as binary sensors and lets each partition be armed and disarmed.

import type { DeviceId, EntityId, IntegrationContext } from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import { connect, type PanelClient, type PanelEvent } from "./client.ts";
import {
  type ArmMode,
  alarmEvent,
  armedAs,
  armingEvent,
  errorEvent,
  isPlumbing,
  type PanelStatus,
  type Partition,
  parseStatus,
  partition as partitionSchema,
  statusValue,
  summary,
  type Zone,
  zoneEvent,
  zonePatch,
  zone as zoneSchema,
  zoneState,
} from "./mapping.ts";

const configSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().positive().default(12345),
  /** From the panel: Advanced Settings, Installation, Devices, Wi-Fi Devices, 3rd Party Connections, Control4, Reveal Secure Token. */
  token: z.string().min(1),
  /** A user code the panel accepts; the interface needs six-digit codes to be on. */
  userCode: z.string().regex(/^\d{4,6}$/, "A user code is four to six digits"),
  /** How often the panel is asked for its summary, which also keeps the connection alive. */
  pollSeconds: z.number().int().positive().default(60),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

export interface QolsysOptions {
  connectTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

interface TrackedZone {
  deviceId: DeviceId;
  entityId: EntityId;
  zone: Zone;
}

interface TrackedPartition {
  name: string;
  status: PanelStatus;
  /** The mode asked for, to name an exit delay the panel reports without one. */
  pending?: ArmMode;
  entities: { status: EntityId; stay: EntityId; away: EntityId };
}

// Every action carries these; the panel ignores a line without them.
const ENVELOPE = { nonce: "qolsys", source: "C4", version: 1 };

class Panel {
  private readonly zones = new Map<number, TrackedZone>();
  private readonly partitions = new Map<number, TrackedPartition>();
  private deviceId?: DeviceId;
  client?: PanelClient;

  constructor(private readonly ctx: Ctx) {}

  requestSummary(): void {
    this.client?.send({ ...ENVELOPE, action: "INFO", info_type: "SUMMARY", token: this.token });
  }

  private get token(): string {
    return this.ctx.config.token;
  }

  /** Rebuilds every partition and zone from a SUMMARY. */
  apply(raw: z.infer<typeof summary>): void {
    const partitions: Partition[] = [];
    for (const item of raw.partition_list) {
      const parsed = partitionSchema.safeParse(item);
      if (parsed.success) partitions.push(parsed.data);
      else
        this.ctx.log.warn("skipping partition with unexpected shape", {
          error: parsed.error.issues[0]?.message,
        });
    }
    const panel = this.panelDevice();
    const seen = new Set<number>();
    for (const p of partitions) {
      // One partition is the usual case, and then its name ("partition1") says nothing.
      const prefix = partitions.length > 1 ? `${p.name || `Partition ${p.partition_id + 1}`} ` : "";
      this.trackPartition(p, prefix, panel);
      for (const item of p.zone_list) {
        const parsed = zoneSchema.safeParse(item);
        if (!parsed.success) {
          this.ctx.log.warn("skipping zone with unexpected shape", {
            error: parsed.error.issues[0]?.message,
          });
          continue;
        }
        if (isPlumbing(parsed.data)) continue;
        seen.add(parsed.data.zone_id);
        this.trackZone(parsed.data, panel);
      }
    }
    // A zone the summary no longer lists was deleted while we were away.
    for (const [zoneId, tracked] of this.zones) {
      if (seen.has(zoneId)) continue;
      this.ctx.removeDevice(tracked.deviceId);
      this.zones.delete(zoneId);
    }
  }

  private panelDevice(): DeviceId {
    this.deviceId = this.ctx.registerDevice({
      uniqueId: "panel",
      name: "IQ Panel",
      manufacturer: "Qolsys",
      model: "IQ Panel",
    }).id;
    return this.deviceId;
  }

  private trackPartition(p: Partition, prefix: string, deviceId: DeviceId): void {
    const { ctx } = this;
    const id = p.partition_id;
    const unique = (what: string) => `partition-${id}-${what}`;
    const status = ctx.registerEntity({
      uniqueId: unique("status"),
      domain: "sensor",
      name: `${prefix}Alarm`,
      deviceId,
    }).id;
    const armSwitch = (mode: ArmMode, label: string) =>
      ctx.registerEntity(
        { uniqueId: unique(mode), domain: "switch", name: `${prefix}${label}`, deviceId },
        async (command) => {
          const current = this.partitions.get(id);
          const on =
            command.action === "toggle"
              ? !(current && armedAs(current.status, mode))
              : command.action === "turn_on";
          this.arm(id, on ? mode : "disarm");
        },
      ).id;
    const existing = this.partitions.get(id);
    this.partitions.set(id, {
      name: p.name,
      status: parseStatus(p.status),
      pending: existing?.pending,
      entities: {
        status,
        stay: armSwitch("stay", "Armed stay"),
        away: armSwitch("away", "Armed away"),
      },
    });
    this.publishPartition(id, p.status);
  }

  private trackZone(zone: Zone, panel: DeviceId): void {
    const { ctx } = this;
    const name = zone.name || `Zone ${zone.zone_id}`;
    const deviceId = ctx.registerDevice({
      uniqueId: `zone-${zone.zone_id}`,
      name,
      manufacturer: "Qolsys",
      model: zone.type || undefined,
      viaDeviceId: panel,
    }).id;
    const entityId = ctx.registerEntity({
      uniqueId: `zone-${zone.zone_id}`,
      domain: "binary_sensor",
      name,
      deviceId,
    }).id;
    this.zones.set(zone.zone_id, { deviceId, entityId, zone });
    this.publishZone(zone.zone_id);
  }

  private publishZone(zoneId: number): void {
    const tracked = this.zones.get(zoneId);
    if (!tracked) return;
    const { zone } = tracked;
    this.ctx.reportState(tracked.entityId, zoneState(zone), {
      zoneId: zone.zone_id,
      type: zone.type,
      group: zone.group,
      status: zone.status,
    });
  }

  private publishPartition(id: number, raw?: string): void {
    const p = this.partitions.get(id);
    if (!p) return;
    const { status } = p;
    this.ctx.reportState(
      p.entities.status,
      { domain: "sensor", value: statusValue(status) },
      {
        partitionId: id,
        ...(raw ? { status: raw } : {}),
        ...(status.kind === "alarm" && status.alarmType ? { alarmType: status.alarmType } : {}),
      },
    );
    for (const mode of ["stay", "away"] as const)
      this.ctx.reportState(p.entities[mode], { domain: "switch", on: armedAs(status, mode) });
  }

  /** Sends an arming change; the panel reports the outcome as ARMING or ERROR events. */
  arm(partitionId: number, to: ArmMode | "disarm"): void {
    if (!this.client) throw new Error("The panel is not connected");
    const p = this.partitions.get(partitionId);
    if (p) p.pending = to === "disarm" ? undefined : to;
    this.client.send({
      ...ENVELOPE,
      action: "ARMING",
      arming_type: to === "disarm" ? "DISARM" : to === "stay" ? "ARM_STAY" : "ARM_AWAY",
      partition_id: partitionId,
      token: this.token,
      usercode: this.ctx.config.userCode,
    });
  }

  handle(event: PanelEvent): void {
    switch (event.event) {
      case "INFO": {
        const parsed = summary.safeParse(event);
        if (parsed.success) this.apply(parsed.data);
        break;
      }
      case "ZONE_EVENT":
        this.handleZone(event);
        break;
      case "ARMING": {
        const parsed = armingEvent.safeParse(event);
        if (!parsed.success) return;
        const p = this.partitions.get(parsed.data.partition_id);
        if (!p) return;
        const status = parseStatus(parsed.data.arming_type);
        // An exit delay the panel does not name is the one we asked for, if we asked.
        if (status.kind === "arming" && !status.mode) status.mode = p.pending;
        if (status.kind === "armed" || status.kind === "disarmed") p.pending = undefined;
        p.status = status;
        this.publishPartition(parsed.data.partition_id, parsed.data.arming_type);
        break;
      }
      case "ALARM": {
        const parsed = alarmEvent.safeParse(event);
        if (!parsed.success) return;
        const p = this.partitions.get(parsed.data.partition_id);
        if (!p) return;
        p.status = { kind: "alarm", alarmType: parsed.data.alarm_type || undefined };
        this.publishPartition(parsed.data.partition_id, "ALARM");
        break;
      }
      case "ERROR": {
        const parsed = errorEvent.safeParse(event);
        if (!parsed.success) return;
        const p = this.partitions.get(parsed.data.partition_id);
        if (p) p.pending = undefined;
        this.ctx.log.warn("the panel refused a request", {
          type: parsed.data.error_type,
          description: parsed.data.description,
        });
        break;
      }
      default:
        break;
    }
  }

  private handleZone(event: PanelEvent): void {
    const parsed = zoneEvent.safeParse(event);
    if (!parsed.success) return;
    const { zone_event_type: type, zone } = parsed.data;
    const zoneId = zone.zone_id;
    switch (type) {
      case "ZONE_ACTIVE": {
        const tracked = this.zones.get(zoneId);
        if (!tracked || zone.status === undefined) return;
        tracked.zone = { ...tracked.zone, status: zone.status };
        this.publishZone(zoneId);
        break;
      }
      case "ZONE_UPDATE":
      case "ZONE_ADD": {
        const tracked = this.zones.get(zoneId);
        if (!this.deviceId) return;
        if (!tracked) {
          const full = zoneSchema.safeParse(zone);
          if (full.success && !isPlumbing(full.data)) this.trackZone(full.data, this.deviceId);
          return;
        }
        // An update names only what changed; what it leaves out stays.
        const patch = zonePatch.safeParse(zone);
        if (!patch.success) return;
        const changes = Object.fromEntries(
          Object.entries(patch.data).filter(([, value]) => value !== undefined),
        );
        this.trackZone({ ...tracked.zone, ...changes }, this.deviceId);
        break;
      }
      case "ZONE_DELETE": {
        const tracked = this.zones.get(zoneId);
        if (!tracked) return;
        this.ctx.removeDevice(tracked.deviceId);
        this.zones.delete(zoneId);
        break;
      }
      default:
        break;
    }
  }

  setAllUnavailable(): void {
    for (const { entityId } of this.zones.values()) this.ctx.setAvailable(entityId, false);
    for (const p of this.partitions.values())
      for (const id of Object.values(p.entities)) this.ctx.setAvailable(id, false);
  }
}

/** Timing is injectable for tests. */
export const createQolsysIntegration = (options: QolsysOptions = {}) =>
  defineIntegration({
    id: "qolsys",
    name: "Qolsys IQ Panel",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const panel = new Panel(ctx);
      const { host, port } = ctx.config;
      let attempt = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const open = async () => {
        const client = await connect(
          host,
          port,
          {
            onEvent: (event) => panel.handle(event),
            onClose: (error) => {
              ctx.log.warn("panel connection lost", { error: error.message });
              panel.client = undefined;
              panel.setAllUnavailable();
              reconnect();
            },
          },
          options.connectTimeoutMs,
        );
        panel.client = client;
        // The summary arrives as an event and builds the entities.
        panel.requestSummary();
      };
      const reconnect = () => {
        if (ctx.signal.aborted) return;
        const delay = Math.min(
          (options.backoffBaseMs ?? 1000) * 2 ** attempt++,
          options.backoffMaxMs ?? 60_000,
        );
        retry = setTimeout(() => {
          open().then(
            () => {
              attempt = 0;
              ctx.log.info("panel connection restored");
            },
            (err: unknown) => {
              ctx.log.warn("panel unreachable", {
                error: err instanceof Error ? err.message : String(err),
              });
              panel.client?.close();
              panel.client = undefined;
              reconnect();
            },
          );
        }, delay);
      };
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(retry);
        panel.client?.close();
      });

      // If the first connection fails, setup rejects and the host retries it with backoff.
      try {
        await open();
      } catch (err) {
        panel.client?.close();
        throw err;
      }

      ctx.scheduler.every(ctx.config.pollSeconds * 1000, () => panel.requestSummary());
      ctx.registerAction("refresh", z.strictObject({}), async () => {
        if (!panel.client) throw new Error("The panel is not connected");
        panel.requestSummary();
        return {};
      });
    },
  });

export default createQolsysIntegration();
