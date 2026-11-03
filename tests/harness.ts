// Boots the real server on a free port against a temp directory, and drives it the way a
// user would: over the WebSocket API or through the `casita` CLI.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventMessage, SnapshotMessage } from "../packages/client/src/client.ts";
import { CasitaClient } from "../packages/client/src/client.ts";
import type { IntegrationCatalog } from "../packages/core/src/config.ts";
import { type App, createApp } from "../packages/server/src/app.ts";
import fixture from "./fixtures/devices.ts";

export const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests";
const CLI = join(import.meta.dir, "..", "packages", "cli", "src", "main.ts");

export const DEFAULT_CONFIG = `
[server]
apiToken = "${BOOTSTRAP_TOKEN}"

[[integration]]
type = "fixture"
`;

export interface Harness {
  url: string;
  dir: string;
  dbPath: string;
  configPath: string;
  /** A client authenticated with `token`. Closed automatically on stop. */
  connect(token?: string): Promise<CasitaClient>;
  login(username: string, password: string): Promise<Response>;
  /** Runs `casita` with the given arguments as a subprocess. */
  cli(
    args: string[],
    env?: Record<string, string>,
    stdin?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Stops the server and starts it again on the same database and config. */
  restart(config?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function boot(
  config = DEFAULT_CONFIG,
  integrations: IntegrationCatalog = new Map([[fixture.id, fixture]]),
  options: {
    loginRateLimit?: number;
    maxSendBufferBytes?: number;
    confirmTimeoutMs?: number;
    /** A directory to serve as the web app; by default the server answers only the API. */
    webDir?: string;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "casita-test-"));
  const configPath = join(dir, "config.toml");
  const dbPath = join(dir, "home.db");
  await Bun.write(configPath, config);
  const clients = new Set<CasitaClient>();
  let app: App;
  const start = async () => {
    app = await createApp({
      configPath,
      dbPath,
      integrations,
      loginRateLimit: options.loginRateLimit,
      maxSendBufferBytes: options.maxSendBufferBytes,
      confirmTimeoutMs: options.confirmTimeoutMs,
      webDir: options.webDir ?? false,
      port: 0,
      logLevel: "silent",
    });
    harness.url = `http://127.0.0.1:${app.port}`;
  };

  const harness: Harness = {
    url: "",
    dir,
    dbPath,
    configPath,
    async connect(token = BOOTSTRAP_TOKEN) {
      const client = await CasitaClient.connect(harness.url, token);
      clients.add(client);
      return client;
    },
    login: (username, password) =>
      fetch(`${harness.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    async cli(args, env = {}, stdin) {
      const proc = Bun.spawn(["bun", CLI, ...args], {
        env: {
          PATH: Bun.env.PATH,
          HOME: dir,
          CASITA_URL: harness.url,
          CASITA_TOKEN: BOOTSTRAP_TOKEN,
          CASITA_CREDENTIALS: join(dir, "credentials"),
          ...env,
        },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
    async restart(next) {
      for (const client of clients) client.close();
      clients.clear();
      await app.stop();
      if (next !== undefined) await Bun.write(configPath, next);
      await start();
    },
    async stop() {
      for (const client of clients) client.close();
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
  await start();
  return harness;
}

/** Collects what a client is pushed, with a way to wait for the next matching event. */
export function record(client: CasitaClient) {
  const events: EventMessage["event"][] = [];
  const snapshots: SnapshotMessage[] = [];
  const waiters = new Set<() => void>();
  client.onEvent((m) => {
    events.push(m.event);
    for (const wake of [...waiters]) wake();
  });
  client.onSnapshot((m) => {
    snapshots.push(m);
    for (const wake of [...waiters]) wake();
  });
  return {
    events,
    snapshots,
    /** Resolves once `predicate` holds, or rejects after `timeoutMs`. */
    until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate()) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`Timed out; saw events: ${events.map((e) => e.type).join(", ") || "none"}`),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}

export const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

/** Creates a user through the API and returns a session token for them. */
export async function addUser(
  h: Harness,
  admin: CasitaClient,
  username: string,
  role: "admin" | "member" | "guest",
) {
  const password = `${username}-password`;
  const user = (await admin.request("create_user", { username, password, role })) as { id: string };
  const { token } = (await (await h.login(username, password)).json()) as { token: string };
  return { id: user.id, token, password };
}
