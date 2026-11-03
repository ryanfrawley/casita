// A stand-in for La Marzocco's cloud: a fetch function that checks each request's signature
// against the key registered at /auth/init, serves a fixture machine, obeys mode and steam
// commands, and a dashboard socket that pushes the machine's state as it changes.

import { createPublicKey, verify } from "node:crypto";
import type { Fetch, OpenSocket, Socket } from "../src/api.ts";
import { deriveSecret, requestProof } from "../src/signing.ts";
import { decodeFrame, encodeFrame } from "../src/stomp.ts";

type Row = Record<string, unknown>;

const fixture = (name: string) =>
  new URL(`../../../tests/fixtures/lamarzocco/${name}`, import.meta.url);

export const NOW = 1_762_000_000_000;

export class FakeSocket implements Socket {
  private readonly listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
  readonly sent: string[] = [];
  closed = false;
  subscribed?: string;

  constructor(
    private readonly cloud: FakeLaMarzocco,
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    queueMicrotask(() => {
      if (!cloud.socketsRefused) return this.emit("open");
      this.emit("error");
      this.emit("close");
    });
  }

  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = decodeFrame(data);
    if (frame?.command === "CONNECT") {
      if (this.cloud.holdConnect) return;
      const ok =
        frame.headers.Authorization === `Bearer ${this.cloud.accessToken}` &&
        this.cloud.signed(this.headers);
      queueMicrotask(() =>
        this.emit(
          "message",
          ok
            ? encodeFrame("CONNECTED", { version: "1.2" })
            : encodeFrame("ERROR", { message: "Unauthorized" }),
        ),
      );
    }
    if (frame?.command === "SUBSCRIBE") {
      if (this.cloud.refuseSubscription) {
        queueMicrotask(() => this.emit("message", encodeFrame("ERROR", { message: "Forbidden" })));
        return;
      }
      this.subscribed = frame.headers.destination;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  /** The server pushes a dashboard update. */
  push(body: Row): void {
    if (this.closed || !this.subscribed) return;
    this.emit(
      "message",
      encodeFrame(
        "MESSAGE",
        { destination: this.subscribed, subscription: "sub-0", "message-id": "m" },
        JSON.stringify(body),
      ),
    );
  }

  /** The server drops the connection. */
  drop(): void {
    this.closed = true;
    this.emit("close");
  }
}

export class FakeLaMarzocco {
  /** Every request made, as "METHOD /path" plus its JSON body. */
  readonly requests: { call: string; body?: Row }[] = [];
  readonly sockets: FakeSocket[] = [];
  password = "good-password";
  accessToken = "access-1";
  /** Set to make every request fail at the network level. */
  down = false;
  socketsRefused = false;
  /** The socket opens but CONNECTED never comes. */
  holdConnect = false;
  /** CONNECTED comes, but SUBSCRIBE is answered with an ERROR frame. */
  refuseSubscription = false;
  /** Pushes the dashboard to open sockets after each command; off to test polling. */
  pushOnCommand = true;
  /** The status the next command reports on the socket. */
  commandStatus = "Success";
  private publicKey?: ReturnType<typeof createPublicKey>;
  private installationId?: string;
  private tokenCount = 1;

  private constructor(
    readonly things: Row[],
    readonly dashboard: Row & { widgets: { code: string; output: Row }[] },
  ) {}

  static async create(): Promise<FakeLaMarzocco> {
    return new FakeLaMarzocco(
      (await Bun.file(fixture("things.synthetic.json")).json()) as Row[],
      (await Bun.file(fixture("dashboard-minir.synthetic.json")).json()) as never,
    );
  }

  widget(code: string): Row {
    const w = this.dashboard.widgets.find((x) => x.code === code);
    if (!w) throw new Error(`no widget ${code}`);
    return w.output;
  }

  /** The cloud forgets the registered key, as if the installation had been removed. */
  forget(): void {
    this.publicKey = undefined;
    this.installationId = undefined;
  }

  calls(prefix = ""): string[] {
    return this.requests.map((r) => r.call).filter((c) => c.includes(prefix));
  }

  get socket(): FakeSocket | undefined {
    return this.sockets.at(-1);
  }

  /** The coffee boiler reaches temperature. */
  heated(): void {
    this.widget("CMCoffeeBoiler").status = "Ready";
    this.widget("CMCoffeeBoiler").readyStartTime = null;
    this.publish();
  }

  publish(commands: Row[] = []): void {
    for (const s of this.sockets)
      s.push({
        connected: this.dashboard.connected,
        widgets: this.dashboard.widgets,
        removedWidgets: [],
        connectionDate: NOW,
        uuid: "u",
        commands,
      });
  }

  /** Whether headers carry a valid proof and signature from the registered installation. */
  signed(headers: Record<string, string> | Headers): boolean {
    const h = new Headers(headers);
    const id = h.get("X-App-Installation-Id");
    const [nonce, timestamp, signature] = [
      h.get("X-Nonce"),
      h.get("X-Timestamp"),
      h.get("X-Request-Signature"),
    ];
    if (!this.publicKey || id !== this.installationId || !nonce || !timestamp || !signature)
      return false;
    const der = this.publicKey.export({ format: "der", type: "spki" });
    const input = `${id}.${nonce}.${timestamp}`;
    const proof = requestProof(input, deriveSecret(id, der));
    return verify(
      "sha256",
      Buffer.from(`${input}.${proof}`),
      this.publicKey,
      Buffer.from(signature, "base64"),
    );
  }

  readonly openSocket: OpenSocket = (url, headers) => {
    const socket = new FakeSocket(this, url, headers);
    this.sockets.push(socket);
    return socket;
  };

  readonly fetch: Fetch = async (url, init) => {
    if (this.down) throw new Error("getaddrinfo ENOTFOUND lion.lamarzocco.io");
    const path = new URL(url).pathname.replace("/api/customer-app", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : undefined;
    this.requests.push({ call: `${method} ${path}`, body });
    const headers = new Headers(init?.headers);
    const reply = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });

    if (path === "/auth/init") {
      const id = headers.get("X-App-Installation-Id") ?? "";
      const der = Buffer.from(String(body?.pk), "base64");
      const base = `${id}.${new Bun.CryptoHasher("sha256").update(der).digest("base64")}`;
      if (headers.get("X-Request-Proof") !== requestProof(base, deriveSecret(id, der)))
        return reply(401, { message: "bad proof" });
      this.installationId = id;
      this.publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
      return reply(200, {});
    }
    if (!this.signed(headers)) return reply(401, { message: "bad signature" });
    if (path === "/auth/signin" || path === "/auth/refreshtoken") {
      if (path === "/auth/signin" && body?.password !== this.password)
        return reply(401, { message: "Invalid credentials" });
      this.accessToken = `access-${this.tokenCount++}`;
      return reply(200, { accessToken: this.accessToken, refreshToken: "refresh" });
    }
    if (headers.get("authorization") !== `Bearer ${this.accessToken}`) return reply(401);

    if (path === "/things") return reply(200, this.things);
    const serial = this.dashboard.serialNumber;
    if (path === `/things/${serial}/dashboard`) return reply(200, this.dashboard);
    const command = new RegExp(`^/things/${serial}/command/(\\w+)$`).exec(path)?.[1];
    if (command === "CoffeeMachineChangeMode") {
      const on = body?.mode === "BrewingMode";
      Object.assign(this.widget("CMMachineStatus"), {
        mode: body?.mode,
        status: on ? "PoweredOn" : "StandBy",
      });
      Object.assign(this.widget("CMCoffeeBoiler"), {
        status: on ? "HeatingUp" : "StandBy",
        readyStartTime: on ? NOW + 20 * 60_000 : null,
      });
      return this.commanded();
    }
    if (command === "CoffeeMachineSettingSteamBoilerEnabled") {
      this.widget("CMSteamBoilerLevel").enabled = body?.enabled === true;
      return this.commanded();
    }
    return reply(404);
  };

  private commanded(): Response {
    const id = `cmd-${this.requests.length}`;
    if (this.pushOnCommand)
      queueMicrotask(() => this.publish([{ id, status: this.commandStatus, errorCode: null }]));
    return new Response(JSON.stringify([{ id, status: "Pending" }]), { status: 200 });
  }
}
