// The wire protocol. Shared by the server, the CLI, and the future UI.

// Only these two core modules: this file is bundled for the browser.
import { retentionPolicySchema } from "@casita/core/retention";
import { type Command, DOMAINS } from "@casita/core/types";
import { z } from "zod";
import { LEVELS, ROLES } from "./auth/permissions.ts";

export const PROTOCOL_VERSION = 1;

/** Close codes used on the WebSocket. */
export const CLOSE = { unauthorized: 4401 } as const;

// ───────────────────────── Commands ─────────────────────────

const rgb = z.tuple([z.number(), z.number(), z.number()]);

export const commandSchema = z.union([
  z.strictObject({
    domain: z.literal("light"),
    action: z.literal("turn_on"),
    brightness: z.number().optional(),
    colorTempK: z.number().optional(),
    rgb: rgb.optional(),
    transitionMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    domain: z.literal("light"),
    action: z.literal("turn_off"),
    transitionMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    domain: z.literal("switch"),
    action: z.enum(["turn_on", "turn_off", "toggle"]),
  }),
  z.strictObject({
    domain: z.literal("climate"),
    action: z.literal("set_mode"),
    mode: z.enum(["off", "heat", "cool", "auto"]),
  }),
  z.strictObject({
    domain: z.literal("climate"),
    action: z.literal("set_target"),
    temp: z.number(),
  }),
  z.strictObject({ domain: z.literal("cover"), action: z.enum(["open", "close", "stop"]) }),
  z.strictObject({
    domain: z.literal("cover"),
    action: z.literal("set_position"),
    position: z.number(),
  }),
  z.strictObject({ domain: z.literal("lock"), action: z.enum(["lock", "unlock"]) }),
  z.strictObject({ domain: z.literal("button"), action: z.literal("press") }),
]) satisfies z.ZodType<Command>;

// ───────────────────────── Requests ─────────────────────────

// `id` and `type` belong to the envelope, so no request may use them as parameter names.
const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ id: z.number().int(), type: z.literal(type), ...shape });

/** An icon name the UI knows, as `casita entities` and the web show it; null is the default. */
const icon = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, "An icon is lowercase letters, digits and dashes")
  .nullable()
  .optional();

const role = z.enum(ROLES);
const level = z.enum(LEVELS);
const subjectKind = z.enum(["user", "role"]);
const scopeKind = z.enum(["entity", "area", "domain"]);

export const requestSchema = z.discriminatedUnion("type", [
  request("ping", {}),
  request("get_status", {}),
  request("get_me", {}),

  request("subscribe", {
    events: z.array(z.string()).optional(),
    entityIds: z.array(z.string()).optional(),
  }),
  request("unsubscribe", { subscriptionId: z.number().int() }),

  request("get_states", { entityIds: z.array(z.string()).optional() }),
  request("get_entities", {
    domain: z.enum(DOMAINS).optional(),
    areaId: z.string().optional(),
    deviceId: z.string().optional(),
  }),
  request("get_devices", { areaId: z.string().optional() }),
  request("get_areas", {}),

  request("send_command", {
    entityId: z.string(),
    command: commandSchema,
    confirm: z.boolean().optional(),
  }),
  request("send_area_command", {
    areaId: z.string(),
    command: commandSchema,
    confirm: z.boolean().optional(),
  }),

  request("update_entity", {
    entityId: z.string(),
    name: z.string().min(1).optional(),
    newId: z.string().optional(),
    areaId: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    disabled: z.boolean().optional(),
    retention: retentionPolicySchema.nullable().optional(),
    icon,
    /** A sensor's or binary sensor's class (`window`, `temperature`); null keeps the integration's. */
    deviceClass: z.string().nullable().optional(),
  }),
  request("update_device", {
    deviceId: z.string(),
    name: z.string().min(1).optional(),
    newId: z.string().optional(),
    areaId: z.string().nullable().optional(),
    icon,
  }),
  request("delete_entity", { entityId: z.string() }),
  request("delete_device", { deviceId: z.string() }),
  /** What its integration says can be adjusted on the device, with current values; admin only. */
  request("get_device_settings", { deviceId: z.string() }),
  /** Checked against the setting, then sent; the new value arrives with `settings_changed`. */
  request("set_device_setting", {
    deviceId: z.string(),
    key: z.string().min(1),
    value: z.union([z.number(), z.boolean(), z.string()]),
  }),
  request("create_area", { name: z.string().min(1) }),
  request("update_area", {
    areaId: z.string(),
    name: z.string().min(1).optional(),
    icon,
  }),
  request("delete_area", { areaId: z.string() }),

  // ───────── Casa pages and themes ─────────
  request("get_page", { pageId: z.string() }),
  request("list_pages", {}),
  /** The source and its saved versions; admin only, since the source names everything. */
  request("get_page_source", { pageId: z.string() }),
  /** Diagnostics for a source without storing it; the editor calls this before a save. */
  request("check_page", { pageId: z.string(), source: z.string().max(1_000_000) }),
  request("save_page", { pageId: z.string(), source: z.string().max(1_000_000) }),
  request("revert_page", { pageId: z.string(), version: z.number().int().positive() }),
  request("list_themes", {}),
  request("save_theme", { themeId: z.string(), source: z.string().max(100_000) }),
  /** The house's shared components file: one Casa file every page may use; admin only. */
  request("get_components_source", {}),
  request("check_components", { source: z.string().max(1_000_000) }),
  request("save_components", { source: z.string().max(1_000_000) }),

  request("get_history", {
    entityId: z.string(),
    from: z.number(),
    to: z.number(),
    limit: z.number().int().positive().max(10_000).optional(),
    resolution: z.enum(["raw", "minute", "hour", "day"]).optional(),
    /** Raw only: also return the last record before `from`, so the range starts with a known state. */
    includePrevious: z.boolean().optional(),
  }),
  request("backup", {}),

  // ───────── Casa automations ─────────
  /** Every automation with its status; a page with handlers is listed too, read-only. */
  request("get_automations", {}),
  /** The source and its saved versions; admin only. */
  request("get_automation_source", { automationId: z.string() }),
  request("check_automation", { source: z.string().max(1_000_000) }),
  /** A new id creates the automation; an existing one saves a version. */
  request("save_automation", { automationId: z.string(), source: z.string().max(1_000_000) }),
  request("revert_automation", {
    automationId: z.string(),
    version: z.number().int().positive(),
  }),
  request("delete_automation", { automationId: z.string() }),
  request("set_automation_enabled", { automationId: z.string(), enabled: z.boolean() }),
  /** The last firings the server remembers, newest first; admin only. */
  request("get_automation_runs", { automationId: z.string() }),
  /**
   * Runs one handler now, as if its trigger had fired, against the house as it is or with
   * some values pretended (`"sensor.x": 21`, `"weather.home#conditionNext12h": "rain"`).
   * The saved version runs, enabled or not; its commands and actions are real. Admin only.
   */
  request("test_automation", {
    automationId: z.string(),
    /** The handler's line; needed only when there are several. */
    line: z.number().int().positive().optional(),
    pretend: z
      .record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]))
      .optional(),
  }),

  // ───────── Casa derived sensors ─────────
  /** Every derived sensor with the entity it is reported as and its status. */
  request("get_sensors", {}),
  /** The source and its saved versions; admin only. */
  request("get_sensor_source", { sensorId: z.string() }),
  request("check_sensor", { source: z.string().max(1_000_000) }),
  /** A new id creates the sensor (and its entity); an existing one saves a version. */
  request("save_sensor", { sensorId: z.string(), source: z.string().max(1_000_000) }),
  request("revert_sensor", { sensorId: z.string(), version: z.number().int().positive() }),
  /** Removes the sensor and its entity, with the entity's history. */
  request("delete_sensor", { sensorId: z.string() }),
  request("set_sensor_enabled", { sensorId: z.string(), enabled: z.boolean() }),

  request("get_integrations", {}),
  request("integration_action", {
    integrationId: z.string(),
    action: z.string(),
    params: z.unknown().optional(),
  }),
  request("reload_integration", { integrationId: z.string() }),
  request("get_config", { path: z.string().optional() }),
  request("set_config", { path: z.string().min(1), value: z.unknown() }),

  request("list_users", {}),
  request("create_user", {
    username: z.string(),
    displayName: z.string().optional(),
    password: z.string(),
    role,
  }),
  request("update_user", {
    userId: z.string(),
    role: role.optional(),
    disabled: z.boolean().optional(),
    displayName: z.string().optional(),
    password: z.string().optional(),
  }),
  request("delete_user", { userId: z.string() }),
  /** The caller's own account; empty clears the display name. */
  request("update_me", { displayName: z.string().trim().max(80) }),

  request("list_grants", { subjectKind: subjectKind.optional(), subjectId: z.string().optional() }),
  request("set_grant", {
    subjectKind,
    subjectId: z.string(),
    scopeKind,
    scopeId: z.string(),
    level,
  }),
  request("delete_grant", { grantId: z.string() }),

  request("list_tokens", { userId: z.string().optional() }),
  request("create_token", { name: z.string().min(1), userId: z.string().optional() }),
  request("revoke_token", { tokenId: z.string() }),
  request("list_sessions", { userId: z.string().optional() }),
  request("revoke_session", { sessionId: z.string() }),

  request("get_audit", {
    since: z.number().optional(),
    limit: z.number().int().positive().optional(),
  }),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestType = Request["type"];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;
export type RequestParams<T extends RequestType> = Omit<RequestOf<T>, "id" | "type">;

/** Members and guests get `forbidden` on these, with no detail about the target. */
export const ADMIN_ONLY: ReadonlySet<RequestType> = new Set([
  "list_users",
  "create_user",
  "update_user",
  "delete_user",
  "list_grants",
  "set_grant",
  "delete_grant",
  "get_config",
  "set_config",
  "reload_integration",
  "integration_action",
  "update_entity",
  "update_device",
  "delete_entity",
  "delete_device",
  "get_device_settings",
  "set_device_setting",
  "create_area",
  "update_area",
  "delete_area",
  "get_page_source",
  "check_page",
  "save_page",
  "revert_page",
  "save_theme",
  "get_components_source",
  "check_components",
  "save_components",
  "get_automation_source",
  "check_automation",
  "save_automation",
  "revert_automation",
  "delete_automation",
  "set_automation_enabled",
  "get_automation_runs",
  "test_automation",
  "get_sensor_source",
  "check_sensor",
  "save_sensor",
  "revert_sensor",
  "delete_sensor",
  "set_sensor_enabled",
  "get_audit",
  "backup",
]);

/** The first message on a socket. A browser leaves `token` out: its session cookie came with the upgrade. */
export const authRequestSchema = z.strictObject({
  type: z.literal("auth"),
  token: z.string().optional(),
});

export const loginRequestSchema = z.strictObject({
  username: z.string(),
  password: z.string(),
  /** A browser asks for its session as an HttpOnly cookie; the reply then carries no token. */
  cookie: z.boolean().optional(),
});

// ───────────────────────── Server messages ─────────────────────────

export const ERROR_CODES = [
  "not_found",
  "disabled",
  "domain_mismatch",
  "unavailable",
  "unsupported",
  "invalid",
  "forbidden",
  "superseded",
  "timeout",
  "failed",
  "auth",
  "bad_request",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const errorSchema = z.object({ code: z.enum(ERROR_CODES), message: z.string() });

export const serverMessageSchema = z.union([
  z.object({
    type: z.literal("auth_ok"),
    version: z.number(),
    units: z.enum(["metric", "imperial"]).default("metric"),
  }),
  z.object({ id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: errorSchema }),
  z.object({
    type: z.literal("snapshot"),
    subscriptionId: z.number(),
    states: z.array(z.looseObject({ entityId: z.string() })),
  }),
  z.object({
    type: z.literal("event"),
    subscriptionId: z.number(),
    event: z.looseObject({ type: z.string() }),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
