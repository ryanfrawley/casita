// A test-only integration with one entity per behavior the API tests need.

import { z } from "zod";
import { defineIntegration } from "../../packages/core/src/types.ts";

export default defineIntegration({
  id: "fixture",
  name: "Test fixture",
  version: "0",
  configSchema: z.strictObject({ label: z.string().default("") }),
  async setup(ctx) {
    const device = ctx.registerDevice({
      uniqueId: "hub",
      name: "Fixture hub",
      manufacturer: "casita",
      model: "Fixture",
    });

    let on = false;
    let brightness = 1;
    const light = ctx.registerEntity(
      {
        uniqueId: "light",
        domain: "light",
        name: "Desk",
        deviceId: device.id,
        capabilities: { brightness: true },
      },
      async (command) => {
        on = command.action === "turn_on";
        if (command.action === "turn_on" && command.brightness !== undefined)
          brightness = command.brightness;
        ctx.reportState(light.id, { domain: "light", on, brightness });
      },
    );
    ctx.reportState(light.id, { domain: "light", on, brightness }, { label: ctx.config.label });

    const lock = ctx.registerEntity(
      { uniqueId: "lock", domain: "lock", name: "Front door", deviceId: device.id },
      async (command) => {
        ctx.reportState(lock.id, { domain: "lock", locked: command.action === "lock" });
      },
    );
    ctx.reportState(lock.id, { domain: "lock", locked: true });

    const sensor = ctx.registerEntity({
      uniqueId: "temp",
      domain: "sensor",
      name: "Porch temperature",
    });
    ctx.reportState(sensor.id, {
      domain: "sensor",
      value: 20,
      unit: "°C",
      deviceClass: "temperature",
    });

    // Accepts the command but the device never reports back.
    const mute = ctx.registerEntity(
      { uniqueId: "mute", domain: "switch", name: "Mute" },
      async () => {},
    );
    ctx.reportState(mute.id, { domain: "switch", on: false });

    ctx.registerAction(
      "set_temperature",
      z.strictObject({ value: z.number() }),
      async ({ value }) => {
        ctx.reportState(sensor.id, {
          domain: "sensor",
          value,
          unit: "°C",
          deviceClass: "temperature",
        });
        return { value };
      },
    );
  },
});
