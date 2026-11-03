// Generic MQTT: devices that announce themselves with the MQTT discovery convention
// (<prefix>/<component>/<id>/config), as Tasmota, Shelly, and many DIY devices do.

import type {
  BinarySensorState,
  Capabilities,
  CoverState,
  DeviceId,
  EntityId,
  EntityState,
  IntegrationContext,
  SensorState,
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
  compileTemplate,
  type Discovered,
  type DiscoveryConfig,
  parseDiscovery,
} from "./discovery.ts";

const configSchema = z.strictObject({
  ...mqttConfigFields,
  /** Devices that publish under "homeassistant/" must be repointed, or this set to match. */
  discoveryPrefix: z.string().min(1).default("casita"),
});
type Config = z.infer<typeof configSchema>;
type Ctx = IntegrationContext<Config>;

const SENSOR_CLASSES = [
  "temperature",
  "humidity",
  "power",
  "energy",
  "illuminance",
  "battery",
] as const;
const BINARY_CLASSES = ["motion", "occupancy", "door", "window", "leak", "smoke"] as const;

const known = <T extends string>(
  classes: readonly T[],
  value: string | null | undefined,
): T | undefined => classes.find((c) => c === value);

/** A device payload as text; objects (from a template) are not a usable value. */
const text = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** One discovered entity: its registration, its topic subscriptions, and its availability. */
interface Tracked {
  entityId: EntityId;
  /** Unsubscribes every topic this entity listens on. */
  release(): void;
  /** What each of the device's availability topics last said. */
  online: Map<string, boolean>;
}

class Discovery {
  private readonly tracked = new Map<string, Tracked>();

  constructor(
    private readonly ctx: Ctx,
    private readonly link: MqttLink,
  ) {}

  handle(topic: string, payload: Buffer): void {
    let discovered: Discovered | undefined;
    try {
      discovered = parseDiscovery(this.ctx.config.discoveryPrefix, topic, payload.toString());
      if (!discovered) return;
      this.forget(discovered.key, discovered.config === null);
      if (discovered.config)
        this.tracked.set(discovered.key, this.add(discovered, discovered.config));
    } catch (err) {
      // An unusable config skips that one entity; discovery of the rest carries on.
      this.ctx.log.warn("skipping discovered entity", {
        topic,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The broker is gone or back; without it nothing is known about any device. */
  connectionChanged(connected: boolean): void {
    if (connected) return; // retained state and availability arrive again after the re-subscribe
    for (const entry of this.tracked.values()) {
      entry.online.clear();
      this.ctx.setAvailable(entry.entityId, false);
    }
  }

  private forget(key: string, remove: boolean): void {
    const entry = this.tracked.get(key);
    if (!entry) return;
    entry.release();
    this.tracked.delete(key);
    if (remove) this.ctx.removeEntity(entry.entityId);
  }

  private add({ component, key, objectId }: Discovered, config: DiscoveryConfig): Tracked {
    const { ctx, link } = this;
    const subscriptions: (() => void)[] = [];
    const listen = (topic: string, handler: (payload: string) => void) =>
      subscriptions.push(link.subscribe(topic, (_topic, payload) => handler(payload.toString())));
    const publish = async (topic: string | undefined, payload: string) => {
      if (!topic) throw new Error("This device has no topic for that command");
      await link.publish(topic, payload);
    };
    const extract = compileTemplate(config.value_template);

    const name = config.name ?? config.device?.name ?? objectId;
    const base = { uniqueId: config.unique_id ?? key, name, deviceId: this.device(config) };
    let entityId: EntityId;
    const report = (state: EntityState) => ctx.reportState(entityId, state);

    switch (component) {
      case "switch": {
        const stateTopic = requireTopic(config.state_topic, "state_topic");
        entityId = ctx.registerEntity({ ...base, domain: "switch" }, (command) =>
          publish(
            config.command_topic,
            command.action === "turn_on" ? config.payload_on : config.payload_off,
          ),
        ).id;
        listen(stateTopic, (payload) => {
          const on = onOff(text(extract(payload)), config);
          if (on !== undefined) report({ domain: "switch", on });
        });
        break;
      }

      case "light": {
        if (config.schema && config.schema !== "default" && config.schema !== "basic") {
          throw new Error(`light schema "${config.schema}" is not supported`);
        }
        const stateTopic = requireTopic(config.state_topic, "state_topic");
        const brightnessOf = compileTemplate(config.brightness_value_template);
        const capabilities: Capabilities = {
          brightness: config.brightness_command_topic ? true : undefined,
        };
        let on: boolean | undefined;
        let brightness: number | undefined;
        const reportLight = () => {
          if (on !== undefined) report({ domain: "light", on, brightness });
        };
        entityId = ctx.registerEntity(
          { ...base, domain: "light", capabilities },
          async (command) => {
            if (command.action === "turn_off")
              return publish(config.command_topic, config.payload_off);
            if (command.brightness !== undefined) {
              const scaled = Math.max(1, Math.round(command.brightness * config.brightness_scale));
              await publish(config.brightness_command_topic, String(scaled));
            }
            await publish(config.command_topic, config.payload_on);
          },
        ).id;
        listen(stateTopic, (payload) => {
          on = onOff(text(extract(payload)), config) ?? on;
          reportLight();
        });
        if (config.brightness_state_topic) {
          listen(config.brightness_state_topic, (payload) => {
            const value = Number(text(brightnessOf(payload)));
            if (!Number.isFinite(value)) return;
            brightness = clamp01(value / config.brightness_scale);
            reportLight();
          });
        }
        break;
      }

      case "sensor": {
        const stateTopic = requireTopic(config.state_topic, "state_topic");
        entityId = ctx.registerEntity({ ...base, domain: "sensor" }).id;
        listen(stateTopic, (payload) => {
          const raw = text(extract(payload));
          if (raw === undefined) return;
          const numeric = raw.trim() === "" ? Number.NaN : Number(raw);
          const state: SensorState = {
            domain: "sensor",
            value: Number.isFinite(numeric) ? numeric : raw,
            unit: config.unit_of_measurement ?? undefined,
            deviceClass: known(SENSOR_CLASSES, config.device_class),
          };
          report(state);
        });
        break;
      }

      case "binary_sensor": {
        const stateTopic = requireTopic(config.state_topic, "state_topic");
        entityId = ctx.registerEntity({ ...base, domain: "binary_sensor" }).id;
        listen(stateTopic, (payload) => {
          const on = onOff(text(extract(payload)), config);
          if (on === undefined) return;
          const state: BinarySensorState = {
            domain: "binary_sensor",
            on,
            deviceClass: known(BINARY_CLASSES, config.device_class),
          };
          report(state);
        });
        break;
      }

      case "cover": {
        if (!config.state_topic && !config.position_topic)
          throw new Error("no state_topic or position_topic");
        const capabilities: Capabilities = {
          position: config.set_position_topic ? true : undefined,
        };
        let motion: CoverState["motion"] | undefined = config.state_topic ? undefined : "stopped";
        let position: number | undefined;
        const reportCover = () => {
          if (motion !== undefined) report({ domain: "cover", motion, position });
        };
        entityId = ctx.registerEntity({ ...base, domain: "cover", capabilities }, (command) => {
          switch (command.action) {
            case "open":
              return publish(config.command_topic, config.payload_open);
            case "close":
              return publish(config.command_topic, config.payload_close);
            case "stop":
              return publish(config.command_topic, config.payload_stop);
            case "set_position":
              return publish(config.set_position_topic, String(Math.round(command.position * 100)));
          }
        }).id;
        if (config.state_topic) {
          listen(config.state_topic, (payload) => {
            const value = text(extract(payload))?.toLowerCase();
            if (value === "opening" || value === "closing") motion = value;
            else if (value === "open" || value === "closed" || value === "stopped") {
              motion = "stopped";
              // Without a position topic, open and closed are the only positions known.
              if (!config.position_topic && value !== "stopped")
                position = value === "open" ? 1 : 0;
            } else return;
            reportCover();
          });
        }
        if (config.position_topic) {
          listen(config.position_topic, (payload) => {
            const value = Number(payload);
            if (!Number.isFinite(value) || payload.trim() === "") return;
            position = clamp01(value / 100);
            reportCover();
          });
        }
        break;
      }

      case "button": {
        const commandTopic = requireTopic(config.command_topic, "command_topic");
        entityId = ctx.registerEntity({ ...base, domain: "button" }, async () => {
          await link.publish(commandTopic, config.payload_press);
          report({ domain: "button", pressedAt: Date.now() });
        }).id;
        // A button has no state to wait for; it is usable as soon as it is known.
        if (!hasAvailability(config)) report({ domain: "button" });
        break;
      }
    }

    // Availability: the entity is available only while every availability topic says so.
    const online = new Map<string, boolean>();
    const topics = [
      config.availability_topic,
      ...(config.availability ?? []).map((a) => a.topic),
    ].filter((t): t is string => t !== undefined);
    for (const topic of topics) {
      listen(topic, (payload) => {
        if (payload !== config.payload_available && payload !== config.payload_not_available)
          return;
        online.set(topic, payload === config.payload_available);
        const available = topics.every((t) => online.get(t) === true);
        if (available && component === "button") report({ domain: "button" });
        else ctx.setAvailable(entityId, available);
      });
    }

    return {
      entityId,
      online,
      release: () => {
        for (const off of subscriptions) off();
      },
    };
  }

  private device(config: DiscoveryConfig): DeviceId | undefined {
    const device = config.device;
    const identifier = Array.isArray(device?.identifiers)
      ? device.identifiers[0]
      : device?.identifiers;
    if (!device || !identifier) return undefined;
    return this.ctx.registerDevice({
      uniqueId: identifier,
      name: device.name ?? identifier,
      manufacturer: device.manufacturer,
      model: device.model,
      firmware: device.sw_version,
    }).id;
  }
}

const hasAvailability = (config: DiscoveryConfig) =>
  config.availability_topic !== undefined || (config.availability?.length ?? 0) > 0;

/** State is never guessed, so an entity whose state cannot be observed is not usable. */
function requireTopic(topic: string | undefined, field: string): string {
  if (!topic) throw new Error(`no ${field}`);
  return topic;
}

function onOff(payload: string | undefined, config: DiscoveryConfig): boolean | undefined {
  if (payload === config.payload_on) return true;
  if (payload === config.payload_off) return false;
  return undefined;
}

/** `connect` is injectable so tests can substitute an in-memory broker link. */
export const createMqttIntegration = (connect: MqttConnect = connectMqtt()) =>
  defineIntegration({
    id: "mqtt",
    name: "MQTT",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const link = await connect(ctx.config, ctx.signal, ctx.log);
      const discovery = new Discovery(ctx, link);
      link.onConnectionChange((connected) => discovery.connectionChanged(connected));
      const prefix = ctx.config.discoveryPrefix;
      // Both forms of the convention: with and without a node id.
      link.subscribe(`${prefix}/+/+/config`, (topic, payload) => discovery.handle(topic, payload));
      link.subscribe(`${prefix}/+/+/+/config`, (topic, payload) =>
        discovery.handle(topic, payload),
      );
    },
  });

export default createMqttIntegration();
