// A stand-in ESPHome device: a local TCP server speaking the native API, in plaintext or
// with Noise encryption, built from a fixture of entities and states.

import type { Messages } from "../src/api.gen.ts";
import {
  type CipherState,
  ESPHOME_PROLOGUE,
  encodeNoiseFrame,
  Handshake,
  NoiseFrameReader,
  packMessage,
  unpackMessage,
} from "../src/noise.ts";
import {
  type AnyMessage,
  concat,
  decodeMessage,
  encodeMessage,
  encodePlainFrame,
  type Frame,
  type MessageName,
  PlainFrameReader,
} from "../src/proto.ts";

type Kind = "Switch" | "Light" | "Sensor" | "BinarySensor" | "Cover" | "Button";
type Row = Record<string, unknown> & { type: Kind; key: number };

export interface Fixture {
  info: Partial<Messages["DeviceInfoResponse"]>;
  entities: Row[];
  states: Row[];
}

export const FIXTURE_URL = new URL(
  "../../../tests/fixtures/esphome/device.synthetic.json",
  import.meta.url,
);
export const loadFixture = async (): Promise<Fixture> =>
  (await Bun.file(FIXTURE_URL).json()) as Fixture;

interface Client {
  write(bytes: Uint8Array): void;
  end(): void;
  plain: PlainFrameReader;
  noise: NoiseFrameReader;
  handshake?: Handshake;
  ciphers?: { send: CipherState; receive: CipherState };
  subscribed: boolean;
}

export interface FakeDeviceOptions {
  /** Base64 key; when set the device accepts only encrypted connections. */
  encryptionKey?: string;
  password?: string;
  port?: number;
}

export class FakeDevice {
  /** Every message clients sent, in order. */
  readonly received: AnyMessage[] = [];
  port = 0;
  private readonly clients = new Set<Client>();
  private readonly states = new Map<number, Row>();
  private server?: { stop(closeActive?: boolean): void; port: number };

  private constructor(
    private readonly fixture: Fixture,
    private readonly opts: FakeDeviceOptions,
  ) {
    for (const state of fixture.states) this.states.set(state.key, state);
  }

  static async start(opts: FakeDeviceOptions = {}, fixture?: Fixture): Promise<FakeDevice> {
    const device = new FakeDevice(fixture ?? (await loadFixture()), opts);
    device.listen(opts.port ?? 0);
    return device;
  }

  get connections(): number {
    return this.clients.size;
  }

  /** Commands received, as [message name, fields that were set]. */
  commands(): AnyMessage[] {
    return this.received.filter((m) => m.name.endsWith("CommandRequest"));
  }

  /** The device changes state on its own and tells subscribed clients. */
  report(state: Row): void {
    const next = { ...this.states.get(state.key), ...state };
    this.states.set(state.key, next);
    for (const client of this.clients) if (client.subscribed) this.sendState(client, next);
  }

  /** Sends any message to every client, e.g. a DisconnectRequest before a reboot. */
  broadcast<K extends MessageName>(name: K, value?: Partial<Messages[K]>): void {
    for (const client of this.clients) this.send(client, name, value);
  }

  /** Cuts every connection without warning, as a power loss would. */
  drop(): void {
    for (const client of [...this.clients]) client.end();
    this.clients.clear();
  }

  /** Stops listening and drops clients; `listen` again to come back on the same port. */
  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    this.clients.clear();
  }

  listen(port = this.port): void {
    const device = this;
    const server = Bun.listen<Client | undefined>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          const client: Client = {
            write: (bytes) => void socket.write(bytes),
            end: () => socket.end(),
            plain: new PlainFrameReader(),
            noise: new NoiseFrameReader(),
            subscribed: false,
          };
          socket.data = client;
          device.clients.add(client);
        },
        data(socket, chunk) {
          const client = socket.data;
          if (!client) return;
          try {
            device.receive(client, chunk);
          } catch {
            // A real encrypted device answers a plaintext client with this before hanging up.
            if (device.opts.encryptionKey) {
              const reason = new TextEncoder().encode("Bad indicator byte");
              socket.write(encodeNoiseFrame(concat(Uint8Array.of(0x01), reason)));
            }
            socket.end();
          }
        },
        close(socket) {
          if (socket.data) device.clients.delete(socket.data);
        },
      },
    });
    this.server = server;
    this.port = server.port;
  }

  private receive(client: Client, chunk: Uint8Array): void {
    if (!this.opts.encryptionKey) {
      for (const frame of client.plain.push(chunk)) this.handle(client, frame);
      return;
    }
    for (const payload of client.noise.push(chunk)) {
      if (client.ciphers) {
        this.handle(client, unpackMessage(client.ciphers.receive.decrypt(payload)));
      } else if (payload.length > 0) {
        // The handshake message; the empty frame before it is the client hello.
        const key = new Uint8Array(Buffer.from(this.opts.encryptionKey, "base64"));
        const handshake = new Handshake("responder", key, ESPHOME_PROLOGUE);
        const name = new TextEncoder().encode(`${this.fixture.info.name}\0`);
        client.write(encodeNoiseFrame(concat(Uint8Array.of(0x01), name)));
        try {
          handshake.readFirst(payload.subarray(1));
        } catch {
          const reason = new TextEncoder().encode("Handshake MAC failure");
          client.write(encodeNoiseFrame(concat(Uint8Array.of(0x01), reason)));
          client.end();
          return;
        }
        client.write(encodeNoiseFrame(concat(Uint8Array.of(0x00), handshake.writeSecond())));
        client.ciphers = handshake.split();
      }
    }
  }

  private send<K extends MessageName>(client: Client, name: K, value?: Partial<Messages[K]>): void {
    const frame: Frame = encodeMessage(name, value);
    client.write(
      client.ciphers
        ? encodeNoiseFrame(client.ciphers.send.encrypt(packMessage(frame)))
        : encodePlainFrame(frame),
    );
  }

  private sendState(client: Client, state: Row): void {
    const { type, ...fields } = state;
    if (type === "Button") return;
    this.send(client, `${type}StateResponse`, fields);
  }

  private handle(client: Client, frame: Frame): void {
    const decoded = decodeMessage(frame);
    if (!decoded) return;
    this.received.push(decoded);
    const { name, message } = decoded;
    switch (name) {
      case "HelloRequest":
        this.send(client, "HelloResponse", {
          apiVersionMajor: 1,
          apiVersionMinor: 10,
          serverInfo: "fake",
          name: this.fixture.info.name,
        });
        break;
      case "AuthenticationRequest":
        this.send(client, "AuthenticationResponse", {
          invalidPassword:
            this.opts.password !== undefined && message.password !== this.opts.password,
        });
        break;
      case "DeviceInfoRequest":
        this.send(client, "DeviceInfoResponse", this.fixture.info);
        break;
      case "ListEntitiesRequest":
        for (const { type, ...fields } of this.fixture.entities) {
          this.send(client, `ListEntities${type}Response`, fields);
        }
        this.send(client, "ListEntitiesDoneResponse");
        break;
      case "SubscribeStatesRequest":
        client.subscribed = true;
        for (const state of this.states.values()) this.sendState(client, state);
        break;
      case "PingRequest":
        this.send(client, "PingResponse");
        break;
      case "DisconnectRequest":
        this.send(client, "DisconnectResponse");
        client.end();
        break;
      case "SwitchCommandRequest":
        this.report({ type: "Switch", key: message.key, state: message.state });
        break;
      case "LightCommandRequest":
        this.report({
          type: "Light",
          key: message.key,
          ...(message.hasState ? { state: message.state } : {}),
          ...(message.hasBrightness ? { brightness: message.brightness } : {}),
          ...(message.hasColorMode ? { colorMode: message.colorMode } : {}),
          ...(message.hasColorTemperature ? { colorTemperature: message.colorTemperature } : {}),
          ...(message.hasRgb ? { red: message.red, green: message.green, blue: message.blue } : {}),
        });
        break;
      case "CoverCommandRequest":
        if (message.hasPosition)
          this.report({ type: "Cover", key: message.key, position: message.position });
        break;
      default:
        break;
    }
  }
}
