// A test-only integration for `casita device set`: two devices whose names share a prefix
// ("Lamp" and "Lamp post"), one that shares nothing, and a few entities to follow them.

import { z } from "zod";
import { defineIntegration } from "../../packages/core/src/types.ts";

export default defineIntegration({
  id: "garden",
  name: "Test garden",
  version: "0",
  configSchema: z.strictObject({}),
  async setup(ctx) {
    const lamp = ctx.registerDevice({ uniqueId: "lamp", name: "Lamp" });
    const post = ctx.registerDevice({ uniqueId: "post", name: "Lamp post" });
    const pump = ctx.registerDevice({ uniqueId: "pump", name: "Pond pump" });

    const entities = [
      {
        uniqueId: "bulb",
        domain: "light",
        name: "Lamp bulb",
        slug: "lamp_bulb",
        deviceId: lamp.id,
      },
      {
        uniqueId: "plug",
        domain: "switch",
        name: "Lamp plug",
        slug: "lamp_plug",
        deviceId: lamp.id,
      },
      { uniqueId: "post", domain: "light", name: "Post light", slug: "post", deviceId: post.id },
      { uniqueId: "pump", domain: "switch", name: "Pump", slug: "pump", deviceId: pump.id },
    ] as const;
    for (const input of entities) {
      const entity = ctx.registerEntity(input);
      ctx.reportState(
        entity.id,
        input.domain === "light" ? { domain: "light", on: false } : { domain: "switch", on: false },
      );
    }
  },
});
