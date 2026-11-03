// zigbee2mqtt over its own MQTT topics. Devices and their capabilities come from
// <base>/bridge/devices; state from <base>/<friendly_name>; commands go to .../set.

import type {
  Attributes,
  DeviceId,
  EntityId,
  EntityState,
  IntegrationContext,
} from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import {
  connectMqtt,
  type MqttConnect,
  type MqttLink,
  mqttConfigFields,
} from "@casita/mqtt-shared";
import { z } from "zod";
import {
  ATTRIBUTE_PROPERTIES,
  type BridgeDevice,
  bridgeDevice,
  type EntitySpec,
  entitiesFor,
  type Payload,
} from "./exposes.ts";

const configSchema = z.strictObject({
  ...mqttConfigFields,
  baseTopic: z.string().min(1).default("zigbee2mqtt"),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

/** "online" as plain text (older zigbee2mqtt) or {"state":"online"}. */
function isOnline(payload: string): boolean | undefined {
  let state: unknown = payload;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object") state = (parsed as Payload).state;
  } catch {
    // plain text
  }
  return state === "online" ? true : state === "offline" ? false : undefined;
}

interface Tracked {
  friendlyName: string;
  deviceId: DeviceId;
  entities: { id: EntityId; spec: EntitySpec }[];
  release(): void;
}

class Bridge {
  /** Keyed by IEEE address, which survives a rename in zigbee2mqtt. */
  private readonly devices = new Map<string, Tracked>();
  private readonly base: string;

  constructor(
    private readonly ctx: Ctx,
    private readonly link: MqttLink,
  ) {
    this.base = ctx.config.baseTopic;
  }

  /** The full device list, sent on every change: add, update, rename, and remove to match it. */
  devicesChanged(payload: string): void {
    let list: unknown;
    try {
      list = JSON.parse(payload);
    } catch {
      list = undefined;
    }
    if (!Array.isArray(list)) {
      this.ctx.log.warn("ignoring bridge/devices: not a JSON array");
      return;
    }
    const seen = new Set<string>();
    for (const raw of list) {
      const parsed = bridgeDevice.safeParse(raw);
      if (!parsed.success) {
        this.ctx.log.warn("skipping device with unexpected shape", {
          error: parsed.error.issues[0]?.message,
        });
        continue;
      }
      const device = parsed.data;
      if (device.type === "Coordinator" || device.disabled || !device.definition) continue;
      seen.add(device.ieee_address);
      this.track(device);
    }
    for (const [ieee, tracked] of this.devices) {
      if (seen.has(ieee)) continue;
      tracked.release();
      this.ctx.removeDevice(tracked.deviceId);
      this.devices.delete(ieee);
    }
  }

  /** The bridge or the broker went away: nothing is known about any device until it reports. */
  setAllUnavailable(): void {
    for (const tracked of this.devices.values()) {
      for (const { id } of tracked.entities) this.ctx.setAvailable(id, false);
    }
  }

  private track(device: BridgeDevice): void {
    const { ctx, link, base } = this;
    const existing = this.devices.get(device.ieee_address);
    existing?.release();

    const name = device.friendly_name;
    const deviceId: DeviceId = ctx.registerDevice({
      uniqueId: device.ieee_address,
      name,
      manufacturer: device.definition?.vendor,
      model: device.definition?.model,
      firmware: device.software_build_id ?? undefined,
    }).id;

    const topic = `${base}/${name}`;
    const entities = entitiesFor(device).map((spec) => {
      const write = spec.write;
      const entity = ctx.registerEntity(
        {
          uniqueId: `${device.ieee_address}_${spec.key}`,
          domain: spec.domain,
          name: spec.label ? `${name} ${spec.label}` : name,
          deviceId,
          capabilities: spec.capabilities,
        },
        write && (async (command) => link.publish(`${topic}/set`, JSON.stringify(write(command)))),
      );
      return { id: entity.id, spec };
    });

    const subscriptions = [
      link.subscribe(topic, (_topic, payload) => {
        let body: unknown;
        try {
          body = JSON.parse(payload.toString());
        } catch {
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        const attributes: Attributes = {};
        for (const key of ATTRIBUTE_PROPERTIES) {
          if ((body as Payload)[key] !== undefined) attributes[key] = (body as Payload)[key];
        }
        for (const { id, spec } of entities) {
          const state: EntityState | undefined = spec.read(body as Payload);
          if (state) ctx.reportState(id, state, attributes);
        }
      }),
      link.subscribe(`${topic}/availability`, (_topic, payload) => {
        const online = isOnline(payload.toString());
        if (online === undefined) return;
        for (const { id } of entities) ctx.setAvailable(id, online);
      }),
    ];
    this.devices.set(device.ieee_address, {
      friendlyName: name,
      deviceId,
      entities,
      release: () => {
        for (const off of subscriptions) off();
      },
    });

    // Ask for current state rather than waiting for the device's next report.
    const gettable = [...new Set(entities.flatMap((e) => e.spec.gettable))];
    if (gettable.length > 0 && existing?.friendlyName !== name) {
      const request = Object.fromEntries(gettable.map((property) => [property, ""]));
      link.publish(`${topic}/get`, JSON.stringify(request)).catch((err: unknown) => {
        ctx.log.debug("state request failed", {
          device: name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

/** `connect` is injectable so tests can substitute an in-memory broker link. */
export const createZigbee2MqttIntegration = (connect: MqttConnect = connectMqtt()) =>
  defineIntegration({
    id: "zigbee2mqtt",
    name: "Zigbee2MQTT",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const link = await connect(ctx.config, ctx.signal, ctx.log);
      const base = ctx.config.baseTopic;
      const bridge = new Bridge(ctx, link);

      link.onConnectionChange((connected) => {
        if (!connected) bridge.setAllUnavailable();
      });
      link.subscribe(`${base}/bridge/state`, (_topic, payload) => {
        if (isOnline(payload.toString()) === false) bridge.setAllUnavailable();
      });
      link.subscribe(`${base}/bridge/devices`, (_topic, payload) =>
        bridge.devicesChanged(payload.toString()),
      );

      ctx.registerAction(
        "permit_join",
        z.strictObject({ seconds: z.number().int().min(0).max(254).default(120) }),
        async ({ seconds }) => {
          // `time` is what zigbee2mqtt 2.x reads; `value` keeps 1.x working.
          await link.publish(
            `${base}/bridge/request/permit_join`,
            JSON.stringify({ value: seconds > 0, time: seconds }),
          );
          return { permitJoin: seconds > 0, seconds };
        },
      );
    },
  });

export default createZigbee2MqttIntegration();
