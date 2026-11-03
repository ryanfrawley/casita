// La Marzocco's customer-app cloud (lion.lamarzocco.io), the one its phone app uses: sign-in,
// the machine list, each machine's dashboard, commands, and the dashboard's STOMP socket.
// Endpoints and payloads follow pylamarzocco, which reads them from the app.

import { z } from "zod";
import type { Installation } from "./signing.ts";
import { decodeFrame, encodeFrame } from "./stomp.ts";

export const HOST = "lion.lamarzocco.io";
const BASE = `https://${HOST}/api/customer-app`;

/** The cloud does not say how long a token lasts; the app treats it as an hour. */
const TOKEN_LIFETIME_MS = 60 * 60_000;
/** Refreshed this long before it runs out. */
const TOKEN_REFRESH_MS = 10 * 60_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The parts of a WebSocket the dashboard connection uses. */
export interface Socket {
  send(data: string): void;
  close(): void;
  /** A WebSocket ping, where the implementation has one (Bun's does). */
  ping?(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}
export type OpenSocket = (url: string, headers: Record<string, string>) => Socket;

/** Bun's WebSocket takes request headers, which the cloud needs for the signature. */
export const openSocket: OpenSocket = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as Socket;

export class LaMarzoccoError extends Error {
  constructor(
    message: string,
    /** The credentials were refused, not just the request. */
    readonly auth = false,
    /**
     * Sign-in itself was refused. Either the password is wrong or the cloud no longer knows
     * this installation's key, which it reports the same way.
     */
    readonly signIn = false,
  ) {
    super(message);
    this.name = "LaMarzoccoError";
  }
}

const thing = z.looseObject({
  serialNumber: z.string(),
  type: z.string().default("CoffeeMachine"),
  name: z.string().nullish(),
  modelCode: z.string().nullish(),
  modelName: z.string().nullish(),
  connected: z.boolean().default(false),
});
export type Thing = z.infer<typeof thing>;

const widget = z.looseObject({
  code: z.string(),
  index: z.number().default(1),
  output: z.record(z.string(), z.unknown()).nullish(),
});

const dashboard = thing.extend({ widgets: z.array(widget).default([]) });

const commandOutcome = z.looseObject({
  id: z.string(),
  status: z.string(),
  errorCode: z.string().nullish(),
});
export type CommandOutcome = z.infer<typeof commandOutcome>;

/**
 * What the socket sends: the whole widget set on a change, or only command outcomes with no
 * widgets. Widgets and commands are read one by one, so one odd entry does not lose the rest.
 */
export function readUpdate(raw: unknown): {
  view?: MachineView;
  commands: CommandOutcome[];
  skipped: number;
} {
  const update = z
    .looseObject({
      connected: z.boolean().default(true),
      widgets: z.array(z.unknown()).default([]),
      commands: z.array(z.unknown()).default([]),
    })
    .parse(raw);
  let skipped = 0;
  const each = <T>(items: unknown[], schema: z.ZodType<T>): T[] =>
    items.flatMap((item) => {
      const parsed = schema.safeParse(item);
      if (!parsed.success) skipped++;
      return parsed.success ? [parsed.data] : [];
    });
  const widgets = each(update.widgets, widget);
  const commands = each(update.commands, commandOutcome);
  return {
    // No widgets means nothing about the machine changed, not that it has no state.
    view: widgets.length > 0 ? machineView(widgets, update.connected) : undefined,
    commands,
    skipped,
  };
}

const commandResponse = z.array(z.looseObject({ id: z.string(), status: z.string() })).min(1);

const tokens = z.looseObject({ accessToken: z.string(), refreshToken: z.string() });

// ───────────────────────── What a dashboard says ─────────────────────────

export interface Boiler {
  /** StandBy, HeatingUp, Ready, NoWater, EcoMode, Off. */
  status: string;
  enabled: boolean;
  /** Whether the app can switch it; a Mini R's coffee boiler cannot be. */
  enabledSupported: boolean;
  /** While heating, when the machine expects to reach temperature (epoch ms). */
  readyAt?: number;
  targetTemperature?: number;
  /** A steam boiler set by level rather than degrees: Level1 to Level3. */
  targetLevel?: string;
}

export interface MachineView {
  /** The machine is online with the cloud. */
  connected: boolean;
  /** BrewingMode, EcoMode or StandBy: what the machine has been told to be. */
  mode?: string;
  /** StandBy, PoweredOn, Brewing, EcoMode or Off: what it is doing. */
  status?: string;
  /** When the current shot started, while brewing (epoch ms). */
  brewingSince?: number;
  coffee?: Boiler;
  steam?: Boiler;
  noWater?: boolean;
}

const text = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function boiler(output: Record<string, unknown>): Boiler {
  return {
    status: text(output.status) ?? "Off",
    enabled: output.enabled !== false,
    enabledSupported: output.enabledSupported === true,
    readyAt: num(output.readyStartTime),
    targetTemperature: num(output.targetTemperature),
    targetLevel: text(output.targetLevel),
  };
}

/** Reads the widgets this integration uses; any it does not know are ignored. */
export function machineView(
  widgets: { code: string; index?: number; output?: Record<string, unknown> | null }[],
  connected: boolean,
): MachineView {
  const find = (code: string) =>
    widgets.find((w) => w.code === code && (w.index ?? 1) === 1)?.output ?? undefined;
  const status = find("CMMachineStatus");
  const coffee = find("CMCoffeeBoiler");
  // A Mini R or Micra sets steam by level; a GS3 or Linea Mini by temperature.
  const steam = find("CMSteamBoilerLevel") ?? find("CMSteamBoilerTemperature");
  const water = find("CMNoWater");
  return {
    connected,
    mode: text(status?.mode),
    status: text(status?.status),
    brewingSince: num(status?.brewingStartTime),
    coffee: coffee && boiler(coffee),
    steam: steam && boiler(steam),
    noWater: water ? water.allarm === true : undefined, // sic: the cloud spells it "allarm"
  };
}

// ───────────────────────── The client ─────────────────────────

export interface DashboardHandlers {
  /** `view` is undefined for a message that only carries command outcomes. */
  onUpdate(view: MachineView | undefined, commands: CommandOutcome[]): void;
  /** The socket closed or failed; not called after a local close(). */
  onClose(error: Error): void;
  /** A message, or part of one, that could not be read. */
  onUnreadable?(detail: string): void;
}

/** A WebSocket ping this often, as the app's library does: STOMP heart-beats are off. */
const PING_MS = 15_000;

export interface DashboardSocket {
  close(): void;
}

export class LaMarzoccoCloud {
  private token?: { access: string; refresh: string; expiresAt: number };
  private signingIn?: Promise<string>;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly installation: Installation,
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Tells the cloud about this installation's key. Once per installation. */
  async register(): Promise<void> {
    const { headers, body } = this.installation.registration();
    const response = await this.send(`${BASE}/auth/init`, "POST", headers, body);
    if (!response.ok)
      throw new LaMarzoccoError(
        `La Marzocco refused to register this installation (${response.status})`,
        response.status === 401,
      );
  }

  /** Every machine and grinder on the account. */
  async things(): Promise<Thing[]> {
    return z.array(thing).parse(await this.request("GET", "/things"));
  }

  async dashboard(serial: string): Promise<{ thing: Thing; view: MachineView }> {
    const d = dashboard.parse(await this.request("GET", `/things/${serial}/dashboard`));
    return { thing: d, view: machineView(d.widgets, d.connected) };
  }

  /** Sends a command and returns its id; the outcome arrives on the dashboard socket. */
  async command(serial: string, name: string, body: Record<string, unknown>): Promise<string> {
    const reply = commandResponse.parse(
      await this.request("POST", `/things/${serial}/command/${name}`, body),
    );
    const [first] = reply;
    if (first?.status === "Error" || first?.status === "Failed")
      throw new LaMarzoccoError(`The machine refused ${name}`);
    return first?.id ?? "";
  }

  /** Resolves once subscribed to the machine's dashboard; `signal` cancels it at any point. */
  async connectDashboard(
    serial: string,
    handlers: DashboardHandlers,
    open: OpenSocket = openSocket,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<DashboardSocket> {
    const access = await this.accessToken();
    if (signal?.aborted) throw new LaMarzoccoError("the connection was cancelled");
    return new Promise((resolve, reject) => {
      const ws = open(`wss://${HOST}/ws/connect`, this.installation.headers(this.now()));
      const subscription = crypto.randomUUID();
      let subscribed = false;
      let closed = false;
      let pinger: ReturnType<typeof setInterval> | undefined;

      const shut = () => {
        closed = true;
        clearTimeout(timer);
        clearInterval(pinger);
        signal?.removeEventListener("abort", close);
      };
      /** The server ended it, or it failed. */
      const end = (error: Error) => {
        if (closed) return;
        shut();
        try {
          ws.close();
        } catch {}
        if (subscribed) handlers.onClose(error);
        else reject(error);
      };
      /** This side ended it: no onClose. */
      function close() {
        if (closed) return;
        shut();
        try {
          if (subscribed) ws.send(encodeFrame("UNSUBSCRIBE", { id: subscription }));
          ws.close();
        } catch {}
        if (!subscribed) reject(new LaMarzoccoError("the connection was cancelled"));
      }
      const timer = setTimeout(
        () => end(new LaMarzoccoError("timed out connecting to La Marzocco's socket")),
        timeoutMs,
      );
      signal?.addEventListener("abort", close);

      ws.addEventListener("open", () => {
        ws.send(
          encodeFrame("CONNECT", {
            host: HOST,
            "accept-version": "1.2,1.1,1.0",
            "heart-beat": "0,0",
            Authorization: `Bearer ${access}`,
          }),
        );
      });
      ws.addEventListener("error", () => end(new LaMarzoccoError("La Marzocco's socket failed")));
      ws.addEventListener("close", () => end(new LaMarzoccoError("La Marzocco closed the socket")));
      ws.addEventListener("message", (event) => {
        const frame = decodeFrame(String(event.data));
        if (!frame) return;
        if (frame.command === "ERROR") {
          // Most often a token the cloud stopped accepting early; the next attempt signs in again.
          if (this.token?.access === access) this.token = undefined;
          return end(
            new LaMarzoccoError(
              `La Marzocco's socket: ${frame.headers.message ?? (frame.body || "error")}`,
            ),
          );
        }
        if (frame.command === "CONNECTED" && !subscribed) {
          ws.send(
            encodeFrame("SUBSCRIBE", {
              destination: `/ws/sn/${serial}/dashboard`,
              ack: "auto",
              id: subscription,
              "content-length": "0",
            }),
          );
          subscribed = true;
          clearTimeout(timer);
          // STOMP heart-beats are off, so without pings a quietly dropped connection would
          // look open for ever.
          if (ws.ping) pinger = setInterval(() => ws.ping?.(), PING_MS);
          resolve({ close });
          return;
        }
        if (frame.command !== "MESSAGE") return;
        let update: ReturnType<typeof readUpdate>;
        try {
          update = readUpdate(JSON.parse(frame.body));
        } catch (err) {
          // One unreadable message is not a reason to drop the socket.
          handlers.onUnreadable?.(err instanceof Error ? err.message : String(err));
          return;
        }
        if (update.skipped > 0)
          handlers.onUnreadable?.(`${update.skipped} widgets or commands were not understood`);
        handlers.onUpdate(update.view, update.commands);
      });
    });
  }

  // ───────────── Tokens ─────────────

  async accessToken(): Promise<string> {
    const t = this.token;
    if (t && t.expiresAt - TOKEN_REFRESH_MS > this.now()) return t.access;
    const refreshable = t !== undefined && t.expiresAt > this.now();
    this.signingIn ??= (refreshable ? this.refresh(t.refresh) : this.signIn())
      .catch((err) => (refreshable ? this.signIn() : Promise.reject(err)))
      .finally(() => {
        this.signingIn = undefined;
      });
    return this.signingIn;
  }

  private signIn(): Promise<string> {
    return this.tokenRequest("/auth/signin", {
      username: this.username,
      password: this.password,
    });
  }

  private refresh(refreshToken: string): Promise<string> {
    return this.tokenRequest("/auth/refreshtoken", { username: this.username, refreshToken });
  }

  private async tokenRequest(path: string, body: Record<string, string>): Promise<string> {
    const response = await this.send(
      `${BASE}${path}`,
      "POST",
      this.installation.headers(this.now()),
      body,
    );
    if (response.status === 401 || response.status === 403)
      throw new LaMarzoccoError("La Marzocco refused the username or password", true, true);
    if (!response.ok)
      throw new LaMarzoccoError(`La Marzocco's sign-in answered ${response.status}`);
    const t = tokens.parse(await response.json());
    this.token = {
      access: t.accessToken,
      refresh: t.refreshToken,
      expiresAt: this.now() + TOKEN_LIFETIME_MS,
    };
    return t.accessToken;
  }

  // ───────────── Requests ─────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    const access = await this.accessToken();
    const response = await this.send(
      `${BASE}${path}`,
      method,
      { ...this.installation.headers(this.now()), Authorization: `Bearer ${access}` },
      body,
    );
    if (response.status === 401 && !retried) {
      // A token the cloud dropped early: sign in again, once.
      this.token = undefined;
      return this.request(method, path, body, true);
    }
    if (response.status === 401) throw new LaMarzoccoError("La Marzocco refused the sign-in", true);
    if (response.status === 403) {
      const code = z
        .looseObject({ code: z.string() })
        .safeParse(await response.json().catch(() => undefined));
      if (code.success && code.data.code === "USER_MUST_ACCEPT_POLICY")
        throw new LaMarzoccoError(
          "La Marzocco wants its latest privacy policy accepted: open the La Marzocco app and accept it",
          true,
        );
      throw new LaMarzoccoError(`La Marzocco refused ${method} ${path}`, true);
    }
    if (!response.ok) throw new LaMarzoccoError(`La Marzocco answered ${response.status}`);
    const raw = await response.text();
    return raw.trim() === "" ? {} : (JSON.parse(raw) as unknown);
  }

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await this.fetch(url, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new LaMarzoccoError(
        `Cannot reach La Marzocco: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
