// An in-memory stand-in for the broker connection: retained messages, subscriptions,
// and a switch to drop and restore the connection.

import { type MessageHandler, type MqttConnect, type MqttLink, topicMatches } from "./index.ts";

export class FakeBroker {
  /** What the integration published, in order. */
  readonly published: { topic: string; payload: string }[] = [];
  /** Set to make the next connect fail, as an unreachable broker would. */
  unreachable = false;
  private readonly retained = new Map<string, string>();
  private readonly subscriptions = new Set<{ filter: string; handler: MessageHandler }>();
  private readonly listeners = new Set<(connected: boolean) => void>();
  private connected = false;

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  readonly connect: MqttConnect = async (config, signal) => {
    if (this.unreachable)
      throw new Error(`Cannot reach the MQTT broker at ${config.brokerUrl}: refused`);
    this.connected = true;
    signal.addEventListener("abort", () => {
      this.connected = false;
      this.subscriptions.clear();
      this.listeners.clear();
    });
    const link: MqttLink = {
      connected: true,
      publish: async (topic, payload) => {
        if (!this.connected) throw new Error("The MQTT broker is not connected");
        this.published.push({ topic, payload });
      },
      subscribe: (filter, handler) => {
        const subscription = { filter, handler };
        this.subscriptions.add(subscription);
        for (const [topic, payload] of this.retained) {
          if (topicMatches(filter, topic)) handler(topic, Buffer.from(payload));
        }
        return () => void this.subscriptions.delete(subscription);
      },
      onConnectionChange: (listener) => {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
      },
    };
    return link;
  };

  /** A device publishes. Objects are sent as JSON. */
  publish(topic: string, payload: unknown, retain = true): void {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (retain) this.retained.set(topic, text);
    if (!this.connected) return;
    for (const { filter, handler } of [...this.subscriptions]) {
      if (topicMatches(filter, topic)) handler(topic, Buffer.from(text));
    }
  }

  /** Publishes every entry of a fixture file holding a { topic: payload } map. */
  async load(fixture: URL | string): Promise<void> {
    const map = (await Bun.file(fixture).json()) as Record<string, unknown>;
    for (const [topic, payload] of Object.entries(map)) this.publish(topic, payload);
  }

  drop(): void {
    this.connected = false;
    for (const listener of [...this.listeners]) listener(false);
  }

  /** Reconnects; as after a real re-subscribe, retained messages are delivered again. */
  restore(): void {
    this.connected = true;
    for (const listener of [...this.listeners]) listener(true);
    for (const [topic, payload] of this.retained) {
      for (const { filter, handler } of [...this.subscriptions]) {
        if (topicMatches(filter, topic)) handler(topic, Buffer.from(payload));
      }
    }
  }
}
