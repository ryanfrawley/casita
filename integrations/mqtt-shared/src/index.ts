// Shared MQTT connection layer for the generic MQTT and zigbee2mqtt integrations:
// connect with reconnect, subscribe with a per-topic handler map, publish, connection changes.

import type { Logger } from "@casita/core/types";
import mqtt from "mqtt";
import { z } from "zod";

/** Config fields every MQTT-based integration takes. Spread into the integration's own schema. */
export const mqttConfigFields = {
  brokerUrl: z.url({ protocol: /^(mqtts?|wss?|tcp|tls)$/ }),
  username: z.string().optional(),
  password: z.string().optional(),
  clientId: z.string().optional(),
  /** TLS, for `mqtts://` brokers: a private CA, and a client certificate and key for mutual TLS. */
  caFile: z.string().optional(),
  certFile: z.string().optional(),
  keyFile: z.string().optional(),
};

export interface MqttConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

export type MessageHandler = (topic: string, payload: Buffer) => void;

/** What an integration sees of the broker. Tests substitute an in-memory implementation. */
export interface MqttLink {
  readonly connected: boolean;
  /** Resolves once the message is handed to the broker; rejects with a user-readable Error. */
  publish(topic: string, payload: string, opts?: { retain?: boolean }): Promise<void>;
  /** `filter` may use + and #. Returns an unsubscribe function. */
  subscribe(filter: string, handler: MessageHandler): () => void;
  /** Called with false when the broker connection drops and true when it is back. */
  onConnectionChange(listener: (connected: boolean) => void): () => void;
}

export type MqttConnect = (
  config: MqttConfig,
  signal: AbortSignal,
  log: Logger,
) => Promise<MqttLink>;

export interface ConnectOptions {
  connectTimeoutMs?: number;
  reconnectPeriodMs?: number;
}

/** MQTT topic filter matching, with + (one level) and # (the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/**
 * Connects to the broker, rejecting if the first connection cannot be made (the host then
 * retries setup with backoff). After that, MQTT.js reconnects and re-subscribes on its own.
 * The connection ends when `signal` aborts.
 */
export const connectMqtt = (opts: ConnectOptions = {}): MqttConnect =>
  async function connect(config, signal, log) {
    if (signal.aborted) throw new Error("aborted");
    const pem = async (path: string | undefined, what: string) => {
      if (path === undefined) return undefined;
      // Missing, unreadable, or a directory: all the same to the person fixing the config.
      try {
        return await Bun.file(path).text();
      } catch {
        throw new Error(`Cannot read the MQTT ${what} at ${path}`);
      }
    };
    const [ca, cert, key] = await Promise.all([
      pem(config.caFile, "CA certificate"),
      pem(config.certFile, "client certificate"),
      pem(config.keyFile, "client key"),
    ]);
    const client = mqtt.connect(config.brokerUrl, {
      ca,
      cert,
      key,
      username: config.username,
      password: config.password,
      clientId: config.clientId ?? `casita_${crypto.randomUUID().slice(0, 8)}`,
      connectTimeout: opts.connectTimeoutMs ?? 10_000,
      reconnectPeriod: opts.reconnectPeriodMs ?? 2000,
      resubscribe: true,
    });
    const handlers = new Map<string, Set<MessageHandler>>();
    const listeners = new Set<(connected: boolean) => void>();
    const end = () => void client.end(true);
    signal.addEventListener("abort", end, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out")),
          opts.connectTimeoutMs ?? 10_000,
        );
        client.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        client.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } catch (err) {
      end();
      const reason = err instanceof Error ? err.message || err.name : String(err);
      throw new Error(`Cannot reach the MQTT broker at ${config.brokerUrl}: ${reason}`);
    }

    let connected = true;
    const setConnected = (next: boolean) => {
      if (connected === next || signal.aborted) return;
      connected = next;
      log[next ? "info" : "warn"](next ? "broker connection restored" : "broker connection lost");
      for (const listener of [...listeners]) listener(next);
    };
    client.on("connect", () => setConnected(true));
    client.on("close", () => setConnected(false));
    client.on("error", (err) => log.warn("mqtt error", { error: err.message }));
    client.on("message", (topic, payload) => {
      for (const [filter, set] of handlers) {
        if (!topicMatches(filter, topic)) continue;
        for (const handler of [...set]) {
          try {
            handler(topic, payload);
          } catch (err) {
            log.error("mqtt handler failed", {
              topic,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    });

    return {
      get connected() {
        return connected;
      },
      async publish(topic, payload, publishOpts) {
        if (!connected) throw new Error("The MQTT broker is not connected");
        await client.publishAsync(topic, payload, { retain: publishOpts?.retain ?? false, qos: 1 });
      },
      subscribe(filter, handler) {
        let set = handlers.get(filter);
        if (!set) {
          set = new Set();
          handlers.set(filter, set);
        }
        set.add(handler);
        // Subscribing again makes the broker resend retained messages, which a handler that
        // joins an already-subscribed filter would otherwise never see.
        client.subscribe(filter, { qos: 1 }, (err) => {
          if (err && !signal.aborted) log.warn("subscribe failed", { filter, error: err.message });
        });
        return () => {
          set.delete(handler);
          if (set.size > 0) return;
          handlers.delete(filter);
          if (!signal.aborted) client.unsubscribe(filter);
        };
      },
      onConnectionChange(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  };
