// Wires core + api + integrations into one running process.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Auth, createApi, OidcProvider, requirePermission } from "@casita/api";
import {
  AutomationStore,
  Bus,
  backupDatabase,
  CommandRouter,
  ConfigStore,
  createLoggerFactory,
  createScheduler,
  type Domain,
  type IntegrationCatalog,
  IntegrationHost,
  type Logger,
  openDatabase,
  PageRuntime,
  PageStore,
  Recorder,
  Registry,
  resolveTimezone,
  SENSOR_INTEGRATION,
  SensorRuntime,
  SensorStore,
  StateStore,
  slugDeviceIds,
  stockHome,
} from "@casita/core";
import { VERSION } from "./version.ts";

export interface AppOptions {
  configPath: string;
  integrations: IntegrationCatalog;
  /** Overrides server.port; 0 picks a free port. */
  port?: number;
  /** Overrides server.dbPath. */
  dbPath?: string;
  logLevel?: string;
  /** How long a command waits for the device to confirm (default 5 s). */
  confirmTimeoutMs?: number;
  /** Per-domain confirm timeouts; covers default to 10 s because garage openers warn ~5 s before moving. */
  confirmTimeoutsMs?: Partial<Record<Domain, number>>;
  /** A client with more unsent data than this is disconnected (default 4 MB). */
  maxSendBufferBytes?: number;
  /** Login attempts allowed per IP per minute (default 5). */
  loginRateLimit?: number;
  /** The built web app; defaults to packages/web/dist. `false` serves none, whatever the config says. */
  webDir?: string | false;
}

export interface App {
  readonly port: number;
  readonly router: CommandRouter;
  /** Aborts every integration, flushes SQLite, and stops listening. */
  stop(): Promise<void>;
}

const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

/** Where the web app is served from, or undefined when it is turned off or has not been built. */
async function webDir(
  option: string | false | undefined,
  enabled: boolean,
  log: Logger,
): Promise<string | undefined> {
  if (option === false || !enabled) return undefined;
  const dir = option ?? WEB_DIST;
  if (await Bun.file(join(dir, "index.html")).exists()) return dir;
  log.warn("web app not built; serving the API only", { dir, hint: "bun run web:build" });
  return undefined;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const logFor = createLoggerFactory(opts.logLevel);
  const log = logFor({ service: "server" });
  const bus = new Bus(logFor({ service: "bus" }));

  const config = await ConfigStore.load(opts.configPath, opts.integrations, bus);
  const timezone = resolveTimezone(config.server.timezone);
  log.info("starting", { version: VERSION, timezone, config: opts.configPath });

  const dbPath = opts.dbPath ?? config.server.dbPath;
  if (dbPath !== ":memory:") await mkdir(dirname(dbPath), { recursive: true });
  const db = await openDatabase(dbPath);
  // Devices made before ids were slugs get one now, and the pages that named them follow.
  const slugged = slugDeviceIds(db);
  if (slugged.length) {
    log.info("device ids are slugs now", {
      devices: Object.fromEntries(slugged.map((c) => [c.from, c.to])),
    });
  }

  const registry = new Registry({ db, bus });
  const states = new StateStore({ db, registry, bus });
  states.restore();
  const router = new CommandRouter({
    registry,
    states,
    bus,
    confirmTimeoutMs: opts.confirmTimeoutMs,
    confirmTimeoutsMs: opts.confirmTimeoutsMs,
  });

  // Core jobs (rollups, retention) run on a scheduler that lives as long as the app.
  const lifetime = new AbortController();
  const recorder = new Recorder({
    db,
    bus,
    registry,
    history: () => config.server.history,
    log: logFor({ service: "recorder" }),
  });
  recorder.start(createScheduler(lifetime.signal, timezone, logFor({ service: "scheduler" })));

  const auth = new Auth({ db, bootstrapToken: config.server.apiToken });
  if (auth.bootstrapTokenIsStale()) {
    log.warn("server.apiToken is ignored now that users exist; remove it from config.toml");
  }
  // Must stay the first policy: nothing else runs for a command the user may not issue.
  router.use(requirePermission(auth, registry));

  const host = new IntegrationHost({
    db,
    bus,
    registry,
    states,
    router,
    config,
    integrations: opts.integrations,
    logFor,
    timezone,
    alwaysLoaded: [SENSOR_INTEGRATION],
  });
  // The Casa pages and automations: compiled against the house as it is at each save.
  const casaRegistry = () => ({
    entities: registry.listEntities().map((e) => ({ id: e.id, domain: e.domain, name: e.name })),
    areas: registry.listAreas().map((a) => ({ id: a.id, name: a.name })),
    devices: registry.listDevices().map((d) => ({ id: d.id, name: d.name })),
    integrations: host.runnable(),
  });
  const pages = new PageStore({ db, bus, registry: casaRegistry });
  const automations = new AutomationStore({ db, bus, registry: casaRegistry });
  const sensors = new SensorStore({ db, bus, registry: casaRegistry });
  // A new house gets the stock Home once; from then on the page is the admin's to edit.
  if (pages.ensure("home", stockHome)) log.info("wrote the stock Home page");
  // A page keeps what it compiled to; after an upgrade of the compiler, that is brought up to date.
  const refreshed = pages.refresh();
  if (refreshed.refreshed.length) log.info("recompiled pages", { pages: refreshed.refreshed });
  for (const { id, message } of refreshed.failed) {
    log.warn("a stored page no longer compiles; it is left as it was", { page: id, message });
  }
  const refreshedAutomations = automations.refresh();
  if (refreshedAutomations.refreshed.length) {
    log.info("recompiled automations", { automations: refreshedAutomations.refreshed });
  }
  for (const { id, message } of refreshedAutomations.failed) {
    log.warn("a stored automation no longer compiles; it is left as it was", {
      automation: id,
      message,
    });
  }
  const refreshedSensors = sensors.refresh();
  if (refreshedSensors.refreshed.length) {
    log.info("recompiled sensors", { sensors: refreshedSensors.refreshed });
  }
  for (const { id, message } of refreshedSensors.failed) {
    log.warn("a stored sensor no longer compiles; it is left as it was", { sensor: id, message });
  }
  const sensorRuntime = new SensorRuntime({
    sensors,
    bus,
    states,
    registry,
    logFor,
    timezone,
  });
  const pageRuntime = new PageRuntime({
    pages,
    automations,
    integrations: host,
    bus,
    states,
    registry,
    router,
    logFor,
    timezone,
  });

  const api = createApi({
    bus,
    registry,
    states,
    router,
    host,
    config,
    auth,
    recorder,
    automations,
    sensors,
    pages,
    runtime: pageRuntime,
    sensorRuntime,
    oidc: new Map(
      config.auth.oidc.map((o) => [
        o.name,
        { provider: new OidcProvider(o), defaultRole: o.defaultRole },
      ]),
    ),
    backup: () => backupDatabase(db, dbPath === ":memory:" ? "." : dirname(dbPath)),
    log: logFor({ service: "api" }),
    version: VERSION,
    hostname: config.server.host,
    port: opts.port ?? config.server.port,
    loginRateLimit: opts.loginRateLimit,
    maxSendBufferBytes: opts.maxSendBufferBytes,
    webDir: await webDir(opts.webDir, config.server.web, logFor({ service: "api" })),
  });
  await host.start();
  // After the integrations, so the sensors find their inputs and the handlers their entities
  // on the first run; the sensors first, so a handler may wait on one.
  sensorRuntime.start();
  pageRuntime.start();

  return {
    port: api.port,
    router,
    async stop() {
      await api.stop();
      pageRuntime.stop();
      sensorRuntime.stop();
      await host.stop();
      lifetime.abort();
      recorder.stop(); // flushes pending history before the database closes
      db.close();
      log.info("stopped");
    },
  };
}
