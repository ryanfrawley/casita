// Step 12 checks: a slow client is cut off, and the real entrypoint meets the definition of
// done against fakes: all integrations running, live state, confirmed control, clean shutdown.

import { expect, test } from "bun:test";
import net from "node:net";
import { join } from "node:path";
import mqtt from "mqtt";
import { FakeDevice } from "../integrations/esphome/test/fake-device.ts";
import { FakeZwaveServer } from "../integrations/zwave-js/test/fake-server.ts";
import { Broker } from "./broker.ts";
import { BOOTSTRAP_TOKEN, boot } from "./harness.ts";

/** One masked WebSocket text frame, as a client must send it. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)));
  return Buffer.concat([header, mask, masked]);
}

test("a client that stops reading is disconnected instead of buffering without bound", async () => {
  const h = await boot(undefined, undefined, { maxSendBufferBytes: 64 * 1024 });
  try {
    const { port } = new URL(h.url);
    const socket = net.connect(Number(port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.pause(); // from here on, nothing the server sends is read
    socket.write(frame(JSON.stringify({ type: "auth", token: BOOTSTRAP_TOKEN })));

    // Keep asking; the replies pile up on the server until it gives up on this client.
    let done = false;
    void closed.then(() => {
      done = true;
    });
    for (let id = 1; !done && id < 200_000; id++) {
      socket.write(frame(JSON.stringify({ id, type: "get_entities" })));
      if (id % 200 === 0) await Bun.sleep(1);
    }
    await Promise.race([closed, Bun.sleep(5000)]);
    expect(done).toBe(true);
    socket.destroy();

    // Everyone else is unaffected.
    const client = await h.connect();
    expect(await client.request("ping", {})).toEqual({ time: expect.any(Number) });
  } finally {
    await h.stop();
  }
}, 20_000);

test("definition of done: four integrations against fakes, live state, confirmed control, clean shutdown", async () => {
  const broker = await Broker.start();
  const zwave = await FakeZwaveServer.start();
  const esphome = await FakeDevice.start();
  const publisher = await mqtt.connectAsync(broker.url);
  const fixtures = join(import.meta.dir, "fixtures");
  for (const [topic, config] of Object.entries(
    (await Bun.file(join(fixtures, "mqtt", "plug.synthetic.json")).json()) as Record<
      string,
      unknown
    >,
  )) {
    await publisher.publishAsync(topic, JSON.stringify(config), { retain: true });
  }
  await publisher.publishAsync("plugs/plug_1/availability", "online", { retain: true });
  await publisher.publishAsync(
    "plugs/plug_1/state",
    JSON.stringify({ relay: "OFF", meter: { power: 0 } }),
    { retain: true },
  );
  await publisher.publishAsync("zigbee2mqtt/bridge/state", JSON.stringify({ state: "online" }), {
    retain: true,
  });
  await publisher.publishAsync(
    "zigbee2mqtt/bridge/devices",
    await Bun.file(join(fixtures, "zigbee2mqtt", "bridge-devices.synthetic.json")).text(),
    { retain: true },
  );

  const dir = await (await import("node:fs/promises")).mkdtemp(
    join((await import("node:os")).tmpdir(), "casita-dod-"),
  );
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  await Bun.write(
    join(dir, "config.toml"),
    `[server]
port = ${port}
host = "127.0.0.1"
apiToken = "${BOOTSTRAP_TOKEN}"
dbPath = "${join(dir, "home.db")}"

[[integration]]
type = "demo"
intervalMs = 100

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
  const root = join(import.meta.dir, "..");
  const server = Bun.spawn(["bun", "packages/server/src/main.ts"], {
    cwd: root,
    env: { PATH: Bun.env.PATH, CASITA_CONFIG: join(dir, "config.toml"), LOG_LEVEL: "warn" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const env = {
    PATH: Bun.env.PATH,
    CASITA_URL: `http://127.0.0.1:${port}`,
    CASITA_TOKEN: BOOTSTRAP_TOKEN,
    CASITA_CREDENTIALS: join(dir, "none"),
  };
  const casita = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
      code: await proc.exited,
    };
  };

  try {
    // Boot: every integration reaches "running".
    type Health = { integrations: { integrationId: string; status: string }[] };
    let health: Health = { integrations: [] };
    for (let i = 0; i < 200; i++) {
      health = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.json() as Promise<Health>,
        () => health,
      );
      if (
        health.integrations.length === 5 &&
        health.integrations.every((s) => s.status === "running")
      )
        break;
      await Bun.sleep(50);
    }
    expect(health.integrations.map((s) => `${s.integrationId}:${s.status}`).sort()).toEqual([
      "demo.main:running",
      "esphome.main:running",
      "mqtt.main:running",
      "zigbee2mqtt.main:running",
      "zwave-js.main:running",
    ]);
    const status = await casita("status");
    expect(status.stdout).toMatch(/entities +\d\d/);

    // casita watch shows live state.
    const watch = Bun.spawn(
      ["bun", "packages/cli/src/main.ts", "watch", "sensor.demo_temperature"],
      { cwd: root, env, stdout: "pipe" },
    );
    let seen = "";
    const reading = (async () => {
      for await (const chunk of watch.stdout) seen += new TextDecoder().decode(chunk);
    })();
    for (let i = 0; i < 100 && !seen.includes("\n"); i++) await Bun.sleep(50);
    watch.kill("SIGINT");
    await reading;
    expect(seen).toMatch(/sensor\.demo_temperature {2}[\d.]+ °C/);

    // casita cmd controls an entity with --confirm, on a simulated device of each transport that echoes.
    for (const entity of ["light.demo_light", "switch.garage_relay", "switch.porch_plug"]) {
      const result = await casita("cmd", entity, "turn_on", "--confirm");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("confirmed");
    }

    // Steady-state memory with everything loaded (the budget is 200 MB).
    const rss = Number(
      (
        await new Response(Bun.spawn(["ps", "-o", "rss=", "-p", String(server.pid)]).stdout).text()
      ).trim(),
    );
    expect(rss).toBeGreaterThan(0);
    expect(rss / 1024).toBeLessThan(200);

    // SIGTERM: clean exit, well inside five seconds.
    const started = Date.now();
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await new Response(server.stderr).text()).toBe("");
  } finally {
    server.kill("SIGKILL");
    await publisher.endAsync(true);
    esphome.stop();
    zwave.stop();
    await broker.stop();
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
}, 30_000);
