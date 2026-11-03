// Client for the zwave-js-server WebSocket protocol: version handshake, request/response
// correlation by messageId, and the event stream.

import { z } from "zod";

/** The protocol schema this client is written against. */
export const SCHEMA_VERSION = 35;

const versionMessage = z.looseObject({
  type: z.literal("version"),
  homeId: z.number().nullish(),
  serverVersion: z.string().optional(),
  minSchemaVersion: z.number(),
  maxSchemaVersion: z.number(),
});

const resultMessage = z.looseObject({
  type: z.literal("result"),
  messageId: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  errorCode: z.string().optional(),
  message: z.string().optional(),
  zwaveErrorMessage: z.string().optional(),
});

const eventMessage = z.looseObject({
  type: z.literal("event"),
  event: z.looseObject({ source: z.string(), event: z.string(), nodeId: z.number().optional() }),
});
export type ServerEvent = z.infer<typeof eventMessage>["event"];

export interface ZwaveClient {
  readonly homeId: number;
  /** Sends a command; rejects with a user-readable Error if the server refuses it. */
  call(command: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface ClientHandlers {
  onEvent(event: ServerEvent): void;
  /** The server went away; not called after a local close(). */
  onClose(error: Error): void;
}

/** Resolves once the server has accepted the schema version. */
export function connect(
  url: string,
  handlers: ClientHandlers,
  timeoutMs = 10_000,
): Promise<ZwaveClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map<
      string,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    let nextId = 1;
    let settled = false;
    let closed = false;

    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      ws.close();
      if (settled) handlers.onClose(error);
      else reject(error);
      settled = true;
    };
    const timer = setTimeout(() => fail(new Error(`timed out connecting to ${url}`)), timeoutMs);

    const call = (command: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((res, rej) => {
        if (closed) return rej(new Error("The Z-Wave JS server is not connected"));
        const messageId = String(nextId++);
        pending.set(messageId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ ...params, messageId, command }));
      });

    const client = (homeId: number): ZwaveClient => ({
      homeId,
      call,
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        for (const p of pending.values())
          p.reject(new Error("The Z-Wave JS server connection was closed"));
        pending.clear();
        ws.close();
      },
    });

    ws.addEventListener("error", () =>
      fail(new Error(`cannot connect to the Z-Wave JS server at ${url}`)),
    );
    ws.addEventListener("close", () =>
      fail(new Error(`the Z-Wave JS server at ${url} closed the connection`)),
    );
    ws.addEventListener("message", (e) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(e.data));
      } catch {
        return;
      }

      const version = versionMessage.safeParse(raw);
      if (version.success) {
        const { minSchemaVersion: min, maxSchemaVersion: max, homeId } = version.data;
        if (SCHEMA_VERSION < min || SCHEMA_VERSION > max) {
          return fail(
            new Error(
              `the Z-Wave JS server speaks schemas ${min} to ${max}; this client needs ${SCHEMA_VERSION}`,
            ),
          );
        }
        call("initialize", {
          schemaVersion: SCHEMA_VERSION,
          additionalUserAgentComponents: { casita: "0.1.0" },
        }).then(
          () => {
            settled = true;
            clearTimeout(timer);
            resolve(client(homeId ?? 0));
          },
          (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))),
        );
        return;
      }

      const result = resultMessage.safeParse(raw);
      if (result.success) {
        const waiter = pending.get(result.data.messageId);
        pending.delete(result.data.messageId);
        if (result.data.success) waiter?.resolve(result.data.result);
        else {
          const { zwaveErrorMessage, message, errorCode } = result.data;
          waiter?.reject(
            new Error(zwaveErrorMessage ?? message ?? `Z-Wave JS error: ${errorCode ?? "unknown"}`),
          );
        }
        return;
      }

      const event = eventMessage.safeParse(raw);
      if (event.success) handlers.onEvent(event.data.event);
    });
  });
}
