// A stand-in IQ Panel: speaks the Control4 line protocol over TLS from a fixture summary,
// records the actions it receives, and arms and disarms like a panel with a known user code.

type Row = Record<string, unknown>;

const FIXTURES = new URL("../../../tests/fixtures/qolsys/", import.meta.url);
export const SUMMARY_URL = new URL("summary.synthetic.json", FIXTURES);
export const TOKEN = "abc123";
export const USER_CODE = "123456";

export interface FakePanelOptions {
  port?: number;
  /** Report exit delays the old way, as `EXIT_DELAY` with no mode. */
  oldFirmware?: boolean;
}

export class FakePanel {
  /** Every action received, in order. */
  readonly actions: Row[] = [];
  port = 0;
  private summary!: Row;
  private server?: Bun.TCPSocketListener<undefined>;
  private readonly sockets = new Set<Bun.Socket<undefined>>();

  private constructor(private readonly opts: FakePanelOptions) {}

  static async start(opts: FakePanelOptions = {}): Promise<FakePanel> {
    const panel = new FakePanel(opts);
    panel.summary = (await Bun.file(SUMMARY_URL).json()) as Row;
    panel.listen(opts.port ?? 0);
    return panel;
  }

  get connections(): number {
    return this.sockets.size;
  }

  private get partition(): Row {
    return (this.summary.partition_list as Row[])[0] as Row;
  }

  /** Pushes an event to every client. */
  emit(event: Row): void {
    const line = `${JSON.stringify({ version: 1, requestID: "fake", ...event })}\n`;
    for (const socket of this.sockets) socket.write(line);
  }

  /** A zone changed state: the partial ZONE_ACTIVE the panel sends first. */
  zoneActive(zoneId: number, status: string): void {
    this.emit({
      event: "ZONE_EVENT",
      zone_event_type: "ZONE_ACTIVE",
      zone: { status, zone_id: zoneId },
    });
  }
  zoneUpdate(zone: Row): void {
    this.emit({ event: "ZONE_EVENT", zone_event_type: "ZONE_UPDATE", zone });
  }
  zoneAdd(zone: Row): void {
    (this.partition.zone_list as Row[]).push(zone);
    this.emit({ event: "ZONE_EVENT", zone_event_type: "ZONE_ADD", zone });
  }
  zoneDelete(zoneId: number): void {
    const list = this.partition.zone_list as Row[];
    const index = list.findIndex((z) => z.zone_id === zoneId);
    if (index >= 0) list.splice(index, 1);
    this.emit({ event: "ZONE_EVENT", zone_event_type: "ZONE_DELETE", zone: { zone_id: zoneId } });
  }
  arming(type: string, partitionId = 0): void {
    this.partition.status = type;
    this.emit({ event: "ARMING", arming_type: type, partition_id: partitionId });
  }
  alarm(alarmType: string, partitionId = 0): void {
    this.partition.status = "ALARM";
    this.emit({ event: "ALARM", alarm_type: alarmType, partition_id: partitionId });
  }

  /** Stops listening and drops every client; `listen` brings it back on the same port. */
  stop(): void {
    for (const socket of this.sockets) socket.end();
    this.sockets.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  listen(port = this.port): void {
    const fake = this;
    const buffers = new Map<Bun.Socket<undefined>, string>();
    this.server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port,
      tls: {
        cert: Bun.file(new URL("fake-panel.cert.synthetic.pem", FIXTURES)),
        key: Bun.file(new URL("fake-panel.key.synthetic.pem", FIXTURES)),
      },
      socket: {
        open(socket) {
          fake.sockets.add(socket);
          buffers.set(socket, "");
        },
        data(socket, chunk) {
          let buffer = (buffers.get(socket) ?? "") + chunk.toString();
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (line) fake.receive(socket, JSON.parse(line) as Row);
          }
          buffers.set(socket, buffer);
        },
        close(socket) {
          fake.sockets.delete(socket);
          buffers.delete(socket);
        },
        error() {},
      },
    });
    this.port = this.server.port;
  }

  private receive(socket: Bun.Socket<undefined>, action: Row): void {
    socket.write("ACK\n");
    if (action.token !== TOKEN) return; // a real panel is silent to a bad token
    if (action.action === "INFO") {
      socket.write(`${JSON.stringify(this.summary)}\n`);
      return;
    }
    this.actions.push(action);
    if (action.action !== "ARMING") return;
    const partitionId = Number(action.partition_id ?? 0);
    if (action.usercode !== USER_CODE) {
      this.emit({
        event: "ERROR",
        error_type: action.arming_type === "DISARM" ? "DISARM_FAILED" : "usercode",
        description: "Invalid usercode",
        partition_id: partitionId,
        nonce: "qolsys",
      });
      return;
    }
    switch (action.arming_type) {
      case "DISARM":
        this.arming("DISARM", partitionId);
        break;
      case "ARM_STAY":
        this.arming(this.opts.oldFirmware ? "EXIT_DELAY" : "ARM-STAY-EXIT-DELAY", partitionId);
        break;
      case "ARM_AWAY":
        this.arming(this.opts.oldFirmware ? "EXIT_DELAY" : "ARM-AWAY-EXIT-DELAY", partitionId);
        break;
      default:
        break;
    }
  }
}
