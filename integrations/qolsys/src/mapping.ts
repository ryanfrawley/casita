// The panel's zone and partition records, and what they mean as entities.

import type { BinarySensorState } from "@casita/core/types";
import { z } from "zod";

export const zone = z.looseObject({
  zone_id: z.number().int(),
  id: z.string().optional(),
  name: z.string().default(""),
  type: z.string().default(""),
  group: z.string().default(""),
  status: z.string().default(""),
  partition_id: z.number().int().default(0),
});
export type Zone = z.infer<typeof zone>;

/** A ZONE_UPDATE names only what changed, so nothing in it is defaulted. */
export const zonePatch = z.looseObject({
  zone_id: z.number().int(),
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  group: z.string().optional(),
  status: z.string().optional(),
  partition_id: z.number().int().optional(),
});

export const partition = z.looseObject({
  partition_id: z.number().int(),
  name: z.string().default(""),
  status: z.string().default("DISARM"),
  zone_list: z.array(z.unknown()).default([]),
});
export type Partition = z.infer<typeof partition>;

export const summary = z.looseObject({
  event: z.literal("INFO"),
  info_type: z.literal("SUMMARY"),
  partition_list: z.array(z.unknown()).default([]),
});

export const zoneEvent = z.looseObject({
  event: z.literal("ZONE_EVENT"),
  zone_event_type: z.string(),
  // ZONE_ACTIVE carries only the id and status; ZONE_UPDATE and ZONE_ADD the whole zone.
  zone: z.looseObject({ zone_id: z.number().int(), status: z.string().optional() }),
});

export const armingEvent = z.looseObject({
  event: z.literal("ARMING"),
  arming_type: z.string(),
  partition_id: z.number().int().default(0),
  delay: z.number().optional(),
});

export const alarmEvent = z.looseObject({
  event: z.literal("ALARM"),
  alarm_type: z.string().default(""),
  partition_id: z.number().int().default(0),
});

export const errorEvent = z.looseObject({
  event: z.literal("ERROR"),
  error_type: z.string().default(""),
  description: z.string().default(""),
  partition_id: z.number().int().default(0),
});

/**
 * Zone types that are the panel's own plumbing, not sensors: the translators that bring
 * hardwired sensors in, keypads, sirens. They get no entity.
 */
export const isPlumbing = (z: Zone): boolean =>
  ["TakeoverModule", "Keypad", "Siren", "Bluetooth"].includes(z.type);

/** A zone's type as the panel names it, to the kind of thing it watches. */
export function zoneDeviceClass(z: Zone): BinarySensorState["deviceClass"] {
  switch (z.type) {
    case "Door_Window":
    case "Tilt":
      // The installer's name says which it is; failing that, entry/exit zones are the doors
      // people use and instant-perimeter zones are the windows.
      if (z.type === "Tilt" || /\bdoor\b/i.test(z.name)) return "door";
      if (/\bwindow\b/i.test(z.name)) return "window";
      return /entryexit/i.test(z.group) ? "door" : "window";
    case "Motion":
    case "Occupancy Sensor":
      return "motion";
    case "SmokeDetector":
    case "Smoke_M":
    case "Heat":
      return "smoke";
    case "Water":
      return "leak";
    default:
      return undefined;
  }
}

/** Open doors, tripped motions and activated detectors all read `on`. */
export const zoneOn = (status: string): boolean => /^(open|active|activated)$/i.test(status);

export const zoneState = (z: Zone): BinarySensorState => {
  const deviceClass = zoneDeviceClass(z);
  return { domain: "binary_sensor", on: zoneOn(z.status), ...(deviceClass ? { deviceClass } : {}) };
};

/**
 * The panel's partition status, normalized. Firmware differs on the spelling of the delays:
 * older panels send `EXIT_DELAY` without saying which mode is coming, newer ones
 * `ARM-AWAY-EXIT-DELAY`.
 */
export type ArmMode = "stay" | "away";
export type PanelStatus =
  | { kind: "disarmed" }
  | { kind: "armed"; mode: ArmMode }
  | { kind: "arming"; mode?: ArmMode }
  | { kind: "entry_delay" }
  | { kind: "alarm"; alarmType?: string };

export function parseStatus(raw: string): PanelStatus {
  const status = raw.toUpperCase().replace(/-/g, "_");
  switch (status) {
    case "DISARM":
    case "DISARMED":
      return { kind: "disarmed" };
    case "ARM_STAY":
      return { kind: "armed", mode: "stay" };
    case "ARM_AWAY":
      return { kind: "armed", mode: "away" };
    case "ARM_STAY_EXIT_DELAY":
      return { kind: "arming", mode: "stay" };
    case "ARM_AWAY_EXIT_DELAY":
      return { kind: "arming", mode: "away" };
    case "EXIT_DELAY":
      return { kind: "arming" };
    case "ENTRY_DELAY":
      return { kind: "entry_delay" };
    case "ALARM":
      return { kind: "alarm" };
    default:
      return { kind: "disarmed" };
  }
}

/** The word the status sensor shows for a partition. */
export const statusValue = (s: PanelStatus): string => {
  switch (s.kind) {
    case "armed":
      return `armed_${s.mode}`;
    default:
      return s.kind;
  }
};

/** Whether the "Armed stay" / "Armed away" switch for `mode` reads on. Arming counts: the exit delay is already underway. */
export const armedAs = (s: PanelStatus, mode: ArmMode): boolean =>
  (s.kind === "armed" || s.kind === "arming") && s.mode === mode;
