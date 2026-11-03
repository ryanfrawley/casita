// Entrypoint: `bun run start`. Config path from CASITA_CONFIG, else config/config.toml.

import { createCatalog } from "@casita/core";
import demo from "@casita/integration-demo";
import esphome from "@casita/integration-esphome";
import laMarzocco from "@casita/integration-lamarzocco";
import mqtt from "@casita/integration-mqtt";
import openMeteo from "@casita/integration-open-meteo";
import qolsys from "@casita/integration-qolsys";
import rachio from "@casita/integration-rachio";
import tesla from "@casita/integration-tesla";
import teslamate from "@casita/integration-teslamate";
import zigbee2mqtt from "@casita/integration-zigbee2mqtt";
import zwave from "@casita/integration-zwave-js";
import { createApp } from "./app.ts";

const integrations = createCatalog(
  demo,
  mqtt,
  zigbee2mqtt,
  esphome,
  zwave,
  rachio,
  laMarzocco,
  tesla,
  teslamate,
  openMeteo,
  qolsys,
);

/** SIGTERM must end the process within 5 seconds, whatever an integration is doing. */
const SHUTDOWN_DEADLINE_MS = 4500;

const fail = (stage: string, err: unknown) => {
  console.error(
    JSON.stringify({
      level: 60,
      msg: stage,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
};

// An integration's stray rejection is logged, never fatal.
process.on("unhandledRejection", (err) => fail("unhandled rejection", err));

try {
  const app = await createApp({
    configPath: Bun.env.CASITA_CONFIG ?? "config/config.toml",
    integrations,
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    app.stop().then(
      () => process.exit(0),
      (err) => {
        fail("shutdown failed", err);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (err) {
  fail("startup failed", err);
  process.exit(1);
}
