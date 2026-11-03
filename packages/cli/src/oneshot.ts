// One-shot commands with human output: `light set`, `lock`, `switch`, `ls`, `car`, `sensors`.
// A command that reaches the server but that the device does not carry out exits 3.

import { type CasitaClient, CasitaError } from "@casita/client";
import type { Command } from "commander";
import { carLines, carsFrom, levelBar, mark, present, type Row, tint } from "./present.ts";
import { c, pad, width } from "./style.ts";

/** The device did not do what was asked: jammed, no confirmation, unavailable, refused. */
export const EXIT_DEVICE = 3;

export interface OneShotDeps {
  run(fn: (client: CasitaClient) => Promise<void>): Promise<void>;
  resolveEntityId(client: CasitaClient, idOrPrefix: string): Promise<string>;
}

const HEADLINE: Record<string, string> = {
  unavailable: "Unavailable",
  forbidden: "Not permitted",
  unsupported: "Not supported",
  invalid: "Not valid",
  timeout: "Timed out",
  failed: "Failed",
  superseded: "Replaced by a newer command",
  disabled: "Disabled",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const integrationOf = (entity: Row) =>
  String(entity.integrationId).split(".")[0] ?? "the integration";

/** Columns of aligned text; cells may be colored. */
function columns(rows: string[][], gap = 2): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => width(r[i] ?? "")))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : pad(cell, (widths[i] ?? 0) + gap)))
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Sends one command and narrates it: a "sent" line, then either the confirmed state or
 * what went wrong, why, and what to do about it.
 */
async function act(
  client: CasitaClient,
  deps: OneShotDeps,
  idOrPrefix: string,
  command: Row,
): Promise<void> {
  const id = await deps.resolveEntityId(client, idOrPrefix);
  const entities = (await client.request("get_entities", {})) as Row[];
  const entity = entities.find((e) => e.id === id);
  if (!entity) throw new CasitaError("not_found", `Unknown entity ${id}`);
  const devices = (await client.request("get_devices", {})) as Row[];
  const device = devices.find((d) => d.id === entity.deviceId);
  const label = pad(id, Math.max(16, id.length));

  console.log(`${mark.pending()} ${label}  sent · waiting for device…`);
  const started = Date.now();
  const stateNow = async () =>
    ((await client.request("get_states", { entityIds: [id] })) as Row[])[0];
  const fail = (headline: string, message: string, code: string) => {
    console.log(`${mark.warn()} ${label}  ${c.red(headline)}`);
    console.log(`  ${c.red(message)}`);
    const where = device ? String(device.name) : integrationOf(entity);
    console.log(
      c.dim(`  exit ${EXIT_DEVICE} · ${code} · ${where} · ${seconds(Date.now() - started)}`),
    );
    process.exitCode = EXIT_DEVICE;
  };

  let result: Row;
  try {
    result = (await client.request("send_command", {
      entityId: id,
      command: { domain: id.split(".")[0], ...command } as never,
      confirm: true,
    })) as Row;
  } catch (err) {
    if (!(err instanceof CasitaError) || !(err.code in HEADLINE)) throw err;
    return fail(HEADLINE[err.code] ?? "Failed", err.message, err.code);
  }

  const record = await stateNow();
  const name = String(entity.name);
  if ((record?.state as Row | undefined)?.jammed) {
    return fail(
      "Jammed",
      `The ${name.toLowerCase()} didn't finish turning. Check the bolt isn't blocked, then try again.`,
      "command_failed",
    );
  }
  if (result.status !== "confirmed") {
    return fail(
      "No confirmation",
      `${name} took the command but didn't report the change. It may be slow or out of range; check it, then try again.`,
      "unconfirmed",
    );
  }
  const took = c.dim(`confirmed by ${integrationOf(entity)} in ${seconds(Date.now() - started)}`);
  console.log(`${mark.ok()} ${label}  ${pad(tint(present(record)), 10)} ${took}`);
}

const fraction = (text: string, what: string): number => {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`${what} is a percentage from 0 to 100`);
  return value / 100;
};

export function registerOneShot(program: Command, deps: OneShotDeps): void {
  const run = (idOrPrefix: string, command: Row) =>
    deps.run((client) => act(client, deps, idOrPrefix, command));

  // ───────── light ─────────
  const light = program.command("light").description("control a light and wait for it to confirm");
  light
    .command("set <entityId>")
    .description("turn a light on with the given settings")
    .option("--brightness <percent>", "0 to 100; 0 turns it off")
    .option("--temp <kelvin>", "color temperature")
    .option("--rgb <r,g,b>", "color, each 0 to 255")
    .option("--transition <seconds>", "fade time")
    .action((entityId, opts) =>
      run(entityId, {
        action: "turn_on",
        brightness:
          opts.brightness === undefined ? undefined : fraction(opts.brightness, "--brightness"),
        colorTempK: opts.temp === undefined ? undefined : Number(opts.temp),
        rgb: opts.rgb === undefined ? undefined : String(opts.rgb).split(",").map(Number),
        transitionMs: opts.transition === undefined ? undefined : Number(opts.transition) * 1000,
      }),
    );
  light.command("on <entityId>").action((entityId) => run(entityId, { action: "turn_on" }));
  light.command("off <entityId>").action((entityId) => run(entityId, { action: "turn_off" }));

  // ───────── switch ─────────
  const power = program
    .command("switch")
    .description("control a switch and wait for it to confirm");
  power.command("on <entityId>").action((entityId) => run(entityId, { action: "turn_on" }));
  power.command("off <entityId>").action((entityId) => run(entityId, { action: "turn_off" }));
  power.command("toggle <entityId>").action((entityId) => run(entityId, { action: "toggle" }));

  // ───────── lock ─────────
  const lock = program.command("lock").description("control a lock and wait for it to confirm");
  lock.command("lock <entityId>").action((entityId) => run(entityId, { action: "lock" }));
  lock.command("unlock <entityId>").action((entityId) => run(entityId, { action: "unlock" }));
  lock
    .command("retry <entityId>")
    .description("try locking again, after a jam")
    .action((entityId) => run(entityId, { action: "lock" }));

  // ───────── ls ─────────
  program
    .command("ls")
    .description("what is in the house and what it is doing")
    .option("--area <area>", "an area id or name")
    .option("--domain <domain>")
    .option("--json")
    .action((opts) =>
      deps.run(async (client) => {
        const areas = (await client.request("get_areas", {})) as Row[];
        const wanted = opts.area ? String(opts.area).toLowerCase() : undefined;
        const area =
          wanted && areas.find((a) => a.id === wanted || String(a.name).toLowerCase() === wanted);
        if (wanted && !area) throw new CasitaError("not_found", `Unknown area ${opts.area}`);
        const all = (await client.request("get_entities", { domain: opts.domain })) as Row[];
        const entities = all.filter((e) => !e.hidden && (!area || e.effectiveAreaId === area.id));
        const states = new Map(
          ((await client.request("get_states", {})) as Row[]).map((s) => [String(s.entityId), s]),
        );
        if (opts.json) {
          return console.log(
            JSON.stringify(
              entities.map((e) => ({ ...e, state: states.get(String(e.id)) })),
              null,
              2,
            ),
          );
        }
        if (entities.length === 0) return console.log("(nothing here)");
        const readOnlyByNature = ["sensor", "binary_sensor"];
        const rows = entities.map((e) => {
          const shown = present(states.get(String(e.id)));
          const viewOnly = !e.controllable && !readOnlyByNature.includes(String(e.domain));
          return [
            String(e.name),
            c.dim(String(e.id)),
            tint(shown),
            viewOnly ? c.dim("view only") : levelBar(shown).trimEnd(),
          ];
        });
        console.log(columns([["NAME", "ID", "STATE", "LEVEL"].map(c.dim), ...rows]));
      }),
    );

  // ───────── car ─────────
  program
    .command("car")
    .description("battery, range, and charging for each vehicle")
    .option("--json")
    .action((opts) =>
      deps.run(async (client) => {
        const entities = (await client.request("get_entities", {})) as Row[];
        const devices = (await client.request("get_devices", {})) as Row[];
        const states = new Map(
          ((await client.request("get_states", {})) as Row[]).map((s) => [String(s.entityId), s]),
        );
        const cars = carsFrom(entities, devices, states);
        if (opts.json) return console.log(JSON.stringify(cars, null, 2));
        if (cars.length === 0)
          return console.log("No vehicles. Add the teslamate or tesla integration.");
        for (const car of cars) {
          const title = car.model ? `${car.name} (${car.model})` : car.name;
          const [gauge, doing] = carLines(car, 34);
          console.log(`${title}  ${gauge}`);
          console.log(`${" ".repeat(width(title) + 2)}${doing}`);
        }
      }),
    );

  // ───────── sensors ─────────
  program
    .command("sensors")
    .description("every sensor reading")
    .option("--sort <by>", "name or value", "name")
    .option("--area <area>", "an area id or name")
    .option("--json")
    .action((opts) =>
      deps.run(async (client) => {
        const areas = (await client.request("get_areas", {})) as Row[];
        const wanted = opts.area ? String(opts.area).toLowerCase() : undefined;
        const area =
          wanted && areas.find((a) => a.id === wanted || String(a.name).toLowerCase() === wanted);
        if (wanted && !area) throw new CasitaError("not_found", `Unknown area ${opts.area}`);
        const all = (await client.request("get_entities", { domain: "sensor" })) as Row[];
        const entities = all.filter((e) => !e.hidden && (!area || e.effectiveAreaId === area.id));
        const states = new Map(
          ((await client.request("get_states", {})) as Row[]).map((s) => [String(s.entityId), s]),
        );
        const reading = (e: Row) => (states.get(String(e.id))?.state as Row | undefined)?.value;
        const numeric = (e: Row) =>
          typeof reading(e) === "number" ? (reading(e) as number) : Number.NEGATIVE_INFINITY;
        entities.sort((a, b) =>
          opts.sort === "value"
            ? numeric(b) - numeric(a)
            : String(a.name).localeCompare(String(b.name)),
        );
        if (opts.json) {
          return console.log(
            JSON.stringify(
              entities.map((e) => ({ ...e, state: states.get(String(e.id)) })),
              null,
              2,
            ),
          );
        }
        if (entities.length === 0) return console.log("(no sensors)");
        const rows = entities.map((e) => {
          const record = states.get(String(e.id));
          const state = record?.state as Row | undefined;
          const value = typeof state?.value === "number" ? state.value : undefined;
          // The few readings with a well-known "this needs attention" level.
          const flag =
            value !== undefined && state?.unit === "ppm" && value >= 1000
              ? " ▲ high"
              : value !== undefined && state?.deviceClass === "battery" && value <= 20
                ? " ▲ low"
                : "";
          return [
            String(e.name),
            c.dim(String(e.id)),
            `${tint(present(record))}${flag ? c.red(flag) : ""}`,
          ];
        });
        console.log(columns([["NAME", "ID", "VALUE"].map(c.dim), ...rows]));
      }),
    );
}
