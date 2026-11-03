// core/log.ts
// pino, JSON to stdout. Everything else sees the small Logger interface from types.ts.

import pino from "pino";
import type { Logger } from "./types.ts";

export type LogBindings = Record<string, string>;
export type LoggerFactory = (bindings: LogBindings) => Logger;

const fields = (data: unknown): object =>
  data !== null && typeof data === "object" && !Array.isArray(data) ? data : { data };

/** Returns a factory for child loggers with bound fields (integration, instance, service). */
export function createLoggerFactory(level = Bun.env.LOG_LEVEL ?? "info"): LoggerFactory {
  const root = pino({ level });
  return (bindings) => {
    const child = root.child(bindings);
    return {
      debug: (msg, data) =>
        data === undefined ? child.debug(msg) : child.debug(fields(data), msg),
      info: (msg, data) => (data === undefined ? child.info(msg) : child.info(fields(data), msg)),
      warn: (msg, data) => (data === undefined ? child.warn(msg) : child.warn(fields(data), msg)),
      error: (msg, data) =>
        data === undefined ? child.error(msg) : child.error(fields(data), msg),
    };
  };
}
