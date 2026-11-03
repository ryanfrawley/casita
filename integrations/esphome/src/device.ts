// One ESPHome device: connect, learn its entities, stream its state, deliver commands,
// and reconnect with backoff when the connection drops.

import type {
  BinarySensorState,
  Capabilities,
  DeviceId,
  EntityId,
  EntityState,
  IntegrationContext,
  SensorState,
} from "@casita/core/types";
import { ColorMode, CoverOperation, type Messages } from "./api.gen.ts";
import { type Connection, openConnection } from "./connection.ts";
import type { AnyMessage, MessageName } from "./proto.ts";

export interface DeviceOptions {
  host: string;
  port: number;
  encryptionKey?: string;
  password?: string;
}

export interface Timing {
  /** How long each step of connecting may take. */
  timeoutMs: number;
  /** Interval between pings; the connection is dropped after three with no traffic. */
  keepaliveMs: number;
  /** First reconnect delay; doubles up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_TIMING: Timing = {
  timeoutMs: 10_000,
  keepaliveMs: 20_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
};

// Capability bits inside a ColorMode value.
const BRIGHTNESS = 2;
const COLOR_TEMPERATURE = 8;
const RGB = 32;

const SENSOR_CLASSES = [
  "temperature",
  "humidity",
  "power",
  "energy",
  "illuminance",
  "battery",
] as const;
const BINARY_CLASS: Record<string, BinarySensorState["deviceClass"]> = {
  motion: "motion",
  occupancy: "occupancy",
  presence: "occupancy",
  door: "door",
  garage_door: "door",
  window: "window",
  moisture: "leak",
  smoke: "smoke",
};

const mired = (value: number) => Math.round(1_000_000 / value);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

type Ctx = IntegrationContext<unknown>;
type Waiter = { resolve(message: AnyMessage["message"]): void; reject(error: Error): void };

export class Device {
  private connection?: Connection;
  private readonly waiters = new Map<MessageName, Waiter>();
  /** ESPHome entity key → the entity it became, and how to read its state messages. */
  private readonly entities = new Map<
    number,
    {
      id: EntityId;
      colorModes?: number[];
      decimals?: number;
      unit?: string;
      sensorClass?: SensorState["deviceClass"];
      binaryClass?: BinarySensorState["deviceClass"];
    }
  >();
  private deviceId?: DeviceId;
  private deviceName = "";
  private mac = "";
  private lastReceived = 0;
  private attempt = 0;
  private keepalive?: () => void;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly where: string;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: DeviceOptions,
    private readonly timing: Timing = DEFAULT_TIMING,
  ) {
    this.where = `${opts.host}:${opts.port}`;
    ctx.signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  /** Resolves when the first connection attempt has finished, whether or not it worked. */
  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.ctx.signal.aborted) return;
    try {
      await this.session();
      this.attempt = 0;
      this.ctx.log.info("device connected", { device: this.deviceName, host: this.where });
    } catch (err) {
      this.drop();
      const delay = Math.min(
        this.timing.backoffBaseMs * 2 ** this.attempt++,
        this.timing.backoffMaxMs,
      );
      this.ctx.log.warn("device unreachable; will retry", {
        host: this.where,
        error: err instanceof Error ? err.message : String(err),
        retryInMs: delay,
      });
      if (!this.ctx.signal.aborted) this.retry = setTimeout(() => void this.connect(), delay);
    }
  }

  /** Hello, authenticate, device info, entity list, state subscription. */
  private async session(): Promise<void> {
    const { opts, timing, ctx } = this;
    const connection = await openConnection(
      {
        host: opts.host,
        port: opts.port,
        encryptionKey: opts.encryptionKey,
        timeoutMs: timing.timeoutMs,
      },
      {
        onMessage: (message) => this.receive(message),
        onClose: (error) => {
          if (this.connection !== connection) return;
          for (const waiter of this.waiters.values()) waiter.reject(error);
          this.waiters.clear();
          // A session that was up reconnects from here; one still starting fails through session().
          if (this.keepalive) {
            ctx.log.warn("device connection lost", {
              device: this.deviceName,
              error: error.message,
            });
            this.drop();
            void this.connect();
          }
        },
      },
    );
    this.connection = connection;
    this.lastReceived = Date.now();

    connection.send("HelloRequest", {
      clientInfo: "casita",
      apiVersionMajor: 1,
      apiVersionMinor: 10,
    });
    const hello = await this.expect("HelloResponse");
    if (hello.apiVersionMajor !== 1)
      throw new Error(`unsupported API version ${hello.apiVersionMajor}`);

    // Older firmware requires this message even with no password; newer firmware ignores it.
    connection.send("AuthenticationRequest", { password: opts.password ?? "" });
    if (opts.password) {
      const auth = await this.expect("AuthenticationResponse");
      if (auth.invalidPassword) throw new Error("the device rejected the password");
    }

    connection.send("DeviceInfoRequest");
    const info = await this.expect("DeviceInfoResponse");
    this.mac = info.macAddress;
    this.deviceName = info.friendlyName || info.name || opts.host;
    this.deviceId = ctx.registerDevice({
      uniqueId: info.macAddress,
      name: this.deviceName,
      manufacturer: info.manufacturer || undefined,
      model: info.model || undefined,
      firmware: info.esphomeVersion || undefined,
    }).id;

    connection.send("ListEntitiesRequest");
    await this.expect("ListEntitiesDoneResponse");
    connection.send("SubscribeStatesRequest");
    this.keepalive = ctx.scheduler.every(timing.keepaliveMs, () => {
      if (Date.now() - this.lastReceived > timing.keepaliveMs * 3) {
        ctx.log.warn("device stopped responding", { device: this.deviceName });
        this.drop();
        void this.connect();
      } else {
        connection.send("PingRequest");
      }
    });
  }

  /** The next message of this type, or a rejection if the connection drops or stalls first. */
  private expect<K extends MessageName>(name: K): Promise<Messages[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(name);
        reject(new Error(`no ${name} from ${this.where}`));
      }, this.timing.timeoutMs);
      this.waiters.set(name, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as Messages[K]);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Ends the current connection and marks everything on the device unavailable. */
  private drop(): void {
    this.keepalive?.();
    this.keepalive = undefined;
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
    if (this.ctx.signal.aborted) return;
    for (const { id } of this.entities.values()) this.ctx.setAvailable(id, false);
  }

  private stop(): void {
    clearTimeout(this.retry);
    this.connection?.send("DisconnectRequest");
    this.drop();
  }

  private send<K extends MessageName>(name: K, value: Partial<Messages[K]>): Promise<void> {
    if (!this.connection)
      return Promise.reject(new Error(`${this.deviceName || this.where} is not connected`));
    this.connection.send(name, value);
    return Promise.resolve();
  }

  // ───────── messages from the device ─────────

  private receive({ name, message }: AnyMessage): void {
    this.lastReceived = Date.now();
    const waiter = this.waiters.get(name);
    if (waiter) {
      this.waiters.delete(name);
      waiter.resolve(message);
    }
    const { ctx } = this;
    const base = (m: { key: number; name: string; objectId: string }) => ({
      uniqueId: `${this.mac}-${m.key}`,
      name: m.name ? `${this.deviceName} ${m.name}` : this.deviceName,
      deviceId: this.deviceId,
    });
    const report = (key: number, state: EntityState) => {
      const entity = this.entities.get(key);
      if (entity) ctx.reportState(entity.id, state);
    };

    switch (name) {
      case "PingRequest":
        this.connection?.send("PingResponse");
        break;
      case "GetTimeRequest":
        this.connection?.send("GetTimeResponse", { epochSeconds: Math.floor(Date.now() / 1000) });
        break;
      case "DisconnectRequest": {
        // The device is going away (reboot, deep sleep, OTA).
        this.connection?.send("DisconnectResponse");
        this.drop();
        void this.connect();
        break;
      }

      case "ListEntitiesSwitchResponse": {
        const { key } = message;
        const id = ctx.registerEntity({ ...base(message), domain: "switch" }, (command) =>
          this.send("SwitchCommandRequest", { key, state: command.action === "turn_on" }),
        ).id;
        this.entities.set(key, { id });
        break;
      }
      case "SwitchStateResponse":
        report(message.key, { domain: "switch", on: message.state });
        break;

      case "ListEntitiesLightResponse": {
        const { key } = message;
        const modes = message.supportedColorModes;
        const has = (bit: number) => modes.some((mode) => (mode & bit) === bit);
        const capabilities: Capabilities = {
          brightness: has(BRIGHTNESS) || undefined,
          colorTemp:
            has(COLOR_TEMPERATURE) && message.minMireds > 0 && message.maxMireds > 0
              ? { minK: mired(message.maxMireds), maxK: mired(message.minMireds) }
              : undefined,
          rgb: has(RGB) || undefined,
          transition: true,
        };
        const id = ctx.registerEntity(
          { ...base(message), domain: "light", capabilities },
          (command) => {
            if (command.action === "turn_off") {
              return this.send("LightCommandRequest", {
                key,
                hasState: true,
                state: false,
                hasTransitionLength: command.transitionMs !== undefined,
                transitionLength: command.transitionMs ?? 0,
              });
            }
            const [red = 0, green = 0, blue = 0] = command.rgb ?? [];
            // Tell the device which mode the color fields mean, when it has more than one.
            const mode = command.rgb
              ? modes.find((m) => (m & RGB) === RGB)
              : command.colorTempK !== undefined
                ? modes.find((m) => (m & COLOR_TEMPERATURE) === COLOR_TEMPERATURE)
                : undefined;
            return this.send("LightCommandRequest", {
              key,
              hasState: true,
              state: true,
              hasBrightness: command.brightness !== undefined,
              brightness: command.brightness ?? 0,
              hasColorMode: mode !== undefined,
              colorMode: mode ?? ColorMode.COLOR_MODE_UNKNOWN,
              hasRgb: command.rgb !== undefined,
              red: red / 255,
              green: green / 255,
              blue: blue / 255,
              hasColorTemperature: command.colorTempK !== undefined,
              colorTemperature:
                command.colorTempK === undefined ? 0 : 1_000_000 / command.colorTempK,
              hasTransitionLength: command.transitionMs !== undefined,
              transitionLength: command.transitionMs ?? 0,
            });
          },
        ).id;
        this.entities.set(key, { id, colorModes: modes });
        break;
      }
      case "LightStateResponse": {
        const modes = this.entities.get(message.key)?.colorModes ?? [];
        const dimmable = modes.some((mode) => (mode & BRIGHTNESS) === BRIGHTNESS);
        const mode = message.colorMode;
        report(message.key, {
          domain: "light",
          on: message.state,
          brightness: dimmable ? Math.round(clamp01(message.brightness) * 1000) / 1000 : undefined,
          colorTempK:
            (mode & COLOR_TEMPERATURE) === COLOR_TEMPERATURE && message.colorTemperature > 0
              ? mired(message.colorTemperature)
              : undefined,
          rgb:
            (mode & RGB) === RGB
              ? [
                  Math.round(message.red * 255),
                  Math.round(message.green * 255),
                  Math.round(message.blue * 255),
                ]
              : undefined,
        });
        break;
      }

      case "ListEntitiesSensorResponse": {
        const id = ctx.registerEntity({ ...base(message), domain: "sensor" }).id;
        this.entities.set(message.key, {
          id,
          decimals: message.accuracyDecimals,
          unit: message.unitOfMeasurement || undefined,
          sensorClass: SENSOR_CLASSES.find((c) => c === message.deviceClass),
        });
        break;
      }
      case "SensorStateResponse": {
        if (message.missingState) break;
        const entity = this.entities.get(message.key);
        // The wire value is a 32-bit float; round it to what the device says is meaningful.
        const scale = 10 ** Math.max(0, entity?.decimals ?? 2);
        report(message.key, {
          domain: "sensor",
          value: Math.round(message.state * scale) / scale,
          unit: entity?.unit,
          deviceClass: entity?.sensorClass,
        });
        break;
      }

      case "ListEntitiesBinarySensorResponse": {
        const id = ctx.registerEntity({ ...base(message), domain: "binary_sensor" }).id;
        this.entities.set(message.key, { id, binaryClass: BINARY_CLASS[message.deviceClass] });
        break;
      }
      case "BinarySensorStateResponse":
        if (!message.missingState) {
          report(message.key, {
            domain: "binary_sensor",
            on: message.state,
            deviceClass: this.entities.get(message.key)?.binaryClass,
          });
        }
        break;

      case "ListEntitiesCoverResponse": {
        const { key } = message;
        const capabilities: Capabilities = { position: message.supportsPosition || undefined };
        const id = ctx.registerEntity(
          { ...base(message), domain: "cover", capabilities },
          (command) => {
            if (command.action === "stop")
              return this.send("CoverCommandRequest", { key, stop: true });
            const position =
              command.action === "set_position"
                ? command.position
                : command.action === "open"
                  ? 1
                  : 0;
            return this.send("CoverCommandRequest", { key, hasPosition: true, position });
          },
        ).id;
        this.entities.set(key, { id });
        break;
      }
      case "CoverStateResponse":
        report(message.key, {
          domain: "cover",
          position: Math.round(clamp01(message.position) * 1000) / 1000,
          motion:
            message.currentOperation === CoverOperation.COVER_OPERATION_IS_OPENING
              ? "opening"
              : message.currentOperation === CoverOperation.COVER_OPERATION_IS_CLOSING
                ? "closing"
                : "stopped",
        });
        break;

      case "ListEntitiesButtonResponse": {
        const { key } = message;
        const id = ctx.registerEntity({ ...base(message), domain: "button" }, async () => {
          await this.send("ButtonCommandRequest", { key });
          ctx.reportState(id, { domain: "button", pressedAt: Date.now() });
        }).id;
        this.entities.set(key, { id });
        // A button has no state of its own; it is usable while the device is connected.
        ctx.reportState(id, { domain: "button" });
        break;
      }

      default:
        break;
    }
  }
}
