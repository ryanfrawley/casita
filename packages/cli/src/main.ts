#!/usr/bin/env bun
// casita — a thin client over the WebSocket API. Nothing here talks to the core directly.
// Exit codes: 0 success, 1 server-side error (the code is printed), 2 usage or connection error.

import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  asSettings,
  CasitaClient,
  CasitaError,
  endpoints,
  findSettings,
  settingLabel,
  settingSections,
  settingText,
  setUnits,
} from "@casita/client";
import { Command, CommanderError } from "commander";
import { runDash } from "./dash-run.ts";
import {
  duration,
  parseFlags,
  parseValue,
  pretendValues,
  RUN_COLUMNS,
  runRow,
  settingArgument,
  summarize,
  table,
  time,
} from "./format.ts";
import { registerOneShot } from "./oneshot.ts";
import { setTheme, themeFromEnv } from "./style.ts";

type Row = Record<string, unknown>;

class UsageError extends Error {}

const credentialsPath = () =>
  Bun.env.CASITA_CREDENTIALS ?? join(homedir(), ".config", "casita", "credentials");

async function readCredentials(): Promise<{ url?: string; token?: string }> {
  const file = Bun.file(credentialsPath());
  return (await file.exists()) ? ((await file.json()) as { url?: string; token?: string }) : {};
}

/** Set while inside `casita repl`: the one connection every command then runs on. */
let shared: CasitaClient | undefined;

const createProgram = (interactive: boolean) => {
  const created = new Command("casita")
    .description("Command-line client for the home automation core")
    .option(
      "--url <url>",
      "server URL (default: $CASITA_URL, then the stored login, then http://localhost:8123)",
    )
    .option(
      "--token <token>",
      "API or session token (default: $CASITA_TOKEN, then the stored login)",
    )
    .showHelpAfterError();
  // In the REPL a bad command reports and returns to the prompt instead of exiting.
  if (interactive) created.exitOverride();
  return created;
};

let program = createProgram(false);

async function target(): Promise<{ url: string; token?: string }> {
  const opts = program.opts<{ url?: string; token?: string }>();
  const stored = await readCredentials();
  return {
    // `||` so an empty environment variable falls through to the next source.
    url: opts.url || Bun.env.CASITA_URL || stored.url || "http://localhost:8123",
    token: opts.token || Bun.env.CASITA_TOKEN || stored.token,
  };
}

/** Connects, runs one command, and maps failures to exit codes. */
async function run(fn: (client: CasitaClient) => Promise<void>): Promise<void> {
  if (shared) {
    try {
      await fn(shared);
    } catch (err) {
      fail(err);
    }
    return;
  }
  let client: CasitaClient | undefined;
  try {
    const { url, token } = await target();
    if (!token)
      throw new UsageError("No token: run `casita login`, or set CASITA_TOKEN or --token.");
    client = await CasitaClient.connect(url, token);
    setUnits(client.units);
    await fn(client);
  } catch (err) {
    fail(err);
  } finally {
    client?.close();
  }
}

function fail(err: unknown): void {
  if (err instanceof CasitaError && err.code !== "connection" && err.code !== "auth") {
    console.error(`error [${err.code}]: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}

const print = (json: boolean | undefined, data: unknown, human: () => string) =>
  console.log(json ? JSON.stringify(data, null, 2) : human());

/** Accepts a full entity id or a unique prefix of one. */
async function resolveEntityId(client: CasitaClient, idOrPrefix: string): Promise<string> {
  const entities = (await client.request("get_entities", {})) as Row[];
  const ids = entities.map((e) => String(e.id));
  if (ids.includes(idOrPrefix)) return idOrPrefix;
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length > 1)
    throw new UsageError(`"${idOrPrefix}" is ambiguous: ${matches.join(", ")}`);
  // No match: let the server answer, so a renamed id gets its hint.
  return matches[0] ?? idOrPrefix;
}

/** A device by its id, its name, or the start of either; device ids are not made to be typed. */
async function resolveDevice(client: CasitaClient, idOrName: string): Promise<Row> {
  const devices = (await client.request("get_devices", {})) as Row[];
  const wanted = idOrName.toLowerCase();
  const exact = devices.filter((d) => d.id === idOrName || String(d.name).toLowerCase() === wanted);
  const matches = exact.length
    ? exact
    : devices.filter(
        (d) => String(d.id).startsWith(idOrName) || String(d.name).toLowerCase().startsWith(wanted),
      );
  if (matches.length > 1) {
    throw new UsageError(
      `"${idOrName}" is ambiguous: ${matches.map((d) => `${d.name} (${d.id})`).join(", ")}`,
    );
  }
  const device = matches[0];
  if (!device) throw new CasitaError("not_found", `Unknown device ${idOrName}`);
  return device;
}

/** What --icon or --class means: undefined leaves it alone, "default" clears it, else the name. */
const chosenOption = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value === "default" ? null : value;

/** What --area means: undefined leaves the area alone, "none" clears it, else an area id or name. */
async function areaOption(
  client: CasitaClient,
  area: string | undefined,
): Promise<string | null | undefined> {
  if (area === undefined) return undefined;
  const wanted = area.trim().toLowerCase();
  if (wanted === "none") return null;
  const areas = (await client.request("get_areas", {})) as Row[];
  const found = areas.find((a) => a.id === wanted || String(a.name).toLowerCase() === wanted);
  if (!found) throw new CasitaError("not_found", `Unknown area ${area || '""'}`);
  return String(found.id);
}

async function userId(client: CasitaClient, username: string): Promise<string> {
  const users = (await client.request("list_users", {})) as Row[];
  const user = users.find((u) => u.username === username.toLowerCase());
  if (!user) throw new CasitaError("not_found", `Unknown user ${username}`);
  return String(user.id);
}

/** Reads one line from the terminal; hidden input for passwords when stdin is a TTY. */
async function ask(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  if (!hidden || !stdin.isTTY) {
    for await (const line of console) return line;
    return "";
  }
  stdin.setRawMode(true);
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return value;
        if (char === "\u0003") throw new UsageError("Cancelled");
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    }
    return value;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

const newPassword = async () => Bun.env.CASITA_PASSWORD ?? (await ask("Password: ", true));

/** "24h", "7d", "30m", or anything Date can parse → epoch milliseconds. */
function parseSince(text: string): number {
  const relative = /^(\d+)([mhd])$/.exec(text);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
    return Date.now() - Number(relative[1]) * unit;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at))
    throw new UsageError(`Cannot read "${text}" as a time; try 24h, 7d, or an ISO date`);
  return at;
}

/** Registers every subcommand on `program`. */
function register(program: Command): void {
  // ───────────────────────── status and reads ─────────────────────────

  program
    .command("status")
    .description("server version, uptime, integration statuses, entity and device counts")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const status = (await client.request("get_status", {})) as Row & {
          integrations: Row[];
          uptimeMs: number;
        };
        print(opts.json, status, () =>
          [
            `version   ${status.version} (protocol ${status.protocol})`,
            `uptime    ${duration(status.uptimeMs)}`,
            `units     ${status.units ?? "metric"}`,
            `entities  ${status.entities}`,
            `devices   ${status.devices}`,
            "",
            table(status.integrations, ["integrationId", "status", "error"]),
          ].join("\n"),
        );
      }),
    );

  program
    .command("entities")
    .description("entities with a summary of their current state")
    .option("--domain <domain>")
    .option("--area <areaId>")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const entities = (await client.request("get_entities", {
          domain: opts.domain,
          areaId: opts.area,
        })) as Row[];
        const states = (await client.request("get_states", {})) as Row[];
        const byId = new Map(states.map((s) => [s.entityId, s]));
        const rows = entities.map((e) => ({ ...e, state: summarize(byId.get(e.id)) }));
        print(opts.json, rows, () =>
          table(rows, ["id", "name", "state", "areaId", "integrationId"]),
        );
      }),
    );

  program
    .command("devices")
    .description("devices with manufacturer, model, and entity count")
    .option("--area <areaId>")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const devices = (await client.request("get_devices", { areaId: opts.area })) as Row[];
        const entities = (await client.request("get_entities", {})) as Row[];
        const rows = devices.map((d) => ({
          ...d,
          entities: entities.filter((e) => e.deviceId === d.id).length,
        }));
        print(opts.json, rows, () =>
          table(rows, ["id", "name", "manufacturer", "model", "entities", "areaId"]),
        );
      }),
    );

  program
    .command("state <entityId>")
    .description("full state record and attributes")
    .option("--json")
    .action((entityId, opts) =>
      run(async (client) => {
        const id = await resolveEntityId(client, entityId);
        const [record] = (await client.request("get_states", { entityIds: [id] })) as Row[];
        print(opts.json, record ?? null, () =>
          record
            ? [
                `${id}  ${summarize(record)}`,
                `state       ${JSON.stringify(record.state)}`,
                `attributes  ${JSON.stringify(record.attributes ?? {})}`,
                `changed     ${time(record.changedAt)}`,
                `updated     ${time(record.updatedAt)}`,
              ].join("\n")
            : `${id}  no state reported yet`,
        );
      }),
    );

  program
    .command("watch [entityIds...]")
    .description("stream state changes, one line each, until Ctrl-C")
    .option("--json", "print raw events")
    .action((entityIds: string[], opts) =>
      run(async (client) => {
        const ids = await Promise.all(entityIds.map((id) => resolveEntityId(client, id)));
        client.onEvent(({ event }) => {
          if (opts.json) return console.log(JSON.stringify(event));
          const record = event.new as Row;
          console.log(`${time(record.updatedAt)}  ${event.entityId}  ${summarize(record)}`);
        });
        await client.request("subscribe", {
          events: ["state_changed"],
          entityIds: ids.length ? ids : undefined,
        });
        const dropped = await new Promise<boolean>((resolve) => {
          process.once("SIGINT", () => resolve(false));
          process.once("SIGTERM", () => resolve(false));
          client.onClose(() => resolve(true));
        });
        if (dropped) throw new CasitaError("connection", "Connection closed");
      }),
    );

  // ───────────────────────── commands ─────────────────────────

  function printResult(result: Row): void {
    console.log(
      `${result.entityId}  ${result.status}  ${result.latencyMs}ms  ${JSON.stringify(result.command)}`,
    );
  }

  program
    .command("cmd <entityId> <action>")
    .description(
      "send a command; flags map to command fields (--brightness 0.5), --confirm waits for the device",
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action((entityId, action, _opts, command: Command) =>
      run(async (client) => {
        const { confirm, json, ...fields } = parseFlags(command.args.slice(2));
        const id = await resolveEntityId(client, entityId);
        const result = (await client.request("send_command", {
          entityId: id,
          // The server validates the shape; the CLI only assembles it.
          command: { domain: id.split(".")[0], action, ...fields } as never,
          confirm: confirm === true,
        })) as Row;
        if (json) console.log(JSON.stringify(result, null, 2));
        else printResult(result);
        if (confirm && result.status === "unconfirmed") process.exitCode = 1;
      }),
    );

  const area = program.command("area").description("areas and area-wide commands");

  area
    .command("cmd <areaId> <domain> <action>")
    .description("send a command to every entity of a domain in an area")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((areaId, domain, action, _opts, command: Command) =>
      run(async (client) => {
        const { confirm, json, ...fields } = parseFlags(command.args.slice(3));
        const outcomes = (await client.request("send_area_command", {
          areaId,
          command: { domain, action, ...fields } as never,
          confirm: confirm === true,
        })) as { entityId: string; result?: Row; error?: Row }[];
        const rows = outcomes.map((o) => ({
          entityId: o.entityId,
          status: o.result?.status ?? `error [${o.error?.code}]`,
          detail: o.error?.message ?? `${o.result?.latencyMs}ms`,
        }));
        print(json === true, outcomes, () => table(rows, ["entityId", "status", "detail"]));
        if (outcomes.some((o) => o.error || (confirm && o.result?.status === "unconfirmed")))
          process.exitCode = 1;
      }),
    );

  area
    .command("list")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const areas = (await client.request("get_areas", {})) as Row[];
        print(opts.json, areas, () => table(areas, ["id", "name"]));
      }),
    );

  area.command("add <name>").action((name) =>
    run(async (client) => {
      const created = (await client.request("create_area", { name })) as Row;
      console.log(`Created area ${created.id}`);
    }),
  );

  area
    .command("set <areaId>")
    .description("rename an area or give it an icon")
    .option("--name <name>")
    .option("--icon <icon>", 'an icon name such as "sprout"; "default" clears it')
    .action((areaId, opts) =>
      run(async (client) => {
        if (opts.name === undefined && opts.icon === undefined) {
          throw new UsageError("Nothing to change: pass --name or --icon");
        }
        const area = await client.request("update_area", {
          areaId,
          name: opts.name,
          icon: chosenOption(opts.icon),
        });
        console.log(JSON.stringify(area, null, 2));
      }),
    );

  area.command("rm <areaId>").action((areaId) =>
    run(async (client) => {
      await client.request("delete_area", { areaId });
      console.log(`Removed area ${areaId}`);
    }),
  );

  // ───────────────────────── Casa pages and themes ─────────────────────────

  /** A source given inline, as "@file", or "-" for stdin. */
  const sourceOption = async (value: string): Promise<string> => {
    if (value === "-") return await Bun.stdin.text();
    return value.startsWith("@") ? await Bun.file(value.slice(1)).text() : value;
  };
  /** One diagnostic per line, the way the editor's problems list reads. */
  const diagnosticLines = (diagnostics: Row[]): string =>
    diagnostics
      .map(
        (d) => `${(d.span as Row).line}:${(d.span as Row).col} ${d.level} ${d.code} ${d.message}`,
      )
      .join("\n");
  /** Prints diagnostics; exits 1 when the save or check was refused. */
  const reportCompile = (json: boolean, result: Row, okLine: string) => {
    const diagnostics = (result.diagnostics as Row[]) ?? [];
    print(json, result, () =>
      [diagnosticLines(diagnostics), result.ok === false ? "Not saved" : okLine]
        .filter(Boolean)
        .join("\n"),
    );
    if (result.ok === false) process.exitCode = 1;
  };

  const pageCommand = program
    .command("page")
    .description("pages the web app draws, written in Casa by an admin");

  pageCommand
    .command("list")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const pages = (await client.request("list_pages", {})) as Row[];
        print(opts.json, pages, () => table(pages, ["id", "name", "updatedAt", "updatedBy"]));
      }),
    );

  pageCommand
    .command("show <pageId>")
    .description("the compiled page, as the browser gets it")
    .option("--json")
    .action((pageId, opts) =>
      run(async (client) => {
        const page = (await client.request("get_page", { pageId })) as Row;
        print(opts.json, page, () => JSON.stringify(page.compiled, null, 2));
      }),
    );

  pageCommand
    .command("source <pageId>")
    .description("the page's source; --versions lists what it was saved as")
    .option("--versions", "list the saved versions instead of the source")
    .option("--json")
    .action((pageId, opts) =>
      run(async (client) => {
        const result = (await client.request("get_page_source", { pageId })) as Row;
        print(opts.json, result, () =>
          opts.versions
            ? table(result.versions as Row[], ["version", "savedAt", "savedBy"])
            : String(result.source),
        );
      }),
    );

  pageCommand
    .command("check <pageId> <source>")
    .description('compile a source without saving it: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((pageId, source, opts) =>
      run(async (client) => {
        const result = (await client.request("check_page", {
          pageId,
          source: await sourceOption(source),
        })) as Row;
        const errors = (result.diagnostics as Row[]).some((d) => d.level === "error");
        reportCompile(opts.json, { ...result, ok: !errors }, "OK");
      }),
    );

  pageCommand
    .command("save <pageId> <source>")
    .description('compile and publish a source: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((pageId, source, opts) =>
      run(async (client) => {
        const result = (await client.request("save_page", {
          pageId,
          source: await sourceOption(source),
        })) as Row;
        reportCompile(opts.json, result, `Saved ${pageId}`);
      }),
    );

  pageCommand
    .command("revert <pageId> <version>")
    .description("save an earlier version's source again")
    .option("--json")
    .action((pageId, version, opts) =>
      run(async (client) => {
        const result = (await client.request("revert_page", {
          pageId,
          version: Number(version),
        })) as Row;
        reportCompile(opts.json, result, `Reverted ${pageId} to version ${version}`);
      }),
    );

  const themeCommand = program
    .command("theme")
    .description("themes a page is drawn in; Day and Night are built in");

  themeCommand
    .command("list")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const themes = (await client.request("list_themes", {})) as Row[];
        print(opts.json, themes, () =>
          table(themes, ["id", "name", "extends", "dark", "isLightDefault", "isDarkDefault"]),
        );
      }),
    );

  themeCommand
    .command("save <themeId> <source>")
    .description('compile and store a theme: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((themeId, source, opts) =>
      run(async (client) => {
        const result = (await client.request("save_theme", {
          themeId,
          source: await sourceOption(source),
        })) as Row;
        reportCompile(opts.json, result, `Saved theme ${themeId}`);
      }),
    );

  const componentsCommand = program
    .command("components")
    .description(
      "the house's shared components: one Casa file every page may use; an AreaHeader, CardHeader or SectionHeader in it replaces Casita's",
    );

  componentsCommand
    .command("get")
    .description("the shared file's source")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const record = (await client.request("get_components_source", {})) as Row;
        print(opts.json, record, () => String(record.source ?? ""));
      }),
    );

  componentsCommand
    .command("check <source>")
    .description('compile the shared file without storing it: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((source, opts) =>
      run(async (client) => {
        const result = (await client.request("check_components", {
          source: await sourceOption(source),
        })) as Row;
        const diagnostics = (result.diagnostics as Row[]) ?? [];
        print(opts.json, result, () => diagnosticLines(diagnostics) || "No problems");
        if (diagnostics.some((d) => d.level === "error")) process.exitCode = 1;
      }),
    );

  componentsCommand
    .command("save <source>")
    .description(
      'compile the shared file and every page against it, then store it: the text, "@file", or "-" for stdin',
    )
    .option("--json")
    .action((source, opts) =>
      run(async (client) => {
        const result = (await client.request("save_components", {
          source: await sourceOption(source),
        })) as Row;
        if (result.page) {
          // A stored page no longer compiles against the file: say which, and why.
          const problems = (result.pageDiagnostics as Row[]) ?? [];
          print(opts.json, result, () =>
            [`Page ${result.page} would not compile:`, diagnosticLines(problems), "Not saved"]
              .filter(Boolean)
              .join("\n"),
          );
          process.exitCode = 1;
          return;
        }
        reportCompile(opts.json, result, "Saved the shared components");
      }),
    );

  // ───────────────────────── entity metadata ─────────────────────────

  program
    .command("rename <entityId> <newId>")
    .description("change an entity's id; the old id stays reserved as an alias for 30 days")
    .action((entityId, newId) =>
      run(async (client) => {
        const id = await resolveEntityId(client, entityId);
        await client.request("update_entity", { entityId: id, newId });
        console.log(
          `Renamed ${id} to ${newId}. ${id} is kept as an alias for 30 days and will report the new id.`,
        );
      }),
    );

  program
    .command("entity")
    .description("entity metadata")
    .command("set <entityId>")
    .option("--name <name>")
    .option("--area <area>", 'area override, as an id or name; "none" clears it')
    .option("--hidden <bool>")
    .option("--disabled <bool>")
    .option("--icon <icon>", 'an icon name such as "fan"; "default" clears it')
    .option(
      "--class <class>",
      'what a sensor is, such as "window" or "temperature"; "default" keeps its integration\'s',
    )
    .action((entityId, opts) =>
      run(async (client) => {
        const id = await resolveEntityId(client, entityId);
        const flag = (v: string | undefined) => (v === undefined ? undefined : v === "true");
        const entity = await client.request("update_entity", {
          entityId: id,
          name: opts.name,
          areaId: await areaOption(client, opts.area),
          hidden: flag(opts.hidden),
          disabled: flag(opts.disabled),
          icon: chosenOption(opts.icon),
          deviceClass: chosenOption(opts.class),
        });
        console.log(JSON.stringify(entity, null, 2));
      }),
    );

  const deviceCommand = program.command("device").description("device metadata");
  deviceCommand
    .command("set <device>")
    .description(
      "rename a device, change its id, move it to an area, or give it an icon; takes a device id or name",
    )
    .option("--name <name>")
    .option("--id <id>", "a new id, as Casa names it: `device.<id>`; [a-z0-9_]")
    .option("--area <area>", 'the area the device is in, as an id or name; "none" clears it')
    .option("--icon <icon>", 'an icon name such as "fan"; "default" clears it')
    .option("--json")
    .action((idOrName, opts) =>
      run(async (client) => {
        if (
          opts.name === undefined &&
          opts.id === undefined &&
          opts.area === undefined &&
          opts.icon === undefined
        ) {
          throw new UsageError("Nothing to change: pass --name, --id, --area or --icon");
        }
        const before = await resolveDevice(client, idOrName);
        const device = (await client.request("update_device", {
          deviceId: String(before.id),
          name: opts.name,
          newId: opts.id,
          areaId: await areaOption(client, opts.area),
          icon: chosenOption(opts.icon),
        })) as Row;
        print(opts.json, device, () =>
          [
            opts.name === undefined || device.name === before.name
              ? undefined
              : `Renamed ${before.name} to ${device.name}`,
            opts.id === undefined || device.id === before.id
              ? undefined
              : `${device.name} is device.${device.id} now; pages that said device.${before.id} need the new id`,
            opts.area === undefined
              ? undefined
              : device.areaId
                ? `${device.name} is now in ${device.areaId}; its entities follow unless they have an area of their own`
                : `${device.name} is no longer in an area`,
            opts.icon === undefined ? undefined : `Icon: ${device.icon ?? "default"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }),
    );
  deviceCommand
    .command("show <device>")
    .description("a device's metadata; takes a device id or name")
    .option("--json")
    .action((idOrName, opts) =>
      run(async (client) => {
        const device = await resolveDevice(client, idOrName);
        print(opts.json, device, () =>
          [
            `${device.name}  ${device.id}`,
            [device.manufacturer, device.model].filter(Boolean).join(" · ") || undefined,
            `Integration: ${device.integrationId}`,
            `Area: ${device.areaId ?? "none"}`,
            `Icon: ${device.icon ?? "default"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }),
    );

  deviceCommand
    .command("settings <device>")
    .description(
      "what can be adjusted on a device, as its integration describes it; --find narrows it",
    )
    .option("--find <words>", "only settings whose key, label or group holds these words")
    .option("--json")
    .action((idOrName, opts) =>
      run(async (client) => {
        const device = await resolveDevice(client, idOrName);
        const all = asSettings(
          await client.request("get_device_settings", { deviceId: String(device.id) }),
        );
        const settings = findSettings(all, opts.find ?? "");
        print(opts.json, settings, () => {
          if (!all.length) return `${device.name} has no settings Casita can change`;
          return settingSections(settings)
            .map((section) =>
              [
                section.title ? `\n${section.title}` : undefined,
                table(
                  section.settings.map((s) => ({
                    key: s.key,
                    label: settingLabel(s),
                    value: settingText(s) + (s.readOnly ? " (reported)" : ""),
                  })),
                  ["key", "label", "value"],
                ),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n");
        });
      }),
    );
  deviceCommand
    .command("setting <device> <key> <value>")
    .description(
      "changes one device setting; the value is a number, on or off, an option's name, or text",
    )
    .option("--json")
    .action((idOrName, key, text, opts) =>
      run(async (client) => {
        const device = await resolveDevice(client, idOrName);
        const settings = asSettings(
          await client.request("get_device_settings", { deviceId: String(device.id) }),
        );
        const value = settingArgument(
          settings.find((s) => s.key === key),
          text,
        );
        const result = (await client.request("set_device_setting", {
          deviceId: String(device.id),
          key,
          value,
        })) as Row;
        print(
          opts.json,
          result,
          () =>
            `Sent ${key} = ${String(result.value)} to ${device.name}; it shows when the device reports it`,
        );
      }),
    );

  // ───────────────────────── history and backup ─────────────────────────

  program
    .command("history <entityId>")
    .description(
      "state history; --from and --to take 24h, 7d, or an ISO date (default: the last 24 hours)",
    )
    .option("--from <when>")
    .option("--to <when>")
    .option("--resolution <tier>", "raw, minute, hour, or day", "raw")
    .option("--limit <n>")
    .option("--csv")
    .option("--json")
    .action((entityId, opts) =>
      run(async (client) => {
        const id = await resolveEntityId(client, entityId);
        const result = (await client.request("get_history", {
          entityId: id,
          from: parseSince(opts.from ?? "24h"),
          to: opts.to ? parseSince(opts.to) : Date.now(),
          resolution: opts.resolution,
          limit: opts.limit ? Number(opts.limit) : undefined,
        })) as { resolution: string; records: Row[] };
        if (opts.json) return console.log(JSON.stringify(result, null, 2));
        if (result.resolution !== opts.resolution) {
          console.error(
            `Showing ${result.resolution} history: ${opts.resolution} is no longer kept that far back.`,
          );
        }
        const raw = result.resolution === "raw";
        const rows = result.records.map((r) =>
          raw
            ? { time: time(r.updatedAt), state: summarize(r), detail: JSON.stringify(r.state) }
            : { ...r, time: time(r.bucketStart), last: summarize({ state: r.last }) },
        );
        const columns = raw
          ? ["time", "state", "detail"]
          : ["time", "samples", "min", "max", "mean", "last", "changes", "onSeconds"];
        if (!opts.csv) return console.log(table(rows, columns));
        const cell = (v: unknown) =>
          v === undefined ? "" : `"${String(v).replaceAll('"', '""')}"`;
        console.log(columns.join(","));
        for (const row of rows as Row[]) console.log(columns.map((c) => cell(row[c])).join(","));
      }),
    );

  program
    .command("backup")
    .description("write a copy of the database next to it; the newest seven are kept (admin)")
    .action(() =>
      run(async (client) => {
        const result = (await client.request("backup", {})) as Row;
        console.log(`Backup written to ${result.path}`);
      }),
    );

  // ───────────────────────── integrations and config ─────────────────────────

  program
    .command("integrations")
    .description("integration instances and their status")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const list = (await client.request("get_integrations", {})) as (Row & { actions: Row[] })[];
        const rows = list.map((i) => ({
          ...i,
          since: time(i.since),
          actions: i.actions.map((a) => a.name).join(", "),
        }));
        print(opts.json, list, () =>
          table(rows, ["integrationId", "status", "since", "actions", "error"]),
        );
      }),
    );

  const integration = program.command("integration").description("act on one integration instance");

  integration
    .command("action <integrationId> <action>")
    .description("run an integration action such as permit_join; flags become its parameters")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((integrationId, action, _opts, command: Command) =>
      run(async (client) => {
        const params = parseFlags(command.args.slice(2));
        const result = await client.request("integration_action", {
          integrationId,
          action,
          params,
        });
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  integration.command("reload <integrationId>").action((integrationId) =>
    run(async (client) => {
      await client.request("reload_integration", { integrationId });
      console.log(`Reloaded ${integrationId}`);
    }),
  );

  const automationCommand = program
    .command("automation")
    .description("automations, written in Casa by an admin and run on the server");

  automationCommand
    .command("list")
    .description("every automation with its status and last error")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const list = (await client.request("get_automations", {})) as Row[];
        print(opts.json, list, () =>
          table(list, ["id", "kind", "name", "enabled", "handlers", "status", "error"]),
        );
      }),
    );

  automationCommand
    .command("source <automationId>")
    .description("the automation's source; --versions lists what it was saved as")
    .option("--versions", "list the saved versions instead of the source")
    .option("--json")
    .action((automationId, opts) =>
      run(async (client) => {
        const result = (await client.request("get_automation_source", { automationId })) as Row;
        print(opts.json, result, () =>
          opts.versions
            ? table(result.versions as Row[], ["version", "savedAt", "savedBy"])
            : String(result.source),
        );
      }),
    );

  automationCommand
    .command("check <source>")
    .description('compile a source without saving it: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((source, opts) =>
      run(async (client) => {
        const result = (await client.request("check_automation", {
          source: await sourceOption(source),
        })) as Row;
        const errors = (result.diagnostics as Row[]).some((d) => d.level === "error");
        reportCompile(opts.json, { ...result, ok: !errors }, "OK");
      }),
    );

  automationCommand
    .command("save <automationId> <source>")
    .description('compile and store a source: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((automationId, source, opts) =>
      run(async (client) => {
        const result = (await client.request("save_automation", {
          automationId,
          source: await sourceOption(source),
        })) as Row;
        reportCompile(opts.json, result, `Saved ${automationId}`);
      }),
    );

  automationCommand
    .command("revert <automationId> <version>")
    .description("save an earlier version's source again")
    .option("--json")
    .action((automationId, version, opts) =>
      run(async (client) => {
        const result = (await client.request("revert_automation", {
          automationId,
          version: Number(version),
        })) as Row;
        reportCompile(opts.json, result, `Reverted ${automationId} to version ${version}`);
      }),
    );

  automationCommand.command("delete <automationId>").action((automationId) =>
    run(async (client) => {
      await client.request("delete_automation", { automationId });
      console.log(`Deleted ${automationId}`);
    }),
  );

  automationCommand
    .command("enable <automationId>")
    .description("arm its handlers; `disable` leaves the source and stops them")
    .action((automationId) =>
      run(async (client) => {
        await client.request("set_automation_enabled", { automationId, enabled: true });
        console.log(`Enabled ${automationId}`);
      }),
    );

  automationCommand.command("disable <automationId>").action((automationId) =>
    run(async (client) => {
      await client.request("set_automation_enabled", { automationId, enabled: false });
      console.log(`Disabled ${automationId}`);
    }),
  );

  automationCommand
    .command("runs <automationId>")
    .description("the last firings the server remembers, newest first")
    .option("--json")
    .action((automationId, opts) =>
      run(async (client) => {
        const runs = (await client.request("get_automation_runs", { automationId })) as Row[];
        print(opts.json, runs, () => table(runs.map(runRow), RUN_COLUMNS));
      }),
    );

  automationCommand
    .command("test <automationId>")
    .description(
      "run a handler now, as if its trigger fired; its commands and actions are real. " +
        "Without --pretend it reads the house as it is",
    )
    .option("--line <n>", "the handler's line, when there are several", (text: string) => {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1)
        throw new UsageError(`--line takes a line number, not ${text}`);
      return n;
    })
    .option(
      "--pretend <key=value>",
      "pretend a value: sensor.x=21, weather.home#conditionNext12h=rain (repeatable)",
      (pair: string, all: string[] = []) => [...all, pair],
    )
    .option("--json")
    .action((automationId, opts) =>
      run(async (client) => {
        const pretend = opts.pretend ? pretendValues(opts.pretend as string[]) : undefined;
        const result = (await client.request("test_automation", {
          automationId,
          ...(opts.line ? { line: opts.line } : {}),
          ...(pretend ? { pretend } : {}),
        })) as Row;
        print(opts.json, result, () => table([runRow(result)], RUN_COLUMNS));
      }),
    );

  const sensorCommand = program
    .command("sensor")
    .description("derived sensors, written in Casa by an admin and computed on the server");

  sensorCommand
    .command("list")
    .description("every derived sensor with its entity, status and last error")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const list = (await client.request("get_sensors", {})) as Row[];
        print(opts.json, list, () =>
          table(list, ["id", "name", "type", "entityId", "enabled", "status", "error"]),
        );
      }),
    );

  sensorCommand
    .command("source <sensorId>")
    .description("the sensor's source; --versions lists what it was saved as")
    .option("--versions", "list the saved versions instead of the source")
    .option("--json")
    .action((sensorId, opts) =>
      run(async (client) => {
        const result = (await client.request("get_sensor_source", { sensorId })) as Row;
        print(opts.json, result, () =>
          opts.versions
            ? table(result.versions as Row[], ["version", "savedAt", "savedBy"])
            : String(result.source),
        );
      }),
    );

  sensorCommand
    .command("check <source>")
    .description('compile a source without saving it: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((source, opts) =>
      run(async (client) => {
        const result = (await client.request("check_sensor", {
          source: await sourceOption(source),
        })) as Row;
        const errors = (result.diagnostics as Row[]).some((d) => d.level === "error");
        reportCompile(opts.json, { ...result, ok: !errors }, "OK");
      }),
    );

  sensorCommand
    .command("save <sensorId> <source>")
    .description('compile and store a source: the text, "@file", or "-" for stdin')
    .option("--json")
    .action((sensorId, source, opts) =>
      run(async (client) => {
        const result = (await client.request("save_sensor", {
          sensorId,
          source: await sourceOption(source),
        })) as Row;
        const entity = (result.sensor as Row | undefined)?.entityId;
        reportCompile(opts.json, result, `Saved ${sensorId}${entity ? ` as ${entity}` : ""}`);
      }),
    );

  sensorCommand
    .command("revert <sensorId> <version>")
    .description("save an earlier version's source again")
    .option("--json")
    .action((sensorId, version, opts) =>
      run(async (client) => {
        const result = (await client.request("revert_sensor", {
          sensorId,
          version: Number(version),
        })) as Row;
        reportCompile(opts.json, result, `Reverted ${sensorId} to version ${version}`);
      }),
    );

  sensorCommand
    .command("delete <sensorId>")
    .description("remove the sensor and its entity, with the entity's history")
    .action((sensorId) =>
      run(async (client) => {
        await client.request("delete_sensor", { sensorId });
        console.log(`Deleted ${sensorId}`);
      }),
    );

  sensorCommand
    .command("enable <sensorId>")
    .description("compute it again; `disable` leaves the source and makes its entity unavailable")
    .action((sensorId) =>
      run(async (client) => {
        await client.request("set_sensor_enabled", { sensorId, enabled: true });
        console.log(`Enabled ${sensorId}`);
      }),
    );

  sensorCommand.command("disable <sensorId>").action((sensorId) =>
    run(async (client) => {
      await client.request("set_sensor_enabled", { sensorId, enabled: false });
      console.log(`Disabled ${sensorId}`);
    }),
  );

  const config = program.command("config").description("read or write server config");

  config.command("get [path]").action((path) =>
    run(async (client) => {
      const result = (await client.request("get_config", { path })) as Row;
      console.log(JSON.stringify(result.value, null, 2));
    }),
  );

  config
    .command("set <path> <value>")
    .description('value is parsed as JSON when possible; "null" removes the key')
    .action((path, value) =>
      run(async (client) => {
        const result = (await client.request("set_config", {
          path,
          value: parseValue(value),
        })) as Row;
        console.log(JSON.stringify(result.value, null, 2));
        // In the REPL the connection outlives the change, so the units it was told at the start go stale.
        if (path === "" || path.startsWith("server")) {
          setUnits(
            ((await client.request("get_status", {})) as Row).units === "imperial"
              ? "imperial"
              : "metric",
          );
        }
      }),
    );

  program
    .command("schema")
    .description("dump the JSON Schema of the API")
    .action(async () => {
      try {
        const { url, token } = await target();
        if (!token)
          throw new UsageError("No token: run `casita login`, or set CASITA_TOKEN or --token.");
        const response = await fetch(`${endpoints(url).http}/api/schema`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new CasitaError("auth", `Server answered ${response.status}`);
        console.log(JSON.stringify(await response.json(), null, 2));
      } catch (err) {
        fail(err);
      }
    });

  // ───────────────────────── identity ─────────────────────────

  program
    .command("login")
    .description("log in with a username and password and store the session token")
    .option("--username <username>")
    .action(async (opts) => {
      try {
        const { url } = await target();
        const username = opts.username ?? (await ask("Username: "));
        const password = await newPassword();
        const response = await fetch(`${endpoints(url).http}/api/auth/login`, {
          method: "POST",
          body: JSON.stringify({ username, password }),
        }).catch(() => {
          throw new CasitaError("connection", `Cannot connect to ${url}`);
        });
        const body = (await response.json()) as {
          token?: string;
          error?: { code: string; message: string };
        };
        if (!response.ok || !body.token) {
          console.error(
            `error [${body.error?.code ?? response.status}]: ${body.error?.message ?? "Login failed"}`,
          );
          process.exitCode = 1;
          return;
        }
        const path = credentialsPath();
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, JSON.stringify({ url, token: body.token }));
        await chmod(path, 0o600);
        console.log(`Logged in as ${username.toLowerCase()}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("logout")
    .description("end the stored session")
    .action(async () => {
      try {
        const stored = await readCredentials();
        if (stored.url && stored.token) {
          await fetch(`${endpoints(stored.url).http}/api/auth/logout`, {
            method: "POST",
            headers: { authorization: `Bearer ${stored.token}` },
          }).catch(() => undefined);
        }
        await rm(credentialsPath(), { force: true });
        console.log("Logged out");
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("whoami")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const me = (await client.request("get_me", {})) as { user: Row };
        print(opts.json, me, () => `${me.user.username} (${me.user.role})`);
      }),
    );

  const user = program.command("user").description("manage users (admin)");

  user
    .command("list")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const users = (await client.request("list_users", {})) as Row[];
        print(opts.json, users, () =>
          table(users, ["username", "displayName", "role", "disabled", "id"]),
        );
      }),
    );

  user
    .command("create <username>")
    .description("prompts for the password (or reads $CASITA_PASSWORD)")
    .requiredOption("--role <role>", "admin, member, or guest")
    .option("--display-name <name>")
    .action((username, opts) =>
      run(async (client) => {
        const created = (await client.request("create_user", {
          username,
          role: opts.role,
          displayName: opts.displayName,
          password: await newPassword(),
        })) as Row;
        console.log(`Created ${created.username} (${created.role})`);
      }),
    );

  const updateUser =
    (describe: (username: string) => string, patch: (...args: string[]) => Promise<Row> | Row) =>
    (username: string, ...rest: string[]) =>
      run(async (client) => {
        await client.request("update_user", {
          userId: await userId(client, username),
          ...(await patch(...rest)),
        });
        console.log(describe(username));
      });

  user
    .command("set-name <username> <displayName>")
    .description("the name shown for a user; an empty string shows the username again")
    .action(
      updateUser(
        (u) => `Renamed ${u}`,
        (displayName) => ({ displayName }),
      ),
    );
  user
    .command("set-my-name <displayName>")
    .description("the name shown for you; any user may do this")
    .action((displayName: string) =>
      run(async (client) => {
        const me = (await client.request("update_me", { displayName })) as Row;
        console.log(`You are now shown as ${String(me.displayName || me.username)}`);
      }),
    );
  user.command("set-role <username> <role>").action(
    updateUser(
      (u) => `Updated ${u}`,
      (role) => ({ role }),
    ),
  );
  user.command("disable <username>").action(
    updateUser(
      (u) => `Disabled ${u}`,
      () => ({ disabled: true }),
    ),
  );
  user.command("enable <username>").action(
    updateUser(
      (u) => `Enabled ${u}`,
      () => ({ disabled: false }),
    ),
  );
  user
    .command("reset-password <username>")
    .description(
      "prompts for the new password (or reads $CASITA_PASSWORD); ends the user's sessions and tokens",
    )
    .action(
      updateUser(
        (u) => `Password reset for ${u}`,
        async () => ({ password: await newPassword() }),
      ),
    );
  user.command("rm <username>").action((username) =>
    run(async (client) => {
      await client.request("delete_user", { userId: await userId(client, username) });
      console.log(`Removed ${username}`);
    }),
  );

  const grant = program.command("grant").description("manage permission grants (admin)");

  grant
    .command("list")
    .option("--user <username>")
    .option("--role <role>")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const filter = opts.user
          ? { subjectKind: "user" as const, subjectId: await userId(client, opts.user) }
          : opts.role
            ? { subjectKind: "role" as const, subjectId: opts.role as string }
            : {};
        const grants = (await client.request("list_grants", filter)) as Row[];
        const rows = grants.map((g) => ({
          ...g,
          subject: `${g.subjectKind}:${g.subjectId}`,
          scope: `${g.scopeKind}:${g.scopeId}`,
        }));
        print(opts.json, grants, () => table(rows, ["id", "subject", "scope", "level"]));
      }),
    );

  grant
    .command("set <subject> <scope> <level>")
    .description(
      "subject: a username or role:<name>; scope: entity:<id>, area:<id>, or domain:<name>",
    )
    .action((subject: string, scope: string, level) =>
      run(async (client) => {
        const colon = scope.indexOf(":");
        if (colon < 1)
          throw new UsageError("Scope must be entity:<id>, area:<id>, or domain:<name>");
        const isRole = subject.startsWith("role:");
        const created = (await client.request("set_grant", {
          subjectKind: isRole ? "role" : "user",
          subjectId: isRole
            ? subject.slice(5)
            : await userId(client, subject.replace(/^user:/, "")),
          scopeKind: scope.slice(0, colon) as never,
          scopeId: scope.slice(colon + 1),
          level,
        })) as Row;
        console.log(`Grant ${created.id}: ${subject} has ${level} on ${scope}`);
      }),
    );

  grant.command("rm <grantId>").action((grantId) =>
    run(async (client) => {
      await client.request("delete_grant", { grantId });
      console.log(`Removed grant ${grantId}`);
    }),
  );

  const token = program.command("token").description("API tokens for scripts and the CLI");

  token
    .command("create")
    .requiredOption("--name <name>")
    .action((opts) =>
      run(async (client) => {
        const created = (await client.request("create_token", { name: opts.name })) as Row;
        console.error(`Token ${created.id} created. It is shown only once:`);
        console.log(created.token);
      }),
    );

  token
    .command("list")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const tokens = (await client.request("list_tokens", {})) as Row[];
        const rows = tokens.map((t) => ({
          ...t,
          created: time(t.createdAt),
          lastUsed: time(t.lastUsedAt),
        }));
        print(opts.json, tokens, () => table(rows, ["id", "name", "created", "lastUsed"]));
      }),
    );

  token.command("revoke <tokenId>").action((tokenId) =>
    run(async (client) => {
      await client.request("revoke_token", { tokenId });
      console.log(`Revoked ${tokenId}`);
    }),
  );

  program
    .command("audit")
    .description("the audit log (admin)")
    .option("--since <when>", "24h, 7d, or an ISO date")
    .option("--json")
    .action((opts) =>
      run(async (client) => {
        const since = opts.since ? parseSince(opts.since) : undefined;
        const entries = (await client.request("get_audit", { since })) as Row[];
        const rows = entries.map((e) => ({
          ...e,
          at: time(e.at),
          detail: e.detail ? JSON.stringify(e.detail) : "",
        }));
        print(opts.json, entries, () =>
          table(rows, ["at", "action", "actorUserId", "target", "ip", "detail"]),
        );
      }),
    );

  registerOneShot(program, { run, resolveEntityId });

  program
    .command("dash")
    .description("a live dashboard of the house; needs a terminal, or use --once for one frame")
    .option("--once", "print one frame and exit")
    .option("--width <columns>", "frame width when not on a terminal")
    .option("--no-mouse", "leave the mouse to the terminal, for selecting and copying text")
    .option(
      "--theme <theme>",
      "dark, light, or ansi (default: ask the terminal, else $CASITA_THEME)",
    )
    .action((opts) => {
      if (shared) return console.error("Leave the REPL to open the dashboard.");
      if (opts.theme && !["dark", "light", "ansi"].includes(opts.theme)) {
        throw new UsageError("--theme is dark, light, or ansi");
      }
      return run((client) =>
        runDash(client, {
          once: opts.once,
          width: opts.width ? Number(opts.width) : undefined,
          theme: opts.theme,
          mouse: opts.mouse,
        }),
      );
    });

  program
    .command("repl")
    .description("interactive mode: one connection, the same commands without the casita prefix")
    .action(() => {
      if (shared) return console.error("Already in the REPL.");
      return run(repl);
    });
}

/** `"state light.desk --json"` → its arguments, honoring single and double quotes. */
function splitArgs(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

async function repl(client: CasitaClient): Promise<void> {
  shared = client;
  const entityIds = ((await client.request("get_entities", {})) as Row[]).map((e) => String(e.id));
  const commands = program.commands.map((c) => c.name()).filter((name) => name !== "repl");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "casita> ",
    // The first word completes to a command, later words to entity ids.
    completer: (line: string) => {
      const word = line.split(/\s+/).at(-1) ?? "";
      const pool = /\s/.test(line) ? entityIds : [...commands, "exit"];
      return [pool.filter((candidate) => candidate.startsWith(word)), word];
    },
  });
  // With piped input the stream can end before the last command has run.
  let ended = false;
  rl.once("close", () => {
    ended = true;
  });
  const prompt = () => {
    if (!ended) rl.prompt();
  };
  prompt();
  for await (const line of rl) {
    const args = splitArgs(line);
    if (args[0] === "exit" || args[0] === "quit") break;
    if (args.length > 0) {
      // A fresh program per line, so one command's options do not leak into the next.
      program = createProgram(true);
      register(program);
      try {
        await program.parseAsync(args, { from: "user" });
      } catch (err) {
        if (!(err instanceof CommanderError)) fail(err);
      }
      process.exitCode = 0;
    }
    if (client.closed) {
      rl.close();
      shared = undefined;
      throw new CasitaError("connection", "Connection closed");
    }
    prompt();
  }
  rl.close();
  shared = undefined;
}

register(program);

// Without knowing the terminal's background, stay with its own colors, which any theme
// keeps readable. The dashboard asks the terminal and refines this.
setTheme(themeFromEnv() ?? "ansi");

try {
  await program.parseAsync();
} catch (err) {
  fail(err);
}
