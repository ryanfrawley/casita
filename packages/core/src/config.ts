// core/config.ts
// config.toml is the source of truth. Reads are typed; writes validate, rewrite the file
// atomically, and emit config_changed.

import { rename } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { CoreError } from "./errors.ts";
import { days, retentionPolicySchema } from "./retention.ts";
import { resolveTimezone } from "./scheduler.ts";
import { DOMAINS, type EventBus, type Integration } from "./types.ts";

export { retentionPolicySchema };

const historySchema = z.strictObject({
  defaultDays: days.default(30),
  minIntervalMs: z.number().int().nonnegative().default(0),
  /** Record a change that touches only attributes at most this often per entity; 0 records all. */
  attributesMinIntervalMs: z.number().int().nonnegative().default(60_000),
  domains: z.partialRecord(z.enum(DOMAINS), retentionPolicySchema).default({}),
  entities: z.record(z.string(), retentionPolicySchema).default({}),
});
export type HistoryConfig = z.infer<typeof historySchema>;

export const serverSchema = z.strictObject({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(8123),
  /** Bootstrap admin credential; honored only while no user exists. */
  apiToken: z.string().min(16).optional(),
  /** IANA name; defaults to the system zone. */
  timezone: z
    .string()
    .optional()
    .refine((name) => {
      try {
        resolveTimezone(name);
        return true;
      } catch {
        return false;
      }
    }, "Unknown time zone"),
  /** The unit system readings are shown in. Stored values stay as devices report them. */
  units: z.enum(["metric", "imperial"]).default("metric"),
  /** Serve the web app from this server. */
  web: z.boolean().default(true),
  dbPath: z.string().default("data/home.db"),
  history: historySchema.prefault({}),
});
export type ServerConfig = z.infer<typeof serverSchema>;

const oidcSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  issuer: z.url(),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUrl: z.url(),
  defaultRole: z.enum(["admin", "member", "guest"]).default("guest"),
});

const instanceName = z.string().regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits, and _");

const fileSchema = z.strictObject({
  server: serverSchema.prefault({}),
  auth: z.strictObject({ oidc: z.array(oidcSchema).default([]) }).prefault({}),
  /** One block per integration instance: `type`, optional `name`, then the integration's own fields. */
  integration: z
    .array(z.looseObject({ type: z.string(), name: instanceName.default("main") }))
    .default([]),
});
export type AuthConfig = z.infer<typeof fileSchema>["auth"];

export interface InstanceConfig {
  /** "<type>.<name>" */
  id: string;
  type: string;
  name: string;
  /** Validated against the integration's schema; absent when `error` is set. */
  config?: unknown;
  error?: string;
}

type Doc = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: integrations are heterogeneous in their config type
export type IntegrationCatalog = ReadonlyMap<string, Integration<any>>;

/** Builds the catalog the config store and host look integrations up in, keyed by id. */
// biome-ignore lint/suspicious/noExplicitAny: integrations are heterogeneous in their config type
export const createCatalog = (...integrations: Integration<any>[]): IntegrationCatalog =>
  new Map(integrations.map((i) => [i.id, i]));

const describe = (error: z.ZodError, prefix = ""): string =>
  error.issues
    .map((i) => `${[prefix, ...i.path].filter((p) => p !== "").join(".")}: ${i.message}`)
    .join("; ");

export class ConfigStore {
  private doc: Doc;
  private parsed: z.infer<typeof fileSchema>;
  private resolved: InstanceConfig[];

  private constructor(
    private readonly path: string,
    private readonly integrations: IntegrationCatalog,
    private readonly bus: EventBus,
    doc: Doc,
  ) {
    const checked = this.check(doc, false);
    this.doc = doc;
    this.parsed = checked.parsed;
    this.resolved = checked.instances;
  }

  /** Reads and validates the file; a missing file means defaults. Throws on an invalid server section. */
  static async load(
    path: string,
    integrations: IntegrationCatalog,
    bus: EventBus,
  ): Promise<ConfigStore> {
    const file = Bun.file(path);
    let doc: Doc = {};
    if (await file.exists()) {
      try {
        doc = parse(await file.text());
      } catch (err) {
        throw new CoreError("invalid", `${path}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return new ConfigStore(path, integrations, bus, doc);
  }

  get server(): ServerConfig {
    return this.parsed.server;
  }

  get auth(): AuthConfig {
    return this.parsed.auth;
  }

  /** Every configured integration instance, valid or not. */
  instances(): InstanceConfig[] {
    return this.resolved;
  }

  /**
   * Reads the raw document at a dotted path ("server.port"); no path returns everything.
   * Integration blocks are addressed as "integration.<type>.<name>[.<field>]".
   */
  get(path = ""): unknown {
    const [target, key] = this.locate(this.doc, split(path), false);
    return key === undefined ? target : (target as Doc | undefined)?.[key];
  }

  /**
   * Validates the whole document with the change applied, then rewrites the file atomically.
   * A value of null removes the key (or the whole integration block).
   */
  async set(path: string, value: unknown): Promise<void> {
    const segments = split(path);
    if (segments.length === 0) throw new CoreError("invalid", "A config path is required");
    const next = structuredClone(this.doc);
    if (segments[0] === "integration" && segments.length === 3) {
      this.setBlock(next, segments[1] ?? "", segments[2] ?? "", value);
    } else {
      const [target, key] = this.locate(next, segments, true);
      if (key === undefined || !target) throw new CoreError("invalid", `Cannot set ${path}`);
      if (value === null) delete (target as Doc)[key];
      else (target as Doc)[key] = value;
    }

    const checked = this.check(next, true);
    const temp = `${this.path}.${process.pid}.tmp`;
    await Bun.write(temp, stringify(next));
    await rename(temp, this.path);
    this.doc = next;
    this.parsed = checked.parsed;
    this.resolved = checked.instances;
    this.bus.emit({ type: "config_changed", path });
  }

  private check(doc: Doc, strictInstances: boolean) {
    const result = fileSchema.safeParse(doc);
    if (!result.success)
      throw new CoreError("invalid", `Invalid config: ${describe(result.error)}`);

    const seen = new Set<string>();
    const instances = result.data.integration.map((block): InstanceConfig => {
      const { type, name, ...fields } = block;
      const id = `${type}.${name}`;
      const fail = (error: string): InstanceConfig => {
        if (strictInstances) throw new CoreError("invalid", `Invalid config: ${error}`);
        return { id, type, name, error };
      };
      if (seen.has(id)) return fail(`integration.${id}: duplicate instance`);
      seen.add(id);
      const integration = this.integrations.get(type);
      if (!integration) return fail(`integration.${id}: unknown integration "${type}"`);
      const config = integration.configSchema.safeParse(fields);
      if (!config.success) return fail(describe(config.error, `integration.${id}`));
      return { id, type, name, config: config.data };
    });
    return { parsed: result.data, instances };
  }

  /** Walks to the parent of the last segment, returning [parent, lastKey]. */
  private locate(doc: Doc, segments: string[], create: boolean): [unknown, string | undefined] {
    let node: unknown = doc;
    let rest = segments;
    if (rest[0] === "integration" && rest.length >= 3) {
      node = blocks(doc).find((b) => b.type === rest[1] && (b.name ?? "main") === rest[2]);
      rest = rest.slice(3);
      if (!node && create) {
        throw new CoreError("not_found", `No integration instance ${segments[1]}.${segments[2]}`);
      }
    }
    const last = rest.at(-1);
    for (const segment of rest.slice(0, -1)) {
      if (node === null || typeof node !== "object") return [undefined, last];
      const parent = node as Doc;
      if (parent[segment] === undefined && create) parent[segment] = {};
      node = parent[segment];
    }
    return [node, last];
  }

  private setBlock(doc: Doc, type: string, name: string, value: unknown): void {
    const list = blocks(doc).filter((b) => !(b.type === type && (b.name ?? "main") === name));
    if (value !== null) {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new CoreError("invalid", "An integration block must be an object");
      }
      list.push({ ...value, type, name });
    }
    doc.integration = list;
  }
}

const split = (path: string): string[] => (path ? path.split(".") : []);

const blocks = (doc: Doc): Doc[] =>
  Array.isArray(doc.integration) ? (doc.integration as Doc[]) : [];
