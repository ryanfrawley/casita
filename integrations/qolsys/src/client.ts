// Client for the IQ Panel's "Control4" interface: a TLS socket on port 12345 carrying one JSON
// object per line in each direction. The panel answers every line it accepts with a bare `ACK`;
// everything else it sends is an event, including the reply to an INFO request.

import { z } from "zod";

const message = z.looseObject({ event: z.string() });
export type PanelEvent = z.infer<typeof message>;

export interface PanelClient {
  /** Writes one action; the panel's answer, if any, arrives as an event. */
  send(action: Record<string, unknown>): void;
  close(): void;
}

export interface ClientHandlers {
  onEvent(event: PanelEvent): void;
  /** The panel went away; not called after a local close(). */
  onClose(error: Error): void;
}

/**
 * Resolves once the TLS handshake is done. The panel's certificate is self-signed and
 * per-device, so it is not verified; the token in each message is what authenticates us.
 */
export function connect(
  hostname: string,
  port: number,
  handlers: ClientHandlers,
  timeoutMs = 10_000,
): Promise<PanelClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let buffer = "";
    let socket: Bun.Socket<undefined> | undefined;

    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket?.end();
      if (settled) handlers.onClose(error);
      else reject(error);
      settled = true;
    };
    const timer = setTimeout(
      () => fail(new Error(`timed out connecting to the panel at ${hostname}:${port}`)),
      timeoutMs,
    );

    const client: PanelClient = {
      send(action) {
        if (closed || !socket) throw new Error("The panel is not connected");
        socket.write(`${JSON.stringify(action)}\n`);
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        socket?.end();
      },
    };

    Bun.connect({
      hostname,
      port,
      tls: { rejectUnauthorized: false },
      socket: {
        open(s) {
          socket = s;
        },
        handshake(s, success, authorizationError) {
          // Bun reports the self-signed certificate as a failed handshake even with
          // verification off; the connection is up all the same.
          if (!success && !authorizationError)
            return fail(new Error(`the TLS handshake with ${hostname} failed`));
          socket = s;
          settled = true;
          clearTimeout(timer);
          resolve(client);
        },
        data(_s, chunk) {
          buffer += chunk.toString();
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line || line === "ACK") continue;
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              continue;
            }
            const parsed = message.safeParse(raw);
            if (parsed.success) handlers.onEvent(parsed.data);
          }
        },
        close() {
          fail(new Error(`the panel at ${hostname} closed the connection`));
        },
        error(_s, error) {
          fail(new Error(`cannot connect to the panel at ${hostname}:${port}: ${error.message}`));
        },
        connectError(_s, error) {
          fail(new Error(`cannot connect to the panel at ${hostname}:${port}: ${error.message}`));
        },
      },
    }).catch((error: unknown) => {
      fail(
        new Error(
          `cannot connect to the panel at ${hostname}:${port}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  });
}
