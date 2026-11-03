// A stand-in zwave-js-server: speaks the WebSocket protocol from a fixture node dump,
// records the commands it receives, and behaves like devices that obey set_value.

type Row = Record<string, unknown>;

export const FIXTURE_URL = new URL(
  "../../../tests/fixtures/zwave-js/node-dump.synthetic.json",
  import.meta.url,
);
export const HOME_ID = 3405691582;

export interface FakeServerOptions {
  minSchemaVersion?: number;
  maxSchemaVersion?: number;
  port?: number;
  /** The controller is busy: begin_inclusion answers `{ success: false }`. */
  busy?: boolean;
  /** Another node dump in place of the main fixture. */
  fixture?: URL;
}

/** The fixture of nodes with configuration parameters, from three Inovelli models. */
export const CONFIG_FIXTURE_URL = new URL(
  "../../../tests/fixtures/zwave-js/config-nodes.synthetic.json",
  import.meta.url,
);

/**
 * QR codes as `utils.parse_qr_code_string` would read them. A real code is digits only
 * ("90" + version + checksum + keys + DSK + TLVs); these only need to be told apart.
 */
export const QR = {
  smartStart: "9001-smartstart-fixture",
  smartStartLongRange: "9001-smartstart-lr-fixture",
  s2: "9000-s2-fixture",
} as const;
export const QR_DSK = "12345-00000-11111-22222-33333-44444-55555-66666";

const parseQr = (qr: string): Row | undefined => {
  if (!Object.values(QR).includes(qr as (typeof QR)[keyof typeof QR])) return undefined;
  return {
    version: qr === QR.s2 ? 0 : 1,
    securityClasses: [0, 1, 2],
    dsk: QR_DSK,
    genericDeviceClass: 16,
    specificDeviceClass: 1,
    installerIconType: 1792,
    manufacturerId: 634,
    productType: 40961,
    productId: 1,
    applicationVersion: "1.0",
    ...(qr === QR.smartStartLongRange ? { supportedProtocols: [0, 1] } : {}),
  };
};

export class FakeZwaveServer {
  /** Every command received after the handshake, in order. */
  readonly commands: Row[] = [];
  /** SmartStart entries, as `controller.get_provisioning_entries` lists them. */
  readonly provisioned: Row[] = [];
  /** The last raw value written to each parameter, by `<node>-<parameter>`. */
  readonly raw = new Map<string, number>();
  port = 0;
  private server?: ReturnType<typeof Bun.serve>;
  private readonly sockets = new Set<{ send(data: string): unknown; close(): void }>();

  private constructor(
    private readonly dump: Row,
    private readonly opts: FakeServerOptions,
  ) {}

  static async start(opts: FakeServerOptions = {}): Promise<FakeZwaveServer> {
    const fixture = (await Bun.file(opts.fixture ?? FIXTURE_URL).json()) as Row;
    const server = new FakeZwaveServer(fixture, opts);
    server.listen(opts.port ?? 0);
    return server;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get connections(): number {
    return this.sockets.size;
  }

  /** Pushes an event to every client, as the driver would. */
  emit(event: Row): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({ type: "event", event }));
  }

  valueUpdated(nodeId: number, valueId: Row, newValue: unknown): void {
    this.emit({
      source: "node",
      event: "value updated",
      nodeId,
      args: { endpoint: 0, ...valueId, newValue },
    });
  }

  /** The driver's S2 prompts, sent to the client that began the inclusion. */
  askSecurityClasses(securityClasses: number[]): void {
    this.emit({
      source: "controller",
      event: "grant security classes",
      requested: { securityClasses, clientSideAuth: false },
    });
  }
  askPin(): void {
    // The driver shows the DSK with its first block, the PIN, left out.
    this.emit({ source: "controller", event: "validate dsk and enter pin", dsk: QR_DSK.slice(6) });
  }
  /** A node joined; `lowSecurityReason` is zwave-js's SecurityBootstrapFailure. */
  nodeAdded(nodeId: number, highestSecurityClass: number | null, lowSecurityReason?: number): void {
    this.emit({
      source: "controller",
      event: "node added",
      node: { nodeId, status: 0, ready: false, highestSecurityClass, values: [] },
      result:
        lowSecurityReason === undefined
          ? { lowSecurity: false }
          : { lowSecurity: true, lowSecurityReason },
    });
  }

  /** The masks of a partial parameter's parts, from the dump. */
  partsOf(nodeId: number, parameter: number): number[] {
    const nodes = ((this.dump.state as Row).nodes ?? []) as Row[];
    const values = (nodes.find((n) => n.nodeId === nodeId)?.values ?? []) as Row[];
    return values
      .filter((v) => v.commandClass === 112 && v.property === parameter)
      .map((v) => v.propertyKey)
      .filter((key): key is number => typeof key === "number");
  }

  /** Stops listening and drops every client; `listen` brings it back on the same port. */
  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    this.sockets.clear();
  }

  listen(port = this.port): void {
    const fake = this;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req, server) {
        return server.upgrade(req, { data: undefined })
          ? undefined
          : new Response("expected a WebSocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          fake.sockets.add(ws);
          ws.send(
            JSON.stringify({
              type: "version",
              driverVersion: "15.0.0",
              serverVersion: "3.0.0",
              homeId: HOME_ID,
              minSchemaVersion: fake.opts.minSchemaVersion ?? 0,
              maxSchemaVersion: fake.opts.maxSchemaVersion ?? 44,
            }),
          );
        },
        message(ws, raw) {
          const { messageId, command, ...params } = JSON.parse(String(raw)) as Row;
          const reply = (body: Row) =>
            ws.send(JSON.stringify({ type: "result", messageId, ...body }));
          if (command === "initialize") return void reply({ success: true, result: {} });
          if (command === "start_listening")
            return void reply({ success: true, result: fake.dump });
          fake.commands.push({ command, ...params });

          if (command === "node.set_value") {
            const { nodeId, valueId, value } = params as {
              nodeId: number;
              valueId: Row;
              value: unknown;
            };
            if (nodeId === 8) {
              return void reply({
                success: false,
                errorCode: "zwave_error",
                zwaveErrorMessage: "Node 8 is dead",
              });
            }
            // A configuration parameter reports back as itself; zwave-js answers a value the
            // device refuses with a status, not an error. 77 stands for one it refuses.
            if (valueId.commandClass === 112) {
              if (value === 77)
                return void reply({ success: true, result: { result: { status: 5 } } });
              reply({ success: true, result: { result: { status: 255 } } });
              return fake.valueUpdated(nodeId, valueId, value);
            }
            reply({ success: true, result: { status: 255 } });
            // The device obeys: its current value follows the target.
            const property = String(valueId.property).replace("target", "current");
            const reported = valueId.commandClass === 38 && value === 255 ? 80 : value;
            fake.valueUpdated(nodeId, { ...valueId, property }, reported);
            return;
          }
          if (command === "utils.parse_qr_code_string") {
            const qrProvisioningInformation = parseQr(String(params.qr));
            return void (qrProvisioningInformation
              ? reply({ success: true, result: { qrProvisioningInformation } })
              : reply({
                  success: false,
                  errorCode: "zwave_error",
                  zwaveErrorMessage: "Invalid QR code",
                }));
          }
          if (command === "controller.provision_smart_start_node") {
            fake.provisioned.push({ ...(params.entry as Row), status: 0 });
            return void reply({ success: true, result: {} });
          }
          if (command === "controller.get_provisioning_entries") {
            return void reply({ success: true, result: { entries: fake.provisioned } });
          }
          if (command === "controller.unprovision_smart_start_node") {
            const index = fake.provisioned.findIndex(
              (e) => e.dsk === params.dskOrNodeId || e.nodeId === params.dskOrNodeId,
            );
            if (index >= 0) fake.provisioned.splice(index, 1);
            return void reply({ success: true, result: {} });
          }
          if (command === "controller.remove_failed_node") {
            reply({ success: true, result: {} });
            fake.emit({
              source: "controller",
              event: "node removed",
              node: { nodeId: params.nodeId },
            });
            return;
          }
          if (command === "controller.begin_inclusion" && fake.opts.busy) {
            return void reply({ success: true, result: { success: false } });
          }
          if (command === "node.get_raw_config_parameter_value") {
            const { nodeId, parameter } = params as { nodeId: number; parameter: number };
            const written = fake.raw.get(`${nodeId}-${parameter}`);
            if (written === undefined) return void reply({ success: true, result: { value: 3 } });
            reply({ success: true, result: { value: written } });
            // The driver splits a report of a partial parameter into its parts.
            for (const mask of fake.partsOf(nodeId, parameter)) {
              let low = 1;
              while ((mask / low) % 2 === 0) low *= 2;
              const part = Math.floor(written / low) % (mask / low + 1);
              fake.valueUpdated(
                nodeId,
                { commandClass: 112, property: parameter, propertyKey: mask },
                part,
              );
            }
            return;
          }
          if (command === "node.set_raw_config_parameter_value") {
            const { nodeId, parameter, value } = params as Record<string, number>;
            fake.raw.set(`${nodeId}-${parameter}`, value as number);
            return void reply({ success: true, result: { result: { status: 255 } } });
          }
          if (typeof command === "string" && /^(controller|endpoint)\./.test(command)) {
            return void reply({ success: true, result: { success: true } });
          }
          reply({
            success: false,
            errorCode: "unknown_command",
            message: `Unknown command ${command}`,
          });
        },
        close(ws) {
          fake.sockets.delete(ws);
        },
      },
    });
    this.port = this.server.port ?? port;
  }
}
