// core/bus.ts
// Synchronous, typed event bus. emit never throws; a failing listener is logged and skipped.

import type { CoreEvent, EventBus, EventOf, Logger } from "./types.ts";
import { errorMessage, noopLogger } from "./util.ts";

type Handler = (e: CoreEvent) => unknown;

export class Bus implements EventBus {
  private readonly listeners = new Map<CoreEvent["type"], Set<Handler>>();
  private readonly anyListeners = new Set<Handler>();

  constructor(private readonly log: Logger = noopLogger) {}

  emit(event: CoreEvent): void {
    // Copy so a listener that unsubscribes mid-emit doesn't disturb iteration.
    const typed = this.listeners.get(event.type);
    for (const handler of typed ? [...typed] : []) this.call(handler, event);
    for (const handler of [...this.anyListeners]) this.call(handler, event);
  }

  on<T extends CoreEvent["type"]>(type: T, handler: (e: EventOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const h = handler as Handler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /** Every event, in emit order. Used by the API event stream. */
  onAny(handler: (e: CoreEvent) => void): () => void {
    this.anyListeners.add(handler);
    return () => {
      this.anyListeners.delete(handler);
    };
  }

  /** Resolves with the next matching event. Intended for tests. */
  once<T extends CoreEvent["type"]>(
    type: T,
    filter?: (e: EventOf<T>) => boolean,
  ): Promise<EventOf<T>> {
    return new Promise((resolve) => {
      const off = this.on(type, (e) => {
        if (filter && !filter(e)) return;
        off();
        resolve(e);
      });
    });
  }

  private call(handler: Handler, event: CoreEvent): void {
    try {
      const result = handler(event);
      // Promises are not awaited, but a rejection must not become an unhandled rejection.
      if (result instanceof Promise) result.catch((err) => this.report(event, err));
    } catch (err) {
      this.report(event, err);
    }
  }

  private report(event: CoreEvent, err: unknown): void {
    this.log.error("event listener failed", { event: event.type, error: errorMessage(err) });
  }
}
