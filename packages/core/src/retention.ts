// core/retention.ts
// The retention policy's schema, apart from config.ts so the wire schema can use it in a
// browser: this file must import nothing that needs Bun or Node.

import { z } from "zod";
import type { RetentionPolicy } from "./types.ts";

export const days = z.number().int().positive();

/** Raw retention in days, plus optional rollup tiers with their own windows. */
export const retentionPolicySchema = z.strictObject({
  raw: days,
  minute: days.optional(),
  hour: days.optional(),
  day: days.optional(),
}) satisfies z.ZodType<RetentionPolicy>;
