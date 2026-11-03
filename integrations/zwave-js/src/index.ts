// Z-Wave through a Z-Wave JS server (zwave-js-server / Z-Wave JS UI). The server owns the
// radio; this integration maps its node dump to entities and relays value updates and commands.

import type { DeviceId, EntityId, IntegrationContext } from "@casita/core/types";
import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import { connect, type ServerEvent, type ZwaveClient } from "./client.ts";
import {
  composeEffect,
  type EffectRequest,
  type EffectTarget,
  effectCalls,
  effectTargets,
  FIELDS,
  pickTarget,
} from "./effects.ts";
import {
  type EntitySpec,
  entitiesFor,
  NODE_DEAD,
  type NodeValue,
  valueKey,
  type ZwaveNode,
  zwaveNode,
} from "./mapping.ts";
import {
  CONFIGURATION,
  type ConfigParam,
  configParams,
  nodeSettings,
  setSettingCall,
  settingKey,
  writeFailure,
} from "./settings.ts";

const configSchema = z.strictObject({
  serverUrl: z.url({ protocol: /^wss?$/ }).default("ws://localhost:3000"),
});
type Ctx = IntegrationContext<z.infer<typeof configSchema>>;

export interface ZwaveOptions {
  connectTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

interface Tracked {
  nodeId: number;
  deviceId: DeviceId;
  values: Map<string, unknown>;
  entities: { id: EntityId; spec: EntitySpec }[];
  /** Configuration values with the driver's metadata, by value key. */
  config: Map<string, NodeValue>;
  /** Parsed from `config`; rebuilt when its metadata changes. */
  params: ConfigParam[];
}

const metadataArgs = z.looseObject({
  commandClass: z.number(),
  endpoint: z.number().default(0),
  property: z.union([z.string(), z.number()]),
  propertyKey: z.union([z.string(), z.number()]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const valueArgs = z.looseObject({
  commandClass: z.number(),
  endpoint: z.number().default(0),
  property: z.union([z.string(), z.number()]),
  propertyKey: z.union([z.string(), z.number()]).optional(),
  newValue: z.unknown().optional(),
});

// Security classes as zwave-js numbers them. The two S2 classes above Unauthenticated can only
// be bootstrapped with the device's PIN (the first five digits of its DSK).
const SECURITY_CLASS: Record<number, string> = {
  [-1]: "none",
  0: "S2 Unauthenticated",
  1: "S2 Authenticated",
  2: "S2 Access Control",
  7: "S0 Legacy",
};
const PIN_CLASSES = [1, 2];
export const securityClassName = (value: number | null | undefined): string =>
  value === null || value === undefined ? "none" : (SECURITY_CLASS[value] ?? `class ${value}`);

// zwave-js's SecurityBootstrapFailure, reported with `lowSecurity` when S2 did not complete.
const LOW_SECURITY_REASON: Record<number, string> = {
  0: "the user cancelled",
  1: "the server has no security keys configured",
  2: "the server could not ask for the security classes",
  3: "the device did not answer in time",
  4: "the device and controller disagreed on the parameters",
  5: "the device cancelled",
  6: "the PIN was wrong",
  7: "the device refused the granted security level",
  8: "S0 was downgraded",
  9: "an unknown reason",
};

// zwave-js's InclusionStrategy: Default lets the controller pick the best the device supports;
// Security_S2 is used with the device's QR code, which carries the DSK so no PIN is asked.
const STRATEGY_DEFAULT = 0;
const STRATEGY_S2 = 4;
// zwave-js's QRCodeVersion: 0 is an S2 code (pair with the device in inclusion mode), 1 is
// SmartStart (the device joins by itself once provisioned).
const QR_SMART_START = 1;
const PROTOCOL_LONG_RANGE = 1;

export interface InclusionOutcome {
  nodeId: number;
  securityClass: string;
  /** Present when the device joined with less security than it asked for. */
  lowSecurityReason?: string;
}

interface Inclusion {
  pin?: string;
  settle(error: Error | undefined, outcome?: InclusionOutcome): void;
}

// zwave-js's ProvisioningEntryStatus.
const PROVISIONING_STATUS: Record<number, string> = { 0: "active", 1: "inactive" };

const nodeRemovedEvent = z.looseObject({ node: z.looseObject({ nodeId: z.number() }) });

const grantEvent = z.looseObject({
  requested: z.looseObject({ securityClasses: z.array(z.number()) }),
});
const nodeAddedEvent = z.looseObject({
  node: z.looseObject({ nodeId: z.number(), highestSecurityClass: z.number().nullish() }),
  result: z
    .looseObject({
      lowSecurity: z.boolean().default(false),
      lowSecurityReason: z.number().optional(),
    })
    .optional(),
});
const qrInformation = z.looseObject({
  version: z.number(),
  dsk: z.string(),
  securityClasses: z.array(z.number()).default([]),
  supportedProtocols: z.array(z.number()).optional(),
});
const provisioningEntry = z.looseObject({
  dsk: z.string(),
  securityClasses: z.array(z.number()).default([]),
  nodeId: z.number().optional(),
  status: z.number().optional(),
});

class Network {
  private readonly nodes = new Map<number, Tracked>();
  private inclusion?: Inclusion;
  client?: ZwaveClient;

  constructor(private readonly ctx: Ctx) {}

  private get homeId(): number {
    return this.client?.homeId ?? 0;
  }

  /** Builds or rebuilds a node's device and entities from its full state. */
  track(raw: unknown): void {
    const parsed = zwaveNode.safeParse(raw);
    if (!parsed.success) {
      this.ctx.log.warn("skipping node with unexpected shape", {
        error: parsed.error.issues[0]?.message,
      });
      return;
    }
    const node: ZwaveNode = parsed.data;
    // A node that is still being interviewed has an incomplete value list.
    if (!node.ready) return;
    const { ctx } = this;
    const config = node.deviceConfig;
    const name =
      node.name ||
      [config?.manufacturer, config?.label].filter(Boolean).join(" ") ||
      `Node ${node.nodeId}`;
    const deviceId = ctx.registerDevice({
      uniqueId: `${this.homeId}-${node.nodeId}`,
      name,
      manufacturer: config?.manufacturer,
      model: config?.label,
      firmware: node.firmwareVersion ?? undefined,
    }).id;

    const values = new Map(node.values.map((v) => [valueKey(v), v.value]));
    const entities = entitiesFor(node, node.nodeId).map((spec) => {
      const write = spec.write;
      const entity = ctx.registerEntity(
        {
          uniqueId: `${this.homeId}-${node.nodeId}-${spec.key}`,
          domain: spec.domain,
          name: spec.label ? `${name} ${spec.label}` : name,
          deviceId,
          capabilities: spec.capabilities,
        },
        write &&
          (async (command) => {
            const client = this.client;
            if (!client) throw new Error("The Z-Wave JS server is not connected");
            for (const call of write(command, values)) await client.call(call.command, call.params);
          }),
      );
      return { id: entity.id, spec };
    });
    const configValues = new Map(
      node.values.filter((v) => v.commandClass === CONFIGURATION).map((v) => [valueKey(v), v]),
    );
    this.nodes.set(node.nodeId, {
      nodeId: node.nodeId,
      deviceId,
      values,
      entities,
      config: configValues,
      params: configParams([...configValues.values()]),
    });
    this.publish(node.nodeId);
    if (configValues.size) this.settingsChanged(node.nodeId);
    if (node.status === NODE_DEAD) this.setAvailable(node.nodeId, false);
  }

  /** Reports every entity of a node whose state its current values describe. */
  private publish(nodeId: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    for (const { id, spec } of node.entities) {
      // A button's state is its last press, which only a scene notification reports.
      const state = spec.read(node.values);
      if (state && !(spec.scene && this.reported.has(id))) {
        this.ctx.reportState(id, state);
        this.reported.add(id);
      }
    }
  }
  private readonly reported = new Set<EntityId>();

  /** The tracked node behind a Casita device id or a node id. */
  node(by: { nodeId?: number; deviceId?: string }): Tracked {
    const node =
      by.nodeId !== undefined
        ? this.nodes.get(by.nodeId)
        : [...this.nodes.values()].find((n) => n.deviceId === by.deviceId);
    if (!node) throw new Error(`No ready Z-Wave node ${by.nodeId ?? by.deviceId}`);
    return node;
  }

  /** The node's LED effects, as its driver's configuration metadata describes them. */
  effects(node: Tracked): EffectTarget[] {
    return effectTargets(node.params);
  }

  /** The parts of a parameter as a write the device confirmed left them. */
  noteWritten(node: Tracked, target: EffectTarget, value: number): void {
    for (const part of target.parts) {
      const mask = part.bitMask ?? 0;
      let low = 1;
      while (mask > 0 && (mask / low) % 2 === 0) low *= 2;
      node.values.set(part.valueKey, Math.floor(value / low) % (mask / low + 1));
    }
    this.settingsChanged(node.nodeId);
  }

  /** A Configuration value the node gained or lost after its interview. */
  private noteConfigValue(node: Tracked, id: z.infer<typeof valueArgs>, removed = false): void {
    const key = valueKey(id);
    if (removed) {
      if (!node.config.delete(key)) return;
      node.values.delete(key);
    } else {
      if (node.config.has(key)) return;
      const { newValue: _value, ...valueId } = id;
      node.config.set(key, valueId);
    }
    node.params = configParams([...node.config.values()]);
  }

  // One report of a partial parameter updates each of its parts; one event covers them.
  private readonly settingsTimers = new Map<number, () => void>();
  settingsChanged(nodeId: number): void {
    if (this.settingsTimers.has(nodeId)) return;
    this.settingsTimers.set(
      nodeId,
      this.ctx.scheduler.after(100, () => {
        this.settingsTimers.delete(nodeId);
        const node = this.nodes.get(nodeId);
        if (node) this.ctx.settingsChanged(node.deviceId);
      }),
    );
  }

  setAvailable(nodeId: number, available: boolean): void {
    for (const { id } of this.nodes.get(nodeId)?.entities ?? [])
      this.ctx.setAvailable(id, available);
  }

  setAllUnavailable(): void {
    this.reported.clear();
    for (const nodeId of this.nodes.keys()) this.setAvailable(nodeId, false);
  }

  /**
   * Waits for the inclusion the caller has just begun to add a node, answering the server's
   * S2 prompts on the way. With no PIN, the classes that need one are not granted, so the
   * device joins at the best level it can reach without it.
   */
  awaitInclusion(
    pin: string | undefined,
    timeoutMs: number,
  ): { outcome: Promise<InclusionOutcome>; fail(error: Error): void } {
    if (this.inclusion) throw new Error("An inclusion is already in progress");
    const { promise, resolve, reject } = Promise.withResolvers<InclusionOutcome>();
    const timer = setTimeout(() => {
      this.answer("controller.stop_inclusion");
      this.settleInclusion(
        new Error(`No device joined within ${Math.round(timeoutMs / 1000)} seconds`),
      );
    }, timeoutMs);
    const inclusion: Inclusion = {
      pin,
      settle: (error, outcome) => {
        clearTimeout(timer);
        if (outcome) resolve(outcome);
        else reject(error ?? new Error("Inclusion ended without a node"));
      },
    };
    this.inclusion = inclusion;
    return {
      outcome: promise,
      // Ends this wait only: a late failure must not end a newer inclusion.
      fail: (error) => {
        if (this.inclusion === inclusion) this.settleInclusion(error);
      },
    };
  }

  settleInclusion(error: Error | undefined, outcome?: InclusionOutcome): void {
    const inclusion = this.inclusion;
    this.inclusion = undefined;
    inclusion?.settle(error, outcome);
  }

  /** Sends a reply the server is waiting on; a failure is logged, since nothing awaits it. */
  private answer(command: string, params: Record<string, unknown> = {}): void {
    this.client?.call(command, params).catch((err: unknown) => {
      this.ctx.log.warn(`${command} was refused`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  handle(event: ServerEvent): void {
    if (event.source === "controller") {
      this.handleController(event);
      return;
    }
    const nodeId = event.nodeId;
    if (event.source !== "node" || nodeId === undefined) return;

    switch (event.event) {
      case "ready":
        this.track(event.nodeState);
        break;
      case "dead":
        this.setAvailable(nodeId, false);
        break;
      case "alive":
        this.setAvailable(nodeId, true);
        break;
      case "value added":
      case "value updated": {
        const args = valueArgs.safeParse(event.args);
        const node = this.nodes.get(nodeId);
        if (!args.success || !node) return;
        node.values.set(valueKey(args.data), args.data.newValue);
        if (args.data.commandClass === CONFIGURATION) {
          this.noteConfigValue(node, args.data);
          this.settingsChanged(nodeId);
        } else this.publish(nodeId);
        break;
      }
      case "value removed": {
        const args = valueArgs.safeParse(event.args);
        const node = this.nodes.get(nodeId);
        if (!args.success || !node || args.data.commandClass !== CONFIGURATION) return;
        this.noteConfigValue(node, args.data, true);
        this.settingsChanged(nodeId);
        break;
      }
      case "metadata updated": {
        // A parameter the device described about itself during the interview, or a change in
        // what the driver knows of one.
        const args = metadataArgs.safeParse(event.args);
        const node = this.nodes.get(nodeId);
        if (!args.success || !node || args.data.commandClass !== CONFIGURATION) return;
        const { metadata, ...id } = args.data;
        // No metadata leaves what the driver said before.
        if (!metadata) return;
        const key = valueKey(id);
        node.config.set(key, { ...node.config.get(key), ...id, metadata });
        node.params = configParams([...node.config.values()]);
        this.settingsChanged(nodeId);
        break;
      }
      case "value notification": {
        // Central Scene: a key press is an event, not a value that stays.
        const args = valueArgs.safeParse(event.args);
        if (!args.success) return;
        const key = valueKey(args.data);
        const button = this.nodes.get(nodeId)?.entities.find((e) => e.spec.scene === key);
        if (button) this.ctx.reportState(button.id, { domain: "button", pressedAt: Date.now() });
        break;
      }
      default:
        break;
    }
  }

  private handleController(event: ServerEvent): void {
    switch (event.event) {
      case "node removed": {
        const removed = nodeRemovedEvent.safeParse(event);
        const tracked = removed.success ? this.nodes.get(removed.data.node.nodeId) : undefined;
        if (!removed.success || !tracked) return;
        this.ctx.removeDevice(tracked.deviceId);
        this.nodes.delete(removed.data.node.nodeId);
        break;
      }
      // The S2 prompts only reach the client that began the inclusion, so they are ours.
      case "grant security classes": {
        const grant = grantEvent.safeParse(event);
        if (!grant.success) return;
        const requested = grant.data.requested.securityClasses;
        const securityClasses = this.inclusion?.pin
          ? requested
          : requested.filter((c) => !PIN_CLASSES.includes(c));
        // Client-side authentication is for devices with no DSK label; never asked for here.
        this.answer("controller.grant_security_classes", {
          inclusionGrant: { securityClasses, clientSideAuth: false },
        });
        break;
      }
      case "validate dsk and enter pin":
        // An empty PIN makes the driver give up on S2 and include the node at low security.
        this.answer("controller.validate_dsk_and_enter_pin", { pin: this.inclusion?.pin ?? "" });
        break;
      case "node added": {
        // Secure bootstrapping is finished by now; the interview follows, and the node's
        // entities appear when it reports ready.
        const added = nodeAddedEvent.safeParse(event);
        if (!added.success) return;
        const { node, result } = added.data;
        const reason = result?.lowSecurity
          ? (LOW_SECURITY_REASON[result.lowSecurityReason ?? 9] ?? "an unknown reason")
          : undefined;
        this.settleInclusion(undefined, {
          nodeId: node.nodeId,
          securityClass: securityClassName(node.highestSecurityClass),
          ...(reason ? { lowSecurityReason: reason } : {}),
        });
        break;
      }
      case "inclusion failed":
        this.settleInclusion(
          new Error("Inclusion failed; put the device back in pairing mode and try again"),
        );
        break;
      default:
        // "inclusion aborted" only closes the S2 prompts; "node added" still follows.
        break;
    }
  }
}

/** Timing is injectable for tests. */
export const createZwaveIntegration = (options: ZwaveOptions = {}) =>
  defineIntegration({
    id: "zwave-js",
    name: "Z-Wave JS",
    version: "0.2.0",
    configSchema,
    async setup(ctx) {
      const network = new Network(ctx);
      const url = ctx.config.serverUrl;
      let attempt = 0;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const open = async () => {
        const client = await connect(
          url,
          {
            onEvent: (event) => network.handle(event),
            onClose: (error) => {
              ctx.log.warn("Z-Wave JS server connection lost", { error: error.message });
              network.client = undefined;
              network.setAllUnavailable();
              network.settleInclusion(new Error("The Z-Wave JS server connection was lost"));
              reconnect();
            },
          },
          options.connectTimeoutMs,
        );
        network.client = client;
        const dump = z
          .looseObject({ state: z.looseObject({ nodes: z.array(z.unknown()) }) })
          .parse(await client.call("start_listening"));
        for (const node of dump.state.nodes) network.track(node);
      };
      const reconnect = () => {
        if (ctx.signal.aborted) return;
        const delay = Math.min(
          (options.backoffBaseMs ?? 1000) * 2 ** attempt++,
          options.backoffMaxMs ?? 60_000,
        );
        retry = setTimeout(() => {
          open().then(
            () => {
              attempt = 0;
              ctx.log.info("Z-Wave JS server connection restored");
            },
            (err: unknown) => {
              ctx.log.warn("Z-Wave JS server unreachable", {
                error: err instanceof Error ? err.message : String(err),
              });
              network.client?.close();
              network.client = undefined;
              reconnect();
            },
          );
        }, delay);
      };
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(retry);
        network.settleInclusion(new Error("The integration was stopped"));
        network.client?.close();
      });

      // If the first connection fails, setup rejects and the host retries it with backoff.
      try {
        await open();
      } catch (err) {
        network.client?.close();
        throw err;
      }

      const connected = (): ZwaveClient => {
        if (!network.client) throw new Error("The Z-Wave JS server is not connected");
        return network.client;
      };
      const call = (command: string, params: Record<string, unknown> = {}) =>
        connected().call(command, params);
      const controller = (name: string, command: string, params: Record<string, unknown> = {}) =>
        ctx.registerAction(
          name,
          z.strictObject({}),
          async () => (await call(command, params)) ?? {},
        );

      const nodeId = z.number().int().positive();

      ctx.provideDeviceSettings({
        list: (deviceId) => {
          const node = network.node({ deviceId });
          return nodeSettings(node.params, node.values);
        },
        set: async (deviceId, key, value) => {
          const node = network.node({ deviceId });
          const param = node.params.find((p) => settingKey(p) === key);
          if (!param) throw new Error(`${deviceId} has no parameter ${key}`);
          const { command, params } = setSettingCall(node.nodeId, param, value);
          const failed = writeFailure(await call(command, params));
          if (failed) throw new Error(`${param.metadata.label ?? key} wasn't changed: ${failed}`);
        },
      });

      // A device, by node id or Casita device id: the CLI knows one, an automation the other.
      const nodeRef = {
        nodeId: nodeId.optional(),
        deviceId: z.string().min(1).optional().describe("Casita's device id, instead of nodeId."),
      };
      const oneNode = (params: { nodeId?: number; deviceId?: string }) =>
        params.nodeId === undefined ? params.deviceId !== undefined : params.deviceId === undefined;
      const fieldValue = z.union([z.number().int(), z.string().min(1)]);

      ctx.registerAction(
        "start_inclusion",
        z
          .strictObject({
            // The CLI reads `--pin 12345` as a number; one with a leading zero stays a string.
            pin: z
              .preprocess(
                (value) => (typeof value === "number" ? String(value) : value),
                z.string().regex(/^\d{5}$/, "The PIN is five digits"),
              )
              .optional()
              .describe("The five-digit PIN on the device's label, for S2 Authenticated pairing."),
            qr: z
              .string()
              .min(1)
              .optional()
              .meta({ scan: "qr" })
              .describe("The text of the device's QR code instead of a PIN. Its DSK is used."),
            timeoutSec: z
              .number()
              .positive()
              .max(600)
              .default(120)
              .describe("How long to wait for a device to join."),
          })
          .refine((params) => !(params.pin && params.qr), "Give a pin or a qr, not both"),
        async ({ pin, qr, timeoutSec }) => {
          const inclusionOptions = qr
            ? { strategy: STRATEGY_S2, provisioning: qr }
            : { strategy: STRATEGY_DEFAULT };
          const wait = network.awaitInclusion(pin, timeoutSec * 1000);
          // The wait can end (disconnect, abort) while begin_inclusion is still being awaited,
          // before anything is listening for its rejection.
          wait.outcome.catch(() => {});
          try {
            const begun = z
              .looseObject({ success: z.boolean() })
              .parse(await call("controller.begin_inclusion", { options: inclusionOptions }));
            if (!begun.success)
              throw new Error("The controller is busy with another operation; try again shortly");
          } catch (err) {
            wait.fail(err instanceof Error ? err : new Error(String(err)));
          }
          return wait.outcome;
        },
      );
      ctx.registerAction("stop_inclusion", z.strictObject({}), async () => {
        try {
          return (await call("controller.stop_inclusion")) ?? {};
        } finally {
          network.settleInclusion(new Error("Inclusion was stopped"));
        }
      });
      controller("start_exclusion", "controller.begin_exclusion");
      controller("stop_exclusion", "controller.stop_exclusion");
      controller("heal_network", "controller.begin_rebuilding_routes");
      // A rebuild holds every other controller operation, including a joining node's interview.
      controller("stop_heal_network", "controller.stop_rebuilding_routes");

      ctx.registerAction(
        "provision_qr",
        z.strictObject({
          qr: z
            .string()
            .min(1)
            .meta({ scan: "qr" })
            .describe("The text of the device's SmartStart QR code."),
        }),
        async ({ qr }) => {
          const parsed = z
            .looseObject({ qrProvisioningInformation: qrInformation })
            .parse(await call("utils.parse_qr_code_string", { qr }));
          const info = parsed.qrProvisioningInformation;
          if (info.version !== QR_SMART_START) {
            throw new Error(
              "This is an S2 QR code, not SmartStart: put the device in pairing mode and run start_inclusion with it as qr",
            );
          }
          await call("controller.provision_smart_start_node", { entry: info });
          return {
            dsk: info.dsk,
            securityClasses: info.securityClasses.map(securityClassName),
            longRange: info.supportedProtocols?.includes(PROTOCOL_LONG_RANGE) ?? false,
          };
        },
      );
      ctx.registerAction("list_provisioned", z.strictObject({}), async () => {
        const parsed = z
          .looseObject({ entries: z.array(provisioningEntry) })
          .parse(await call("controller.get_provisioning_entries"));
        return {
          entries: parsed.entries.map((entry) => ({
            ...entry,
            securityClasses: entry.securityClasses.map(securityClassName),
            ...(entry.status === undefined
              ? {}
              : { status: PROVISIONING_STATUS[entry.status] ?? `status ${entry.status}` }),
          })),
        };
      });
      ctx.registerAction(
        "unprovision",
        z
          .strictObject({
            dsk: z.string().optional().describe("The DSK of the provisioning entry to remove."),
            nodeId: nodeId.optional().describe("Or the node it became."),
          })
          .refine((params) => !(params.dsk && params.nodeId), "Give a dsk or a nodeId, not both"),
        async ({ dsk, nodeId }) => {
          const dskOrNodeId = dsk ?? nodeId;
          if (dskOrNodeId === undefined) throw new Error("Give a dsk or a nodeId");
          return (await call("controller.unprovision_smart_start_node", { dskOrNodeId })) ?? {};
        },
      );
      ctx.registerAction(
        "remove_failed_node",
        z.strictObject({ nodeId: nodeId.describe("A node the controller reports as dead.") }),
        async ({ nodeId }) => (await call("controller.remove_failed_node", { nodeId })) ?? {},
      );

      ctx.registerAction(
        "get_config_parameter",
        z.strictObject({
          nodeId,
          parameter: z.number().int().min(0).max(65535),
          bitMask: z.number().int().positive().optional().describe("For a partial parameter."),
        }),
        async (params) => (await call("node.get_raw_config_parameter_value", params)) ?? {},
      );
      ctx.registerAction(
        "set_config_parameter",
        z
          .strictObject({
            nodeId,
            parameter: z.number().int().min(0).max(65535),
            value: z.number().int(),
            valueSize: z
              .number()
              .int()
              .optional()
              .describe("1, 2 or 4 bytes; needed when the device's config file is unknown."),
            signed: z.boolean().optional().describe("With valueSize: the value is signed."),
            bitMask: z.number().int().positive().optional().describe("For a partial parameter."),
          })
          .refine(
            (params) => params.valueSize === undefined || [1, 2, 4].includes(params.valueSize),
            "valueSize is 1, 2 or 4",
          )
          .refine(
            (params) => params.signed === undefined || params.valueSize !== undefined,
            "signed needs a valueSize",
          ),
        async ({ valueSize, signed, ...params }) => {
          // zwave-js's ConfigValueFormat: 0 signed, 1 unsigned. It needs the format with a size.
          const sized = valueSize === undefined ? {} : { valueSize, valueFormat: signed ? 0 : 1 };
          return (await call("node.set_raw_config_parameter_value", { ...params, ...sized })) ?? {};
        },
      );

      ctx.registerAction(
        "led_effects",
        z.strictObject(nodeRef).refine(oneNode, "Give a nodeId or a deviceId"),
        async (params) =>
          network.effects(network.node(params)).map((target) => ({
            target: target.id,
            name: target.name,
            fields: Object.fromEntries(
              Object.entries(target.fields).map(([field, spec]) => [
                field,
                { min: spec.min, max: spec.max, options: spec.options },
              ]),
            ),
          })),
      );
      ctx.registerAction(
        "led_notify",
        z
          .strictObject({
            ...nodeRef,
            target: z
              .union([z.string(), z.number()])
              .transform(String)
              .optional()
              .describe(
                "Which LEDs: a parameter or a name from led_effects; all of them if left out.",
              ),
            effect: fieldValue.describe('A number, or a name the driver gives it: "pulse", "off".'),
            color: fieldValue.optional().describe("Usually a hue, 0–255."),
            level: fieldValue.optional().describe("Brightness; its maximum if left out."),
            duration: fieldValue
              .optional()
              .describe(
                'In the device\'s units, or a name such as "indefinitely". Left out and 0 now, it is the longest the device allows, which on Inovelli switches is until cleared.',
              ),
          })
          .refine(oneNode, "Give a nodeId or a deviceId"),
        async ({ nodeId: _n, deviceId: _d, target: wanted, ...fields }) => {
          const node = network.node({ nodeId: _n, deviceId: _d });
          const target = pickTarget(network.effects(node), wanted);
          const request: EffectRequest = {};
          for (const field of FIELDS)
            if (fields[field] !== undefined) request[field] = fields[field];
          const { value, fields: sent } = composeEffect(target, request, node.values);
          const [write, read] = effectCalls(node.nodeId, target, value);
          if (write) {
            const failed = writeFailure(await call(write.command, write.params));
            if (failed) throw new Error(`The LED effect wasn't shown: ${failed}`);
            // The device took it; its parts are what was written, whether or not the driver
            // splits the read below into them.
            network.noteWritten(node, target, value);
          }
          // The read brings the driver's parts in line with the write; a failed one only
          // leaves the settings page behind until the next report.
          if (read)
            call(read.command, read.params).catch((err: unknown) =>
              ctx.log.warn("couldn't read back an LED effect", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          return {
            target: target.id,
            name: target.name,
            parameter: target.parameter,
            value,
            fields: sent,
          };
        },
      );
    },
  });

export default createZwaveIntegration();
