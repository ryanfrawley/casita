import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Bus } from "./bus.ts";
import { ConfigStore, type IntegrationCatalog } from "./config.ts";
import { type CoreEvent, defineIntegration } from "./types.ts";

const mqtt = defineIntegration({
  id: "mqtt",
  name: "MQTT",
  version: "0",
  configSchema: z.strictObject({ brokerUrl: z.url(), clientId: z.string().default("casita") }),
  async setup() {},
});
const catalog: IntegrationCatalog = new Map([["mqtt", mqtt]]);

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "casita-config-"));
  path = join(dir, "config.toml");
});
afterEach(() => rm(dir, { recursive: true }));

async function load(toml?: string) {
  if (toml !== undefined) await Bun.write(path, toml);
  const bus = new Bus();
  const events: CoreEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { config: await ConfigStore.load(path, catalog, bus), events };
}

test("a missing file yields defaults", async () => {
  const { config } = await load();
  expect(config.server).toMatchObject({
    port: 8123,
    dbPath: "data/home.db",
    history: { defaultDays: 30 },
  });
  expect(config.instances()).toEqual([]);
});

test("server and integration blocks are validated and typed", async () => {
  const { config } = await load(`
[server]
port = 9000
timezone = "America/Los_Angeles"

[server.history.domains.lock]
raw = 90

[[integration]]
type = "mqtt"
brokerUrl = "mqtt://localhost:1883"

[[integration]]
type = "mqtt"
name = "garage"
brokerUrl = "mqtt://garage:1883"
clientId = "g"
`);
  expect(config.server.port).toBe(9000);
  expect(config.server.history.domains.lock).toEqual({ raw: 90 });
  expect(config.instances()).toEqual([
    {
      id: "mqtt.main",
      type: "mqtt",
      name: "main",
      config: { brokerUrl: "mqtt://localhost:1883", clientId: "casita" },
    },
    {
      id: "mqtt.garage",
      type: "mqtt",
      name: "garage",
      config: { brokerUrl: "mqtt://garage:1883", clientId: "g" },
    },
  ]);
  expect(config.get("server.port")).toBe(9000);
  expect(config.get("integration.mqtt.garage.clientId")).toBe("g");
  expect(config.get("server.nope.deeper")).toBeUndefined();
});

test("an invalid server section is rejected with its path", async () => {
  await expect(load("[server]\nport = 'eighty'")).rejects.toThrow("Invalid config: server.port");
  await expect(load('[server]\ntimezone = "Mars/Olympus"')).rejects.toThrow(
    "server.timezone: Unknown time zone",
  );
  await expect(load("[server]\nbogus = 1")).rejects.toThrow("server");
  await expect(load("not toml =")).rejects.toThrow("config.toml");
});

test("a bad integration block loads with an error instead of failing startup", async () => {
  const { config } = await load(`
[[integration]]
type = "mqtt"
brokerUrl = 12

[[integration]]
type = "zigbee"

[[integration]]
type = "mqtt"
brokerUrl = "mqtt://dup:1883"
`);
  expect(config.instances().map((i) => i.error)).toEqual([
    expect.stringContaining("integration.mqtt.main.brokerUrl"),
    'integration.zigbee.main: unknown integration "zigbee"',
    "integration.mqtt.main: duplicate instance",
  ]);
});

test("set validates, rewrites the file atomically, and emits config_changed", async () => {
  const { config, events } = await load(
    '[server]\nport = 9000\n\n[[integration]]\ntype = "mqtt"\nbrokerUrl = "mqtt://a:1883"\n',
  );
  await config.set("server.port", 9001);
  await config.set("server.history.domains.lock", { raw: 90 });
  await config.set("integration.mqtt.main.brokerUrl", "mqtt://b:1883");
  expect(events).toEqual([
    { type: "config_changed", path: "server.port" },
    { type: "config_changed", path: "server.history.domains.lock" },
    { type: "config_changed", path: "integration.mqtt.main.brokerUrl" },
  ]);
  expect(await readdir(dir)).toEqual(["config.toml"]); // no temp file left behind

  const reloaded = (await load()).config;
  expect(reloaded.server.port).toBe(9001);
  expect(reloaded.server.history.domains.lock).toEqual({ raw: 90 });
  expect(reloaded.instances()[0]?.config).toMatchObject({ brokerUrl: "mqtt://b:1883" });
});

test("an invalid set changes nothing", async () => {
  const { config, events } = await load(
    '[[integration]]\ntype = "mqtt"\nbrokerUrl = "mqtt://a:1883"\n',
  );
  const before = await Bun.file(path).text();
  await expect(config.set("server.port", "x")).rejects.toThrow("server.port");
  await expect(config.set("integration.mqtt.main.brokerUrl", 5)).rejects.toThrow(
    "integration.mqtt.main.brokerUrl",
  );
  await expect(config.set("integration.mqtt.nope.brokerUrl", "mqtt://b")).rejects.toThrow(
    "No integration instance",
  );
  await Bun.sleep(5);
  expect(await Bun.file(path).text()).toBe(before);
  expect(config.server.port).toBe(8123);
  expect(events).toEqual([]);
});

test("whole integration blocks can be added and removed", async () => {
  const { config } = await load("");
  await config.set("integration.mqtt.attic", { brokerUrl: "mqtt://attic:1883" });
  expect(config.instances().map((i) => i.id)).toEqual(["mqtt.attic"]);
  await config.set("integration.mqtt.attic", null);
  expect(config.instances()).toEqual([]);
  await config.set("server.port", 9000);
  await config.set("server.port", null);
  expect(config.server.port).toBe(8123);
});
