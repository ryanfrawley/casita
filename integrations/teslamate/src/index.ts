// Tesla vehicles as TeslaMate sees them: read-only, from the values TeslaMate publishes to
// MQTT under <base>/cars/<id>/<topic>. TeslaMate does the talking to Tesla; nothing here
// contacts the car or Tesla's servers.

import type {
  BinarySensorState,
  DeviceId,
  Domain,
  EntityId,
  EntityState,
  IntegrationContext,
  SensorState,
} from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { connectMqtt, type MqttConnect, mqttConfigFields } from "@casita/mqtt-shared";
import { z } from "zod";

const configSchema = z.strictObject({
  ...mqttConfigFields,
  /** TeslaMate's topic root; "teslamate/<namespace>" if MQTT_NAMESPACE is set. */
  baseTopic: z.string().min(1).default("teslamate"),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

export interface TeslaMateOptions {
  connect?: MqttConnect;
  /** How long to wait for a car's name before registering its entities without it. */
  nameGraceMs?: number;
}

type Read = (payload: string) => EntityState | undefined;

interface TopicSpec {
  domain: Domain;
  label: string;
  read: Read;
}

const number = (payload: string): number | undefined => {
  const value = payload.trim() === "" ? Number.NaN : Number(payload);
  return Number.isFinite(value) ? value : undefined;
};
const bool = (payload: string): boolean | undefined =>
  payload === "true" ? true : payload === "false" ? false : undefined;

const sensor = (
  label: string,
  unit?: string,
  deviceClass?: SensorState["deviceClass"],
): TopicSpec => ({
  domain: "sensor",
  label,
  read: (payload) => {
    // TeslaMate publishes an empty value when it has nothing to say (charger power once
    // unplugged, say). That is "no value", not the last number and not zero.
    if (payload.trim() === "") return { domain: "sensor", value: null, unit, deviceClass };
    const value = number(payload);
    return value === undefined ? undefined : { domain: "sensor", value, unit, deviceClass };
  },
});
const text = (label: string): TopicSpec => ({
  domain: "sensor",
  label,
  // TeslaMate writes "nil" or nothing for a value it does not have (no route destination, say).
  read: (payload) => ({
    domain: "sensor",
    value: payload === "" || payload === "nil" ? null : payload,
  }),
});
const binary = (label: string, deviceClass?: BinarySensorState["deviceClass"]): TopicSpec => ({
  domain: "binary_sensor",
  label,
  read: (payload) => {
    const on = bool(payload);
    return on === undefined ? undefined : { domain: "binary_sensor", on, deviceClass };
  },
});

/** The TeslaMate topics that become entities. Units are TeslaMate's: km, kW, °C, bar. */
const TOPICS: Record<string, TopicSpec> = {
  state: text("state"),
  charging_state: text("charging state"),
  battery_level: sensor("battery", "%", "battery"),
  usable_battery_level: sensor("usable battery", "%", "battery"),
  rated_battery_range_km: sensor("range", "km"),
  est_battery_range_km: sensor("estimated range", "km"),
  ideal_battery_range_km: sensor("ideal range", "km"),
  charge_limit_soc: sensor("charge limit", "%"),
  charger_power: sensor("charger power", "kW", "power"),
  charge_energy_added: sensor("charge energy added", "kWh", "energy"),
  time_to_full_charge: sensor("time to full charge", "h"),
  charger_voltage: sensor("charger voltage", "V"),
  charger_actual_current: sensor("charger current", "A"),
  charge_current_request: sensor("charge current request", "A"),
  charge_current_request_max: sensor("charge current limit", "A"),
  inside_temp: sensor("inside temperature", "°C", "temperature"),
  outside_temp: sensor("outside temperature", "°C", "temperature"),
  odometer: sensor("odometer", "km"),
  speed: sensor("speed", "km/h"),
  power: sensor("power", "kW", "power"),
  elevation: sensor("elevation", "m"),
  tpms_pressure_fl: sensor("tire pressure front left", "bar"),
  tpms_pressure_fr: sensor("tire pressure front right", "bar"),
  tpms_pressure_rl: sensor("tire pressure rear left", "bar"),
  tpms_pressure_rr: sensor("tire pressure rear right", "bar"),
  climate_keeper_mode: text("climate keeper"),
  update_version: text("update version"),
  active_route_destination: text("destination"),
  // The place TeslaMate knows the car to be in; outside every geofence it publishes "".
  geofence: {
    domain: "sensor",
    label: "location",
    read: (payload) => ({ domain: "sensor", value: payload || "away" }),
  },
  plugged_in: binary("plugged in"),
  is_climate_on: binary("climate"),
  is_preconditioning: binary("preconditioning"),
  charge_port_door_open: binary("charge port", "door"),
  driver_front_door_open: binary("driver door", "door"),
  driver_rear_door_open: binary("driver rear door", "door"),
  passenger_front_door_open: binary("passenger door", "door"),
  passenger_rear_door_open: binary("passenger rear door", "door"),
  tpms_soft_warning_fl: binary("tire warning front left"),
  tpms_soft_warning_fr: binary("tire warning front right"),
  tpms_soft_warning_rl: binary("tire warning rear left"),
  tpms_soft_warning_rr: binary("tire warning rear right"),
  sentry_mode: binary("sentry mode"),
  doors_open: binary("doors", "door"),
  windows_open: binary("windows", "window"),
  trunk_open: binary("trunk", "door"),
  frunk_open: binary("frunk", "door"),
  is_user_present: binary("occupied", "occupancy"),
  update_available: binary("update available"),
  locked: {
    domain: "lock",
    label: "lock",
    read: (payload) => {
      const locked = bool(payload);
      return locked === undefined ? undefined : { domain: "lock", locked };
    },
  },
};

/** Device details and attributes rather than entities. */
const META = ["display_name", "model", "trim_badging", "version"];
/** Topics that feed the location entity. */
const POSITION = ["geofence", "latitude", "longitude", "location", "heading"];

class Car {
  private readonly values = new Map<string, string>();
  private readonly entities = new Map<string, EntityId>();
  private deviceId?: DeviceId;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly id: string,
    graceMs: number,
  ) {
    // Retained topics arrive in any order; wait briefly so entity ids are built from the car's name.
    this.timer = setTimeout(() => this.start(), graceMs);
    ctx.signal.addEventListener("abort", () => clearTimeout(this.timer), { once: true });
  }

  receive(topic: string, payload: string): void {
    this.values.set(topic, payload);
    // Newer TeslaMate versions also publish the position as one JSON value.
    if (topic === "location") this.readPosition(payload);
    if (!this.ready) {
      if (topic === "display_name") this.start();
      return;
    }
    if (META.includes(topic)) this.describe();
    // Entity names start with the car's name, so they follow a rename. Ids stay as they are.
    if (topic === "display_name") for (const known of this.entities.keys()) this.register(known);
    this.publish(POSITION.includes(topic) ? "geofence" : topic);
  }

  private readPosition(payload: string): void {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== "object") return;
      const { latitude, longitude } = parsed as Record<string, unknown>;
      if (typeof latitude === "number") this.values.set("latitude", String(latitude));
      if (typeof longitude === "number") this.values.set("longitude", String(longitude));
    } catch {
      // not JSON; the separate latitude and longitude topics still apply
    }
  }

  setUnavailable(): void {
    for (const id of this.entities.values()) this.ctx.setAvailable(id, false);
  }

  private get name(): string {
    return this.values.get("display_name") || `Tesla ${this.id}`;
  }

  private start(): void {
    if (this.ready || this.ctx.signal.aborted) return;
    clearTimeout(this.timer);
    this.ready = true;
    this.describe();
    for (const topic of new Set(
      [...this.values.keys()].map((t) => (POSITION.includes(t) ? "geofence" : t)),
    )) {
      this.publish(topic);
    }
  }

  /** Registers or updates the device; entity names follow it. */
  private describe(): void {
    const model = this.values.get("model");
    const trim = this.values.get("trim_badging");
    this.deviceId = this.ctx.registerDevice({
      uniqueId: `teslamate-${this.id}`,
      name: this.name,
      manufacturer: "Tesla",
      model: model ? `Model ${model}${trim ? ` ${trim}` : ""}` : undefined,
      firmware: this.values.get("version") || undefined,
    }).id;
  }

  private register(topic: string): EntityId | undefined {
    const spec = Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : undefined;
    if (!spec) return undefined;
    const id = this.ctx.registerEntity({
      uniqueId: `teslamate-${this.id}-${topic}`,
      domain: spec.domain,
      name: `${this.name} ${spec.label}`,
      deviceId: this.deviceId,
    }).id;
    this.entities.set(topic, id);
    return id;
  }

  private publish(topic: string): void {
    const spec = Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : undefined;
    if (!spec) return;
    const latitude = number(this.values.get("latitude") ?? "");
    const longitude = number(this.values.get("longitude") ?? "");
    const position = topic === "geofence" && latitude !== undefined && longitude !== undefined;
    // The location exists as soon as there is a place name or a position to report.
    const payload = this.values.get(topic) ?? (position ? "" : undefined);
    const state = payload === undefined ? undefined : spec.read(payload);
    if (!state) return;
    // Words that were never there make no entity; once one exists, losing its value clears it.
    // (A number's reader always names a unit, even an undefined one; a word's never does.)
    const wordless = state.domain === "sensor" && state.value === null && !("unit" in state);
    if (wordless && !this.entities.has(topic)) return;
    const entityId = this.entities.get(topic) ?? this.register(topic);
    if (!entityId) return;
    const heading = number(this.values.get("heading") ?? "");
    this.ctx.reportState(
      entityId,
      state,
      position ? { latitude, longitude, ...(heading === undefined ? {} : { heading }) } : undefined,
    );
  }
}

/** `connect` is injectable so tests can substitute an in-memory broker link. */
export const createTeslaMateIntegration = (options: TeslaMateOptions = {}) =>
  defineIntegration({
    id: "teslamate",
    name: "TeslaMate",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const link = await (options.connect ?? connectMqtt())(ctx.config, ctx.signal, ctx.log);
      const cars = new Map<string, Car>();
      const prefix = `${ctx.config.baseTopic}/cars/`;

      link.onConnectionChange((connected) => {
        // Retained values arrive again after the re-subscribe and make everything available.
        if (!connected) for (const car of cars.values()) car.setUnavailable();
      });
      link.subscribe(`${prefix}+/+`, (topic, payload) => {
        const [id, name] = topic.slice(prefix.length).split("/");
        if (!id || !name) return;
        let car = cars.get(id);
        if (!car) {
          car = new Car(ctx, id, options.nameGraceMs ?? 1500);
          cars.set(id, car);
        }
        car.receive(name, payload.toString());
      });
    },
  });

export default createTeslaMateIntegration();
