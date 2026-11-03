// WebSocket client for the casita API. Used by the CLI, the web app, and the integration tests.

import {
  CLOSE,
  PROTOCOL_VERSION,
  type RequestParams,
  type RequestType,
  type ServerMessage,
  serverMessageSchema,
} from "@casita/api/schema";

export class CasitaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CasitaError";
  }
}

export type EventMessage = Extract<ServerMessage, { type: "event" }>;
export type SnapshotMessage = Extract<ServerMessage, { type: "snapshot" }>;

type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };

/** "http://host:8123" or "ws://host:8123" → the two bases the API is reached on. */
export function endpoints(url: string): { http: string; ws: string } {
  // "host:8123" alone would parse with "host:" as the scheme.
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const host = parsed.host;
  return {
    http: `${secure ? "https" : "http"}://${host}`,
    ws: `${secure ? "wss" : "ws"}://${host}/ws`,
  };
}

export class CasitaClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(message: EventMessage) => void>();
  private readonly snapshotListeners = new Set<(message: SnapshotMessage) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();

  private constructor(
    private readonly ws: WebSocket,
    /** The unit system the server is set to show readings in. */
    readonly units: "metric" | "imperial" = "metric",
  ) {
    ws.addEventListener("message", (e) => this.receive(String(e.data)));
    ws.addEventListener("close", (e) => {
      const error = new CasitaError(
        "connection",
        `Connection closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`,
      );
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      for (const listener of this.closeListeners) listener(e.code, e.reason);
    });
  }

  /**
   * Opens the socket and authenticates. Rejects with code "auth" or "connection". A browser
   * leaves `token` out: its session cookie goes with the socket.
   */
  static connect(url: string, token?: string): Promise<CasitaClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoints(url).ws);
      let settled = false;
      const fail = (err: CasitaError) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.addEventListener("error", () =>
        fail(new CasitaError("connection", `Cannot connect to ${url}`)),
      );
      ws.addEventListener("close", (e) =>
        fail(
          e.code === CLOSE.unauthorized
            ? new CasitaError("auth", token ? "The server rejected the token" : "Not signed in")
            : new CasitaError("connection", `Cannot connect to ${url}`),
        ),
      );
      ws.addEventListener(
        "message",
        (e) => {
          const message = serverMessageSchema.safeParse(JSON.parse(String(e.data)));
          if (!message.success || !("type" in message.data) || message.data.type !== "auth_ok") {
            ws.close();
            return fail(new CasitaError("connection", "Unexpected reply to auth"));
          }
          if (message.data.version !== PROTOCOL_VERSION) {
            ws.close();
            return fail(
              new CasitaError(
                "connection",
                `Server speaks protocol ${message.data.version}, this client speaks ${PROTOCOL_VERSION}`,
              ),
            );
          }
          settled = true;
          resolve(new CasitaClient(ws, message.data.units));
        },
        { once: true },
      );
    });
  }

  /** Sends one request; rejects with a CasitaError carrying the server's error code. */
  request<T extends RequestType>(type: T, params: RequestParams<T>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...params }));
    });
  }

  onEvent(listener: (message: EventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }

  onSnapshot(listener: (message: SnapshotMessage) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => void this.snapshotListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => void this.closeListeners.delete(listener);
  }

  get closed(): boolean {
    return this.ws.readyState >= WebSocket.CLOSING;
  }

  close(): void {
    this.ws.close();
  }

  private receive(raw: string): void {
    const parsed = serverMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const message = parsed.data;
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.ok) pending?.resolve(message.result);
      else pending?.reject(new CasitaError(message.error.code, message.error.message));
    } else if (message.type === "event") {
      for (const listener of this.eventListeners) listener(message);
    } else if (message.type === "snapshot") {
      for (const listener of this.snapshotListeners) listener(message);
    }
  }
}
