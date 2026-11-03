// ESPHome devices over their native API. Devices are listed in config, found by mDNS, or both.

import { defineIntegration } from "@casita/core/types";
import { z } from "zod";
import { DEFAULT_TIMING, Device, type Timing } from "./device.ts";
import { type Browse, browse as mdnsBrowse } from "./mdns.ts";

const encryptionKey = z
  .string()
  .refine((key) => Buffer.from(key, "base64").length === 32, "Must be the base64 of 32 bytes");

const deviceSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(6053),
  /** The device's `api: encryption: key:`. Without it the connection is plaintext. */
  encryptionKey: encryptionKey.optional(),
  /** Legacy API password. */
  password: z.string().optional(),
});

const configSchema = z.strictObject({
  devices: z.array(deviceSchema).default([]),
  /** Also connect to devices announced over mDNS (`_esphomelib._tcp`). */
  discover: z.boolean().default(false),
  /** Used for discovered devices, which have no entry of their own. */
  encryptionKey: encryptionKey.optional(),
  password: z.string().optional(),
});

export interface EsphomeOptions {
  timing?: Timing;
  browse?: Browse;
}

/** Timing and mDNS browsing are injectable for tests. */
export const createEsphomeIntegration = (options: EsphomeOptions = {}) =>
  defineIntegration({
    id: "esphome",
    name: "ESPHome",
    version: "0.1.0",
    configSchema,
    async setup(ctx) {
      const timing = options.timing ?? DEFAULT_TIMING;
      const known = new Set<string>();
      const add = (device: z.infer<typeof deviceSchema>) => {
        const address = `${device.host}:${device.port}`;
        if (known.has(address)) return undefined;
        known.add(address);
        return new Device(ctx, device, timing).start();
      };

      // Each device keeps retrying on its own, so one that is asleep does not hold up the rest.
      await Promise.all(ctx.config.devices.map(add));

      if (ctx.config.discover) {
        (options.browse ?? mdnsBrowse)(
          ctx.signal,
          (found) => {
            const { encryptionKey: key, password } = ctx.config;
            void add({ host: found.host, port: found.port, encryptionKey: key, password });
          },
          ctx.log,
        );
      }
    },
  });

export default createEsphomeIntegration();
