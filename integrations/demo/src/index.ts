// A fake light and a drifting temperature sensor, for development and API tests.

import { defineIntegration } from "@casita/core/types";
import { z } from "zod";

const configSchema = z.strictObject({
  /** How often the sensor reports a new value. */
  intervalMs: z.number().int().positive().default(5000),
  /** Simulated delay between a command and the light reporting its new state. */
  latencyMs: z.number().int().nonnegative().default(50),
});

export default defineIntegration({
  id: "demo",
  name: "Demo devices",
  version: "0.1.0",
  configSchema,
  async setup(ctx) {
    const device = ctx.registerDevice({
      uniqueId: "demo-device",
      name: "Demo device",
      manufacturer: "casita",
      model: "Demo",
    });

    let on = false;
    let brightness = 1;
    const light = ctx.registerEntity(
      {
        uniqueId: "demo-light",
        domain: "light",
        name: "Demo light",
        deviceId: device.id,
        capabilities: { brightness: true },
      },
      async (command) => {
        on = command.action === "turn_on";
        if (command.action === "turn_on" && command.brightness !== undefined) {
          brightness = command.brightness;
        }
        ctx.scheduler.after(ctx.config.latencyMs, reportLight);
      },
    );
    const reportLight = () => ctx.reportState(light.id, { domain: "light", on, brightness });
    reportLight();

    let temperature = 21;
    const sensor = ctx.registerEntity({
      uniqueId: "demo-temperature",
      domain: "sensor",
      name: "Demo temperature",
      deviceId: device.id,
    });
    const reportSensor = () => {
      ctx.reportState(
        sensor.id,
        { domain: "sensor", value: temperature, unit: "°C", deviceClass: "temperature" },
        { samples: ++samples },
      );
    };
    let samples = 0;
    reportSensor();
    ctx.scheduler.every(ctx.config.intervalMs, () => {
      temperature = Math.round((temperature + (Math.random() - 0.5)) * 10) / 10;
      reportSensor();
    });

    ctx.registerAction(
      "set_temperature",
      z.strictObject({ value: z.number() }),
      async ({ value }) => {
        temperature = value;
        reportSensor();
        return { value };
      },
    );
  },
});
