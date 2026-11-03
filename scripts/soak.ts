// Memory soak: runs the real server with all integrations against fakes, keeps state and
// commands flowing, and samples its RSS. The milestone budget is 200 MB after one hour.
//
//   bun scripts/soak.ts [minutes=60]

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt from "mqtt";
import { FakeDevice } from "../integrations/esphome/test/fake-device.ts";
import { FakeZwaveServer } from "../integrations/zwave-js/test/fake-server.ts";
import { CasitaClient } from "../packages/client/src/client.ts";
import { Broker } from "../tests/broker.ts";

const minutes = Number(Bun.argv[2] ?? 60);
const TOKEN = "soak-test-token-0123";
const root = join(import.meta.dir, "..");
const fixtures = join(root, "tests", "fixtures");

const broker = await Broker.start();
const zwave = await FakeZwaveServer.start();
const esphome = await FakeDevice.start();
const publisher = await mqtt.connectAsync(broker.url);
const plug = (await Bun.file(join(fixtures, "mqtt", "plug.synthetic.json")).json()) as Record<
  string,
  unknown
>;
for (const [topic, config] of Object.entries(plug)) {
  await publisher.publishAsync(topic, JSON.stringify(config), { retain: true });
}
await publisher.publishAsync("plugs/plug_1/availability", "online", { retain: true });
await publisher.publishAsync("zigbee2mqtt/bridge/state", JSON.stringify({ state: "online" }), {
  retain: true,
});
await publisher.publishAsync(
  "zigbee2mqtt/bridge/devices",
  await Bun.file(join(fixtures, "zigbee2mqtt", "bridge-devices.synthetic.json")).text(),
  { retain: true },
);

const dir = await mkdtemp(join(tmpdir(), "casita-soak-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
await Bun.write(
  join(dir, "config.toml"),
  `[server]
port = ${port}
host = "127.0.0.1"
apiToken = "${TOKEN}"
dbPath = "${join(dir, "home.db")}"

[[integration]]
type = "demo"
intervalMs = 250

[[integration]]
type = "mqtt"
brokerUrl = "${broker.url}"

[[integration]]
type = "zigbee2mqtt"
brokerUrl = "${broker.url}"

[[integration]]
type = "zwave-js"
serverUrl = "${zwave.url}"

[[integration]]
type = "esphome"

[[integration.devices]]
host = "127.0.0.1"
port = ${esphome.port}
`,
);

const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
  cwd: root,
  env: { PATH: Bun.env.PATH, CASITA_CONFIG: join(dir, "config.toml"), LOG_LEVEL: "warn" },
  stdout: "inherit",
  stderr: "inherit",
});
const rssMb = async () =>
  Number(
    (
      await new Response(Bun.spawn(["ps", "-o", "rss=", "-p", String(server.pid)]).stdout).text()
    ).trim(),
  ) / 1024;

let client: CasitaClient | undefined;
for (let i = 0; i < 100 && !client; i++) {
  client = await CasitaClient.connect(`http://127.0.0.1:${port}`, TOKEN).catch(() => undefined);
  if (!client) await Bun.sleep(100);
}
if (!client) throw new Error("the server did not start");
let events = 0;
client.onEvent(() => events++);
await client.request("subscribe", {});

// Traffic on every transport: device reports and commands, a few per second.
let tick = 0;
const traffic = setInterval(() => {
  tick++;
  const on = tick % 2 === 0;
  void publisher.publishAsync(
    "plugs/plug_1/state",
    JSON.stringify({ relay: on ? "ON" : "OFF", meter: { power: tick % 90 } }),
  );
  void publisher.publishAsync(
    "zigbee2mqtt/Hall bulb",
    JSON.stringify({ state: on ? "ON" : "OFF", brightness: tick % 254, linkquality: tick % 100 }),
  );
  esphome.report({ type: "Sensor", key: 104, state: 15 + (tick % 100) / 10 });
  zwave.valueUpdated(2, { commandClass: 49, property: "Power" }, tick % 500);
  void client
    ?.request("send_command", {
      entityId: "light.demo_light",
      command: { domain: "light", action: on ? "turn_on" : "turn_off" },
    })
    .catch(() => {});
}, 250);

const samples: number[] = [];
const started = Date.now();
console.log(`soaking for ${minutes} min; sampling RSS every 30 s`);
while (Date.now() - started < minutes * 60_000) {
  await Bun.sleep(Math.min(30_000, minutes * 60_000 - (Date.now() - started)));
  const rss = await rssMb();
  samples.push(rss);
  console.log(
    `${((Date.now() - started) / 60_000).toFixed(1).padStart(5)} min  ${rss.toFixed(1)} MB  ${events} events`,
  );
}

clearInterval(traffic);
const stopping = Date.now();
server.kill("SIGTERM");
const code = await server.exited;
console.log(`shutdown: exit ${code} in ${Date.now() - stopping} ms`);
console.log(
  `RSS: first ${samples[0]?.toFixed(1)} MB, last ${samples.at(-1)?.toFixed(1)} MB, max ${Math.max(...samples).toFixed(1)} MB`,
);

client.close();
await publisher.endAsync(true);
esphome.stop();
zwave.stop();
await broker.stop();
await rm(dir, { recursive: true, force: true });
process.exit(Math.max(...samples) < 200 && code === 0 ? 0 : 1);
