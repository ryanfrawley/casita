// A test-only integration whose one device has settings, kept in memory: a device that obeys
// a change a moment later, as a real one reports back. A second device has none.

import { z } from "zod";
import type { DeviceSetting, SettingValue } from "../../packages/core/src/types.ts";
import { defineIntegration } from "../../packages/core/src/types.ts";

export default defineIntegration({
  id: "dials",
  name: "Dials",
  version: "0",
  configSchema: z.strictObject({}),
  async setup(ctx) {
    const dimmer = ctx.registerDevice({ uniqueId: "dimmer", name: "Hall dimmer" });
    ctx.registerDevice({ uniqueId: "plain", name: "Plain plug" });
    const values = new Map<string, SettingValue>([
      ["min", 1],
      ["type", 0],
      ["smart", false],
      ["neutral", 1],
    ]);
    const describe = (): DeviceSetting[] => [
      {
        key: "min",
        label: "Minimum level",
        type: "number",
        value: values.get("min") ?? null,
        default: 1,
        min: 1,
        max: 54,
      },
      {
        key: "type",
        label: "Switch type",
        type: "enum",
        value: values.get("type") ?? null,
        options: [
          { value: 0, label: "Single pole" },
          { value: 2, label: "Aux switch" },
        ],
      },
      {
        key: "smart",
        label: "Smart bulb mode",
        group: "Bulbs",
        type: "boolean",
        value: values.get("smart") ?? null,
      },
      {
        key: "neutral",
        label: "Neutral",
        type: "enum",
        value: values.get("neutral") ?? null,
        readOnly: true,
        options: [{ value: 1, label: "Present" }],
      },
    ];
    ctx.provideDeviceSettings({
      list: (deviceId) => (deviceId === dimmer.id ? describe() : []),
      async set(_deviceId, key, value) {
        ctx.scheduler.after(5, () => {
          values.set(key, value);
          ctx.settingsChanged(dimmer.id);
        });
      },
    });
  },
});
