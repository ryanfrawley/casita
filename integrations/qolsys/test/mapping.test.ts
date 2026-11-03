import { expect, test } from "bun:test";
import {
  alarmEvent,
  armedAs,
  armingEvent,
  errorEvent,
  isPlumbing,
  type PanelStatus,
  parseStatus,
  statusValue,
  zone,
  zoneDeviceClass,
  zoneEvent,
  zoneOn,
  zonePatch,
  zoneState,
} from "../src/mapping.ts";

// ───────── parseStatus ─────────

test.each<[string, PanelStatus]>([
  ["DISARM", { kind: "disarmed" }],
  ["DISARMED", { kind: "disarmed" }],
  ["ARM_STAY", { kind: "armed", mode: "stay" }],
  ["ARM-STAY", { kind: "armed", mode: "stay" }],
  ["ARM_AWAY", { kind: "armed", mode: "away" }],
  ["ARM_STAY_EXIT_DELAY", { kind: "arming", mode: "stay" }],
  ["ARM-STAY-EXIT-DELAY", { kind: "arming", mode: "stay" }],
  ["ARM_AWAY_EXIT_DELAY", { kind: "arming", mode: "away" }],
  ["ARM-AWAY-EXIT-DELAY", { kind: "arming", mode: "away" }],
  ["EXIT_DELAY", { kind: "arming" }],
  ["EXIT-DELAY", { kind: "arming" }],
  ["ENTRY_DELAY", { kind: "entry_delay" }],
  ["ENTRY-DELAY", { kind: "entry_delay" }],
  ["ALARM", { kind: "alarm" }],
])("parseStatus(%p)", (raw, expected) => {
  expect(parseStatus(raw)).toEqual(expected);
});

test("parseStatus ignores case", () => {
  expect(parseStatus("arm-away-exit-delay")).toEqual({ kind: "arming", mode: "away" });
  expect(parseStatus("Arm_Stay")).toEqual({ kind: "armed", mode: "stay" });
  expect(parseStatus("disarm")).toEqual({ kind: "disarmed" });
});

test("parseStatus reads an unknown word, or none, as disarmed", () => {
  expect(parseStatus("ARM_NIGHT")).toEqual({ kind: "disarmed" });
  expect(parseStatus("")).toEqual({ kind: "disarmed" });
});

// ───────── statusValue and armedAs ─────────

test.each<[PanelStatus, string]>([
  [{ kind: "disarmed" }, "disarmed"],
  [{ kind: "armed", mode: "stay" }, "armed_stay"],
  [{ kind: "armed", mode: "away" }, "armed_away"],
  [{ kind: "arming", mode: "away" }, "arming"],
  [{ kind: "arming" }, "arming"],
  [{ kind: "entry_delay" }, "entry_delay"],
  [{ kind: "alarm", alarmType: "POLICE" }, "alarm"],
])("statusValue(%p) is %p", (status, expected) => {
  expect(statusValue(status)).toBe(expected);
});

test.each<[PanelStatus, boolean, boolean]>([
  // status, armedAs stay, armedAs away
  [{ kind: "armed", mode: "stay" }, true, false],
  [{ kind: "armed", mode: "away" }, false, true],
  [{ kind: "arming", mode: "stay" }, true, false],
  [{ kind: "arming", mode: "away" }, false, true],
  // An exit delay that doesn't say which mode is coming arms neither switch.
  [{ kind: "arming" }, false, false],
  [{ kind: "entry_delay" }, false, false],
  [{ kind: "alarm" }, false, false],
  [{ kind: "disarmed" }, false, false],
])("armedAs(%p): stay %p, away %p", (status, stay, away) => {
  expect(armedAs(status, "stay")).toBe(stay);
  expect(armedAs(status, "away")).toBe(away);
});

// ───────── zones ─────────

const z = (type: string, group = "", status = "Closed", name = "") =>
  zone.parse({ zone_id: 1, type, group, status, name });

test.each<[string, string, string | undefined]>([
  ["Door_Window", "entryexitdelay", "door"],
  ["Door_Window", "EntryExitLongDelay", "door"],
  ["Door_Window", "instantperimeter", "window"],
  ["Door_Window", "", "window"],
  ["Tilt", "instantperimeter", "door"],
  ["Motion", "awayinstantmotion", "motion"],
  ["Occupancy Sensor", "", "motion"],
  ["SmokeDetector", "", "smoke"],
  ["Smoke_M", "", "smoke"],
  ["Heat", "", "smoke"],
  ["Water", "", "leak"],
  ["GlassBreak", "", undefined],
])("zoneDeviceClass(%p, group %p) is %p", (type, group, expected) => {
  expect(zoneDeviceClass(z(type, group))).toBe(expected as ReturnType<typeof zoneDeviceClass>);
});

// The installer's name wins over the group: a perimeter zone called a door is a door.
test.each<[string, string, string]>([
  ["Living Room Door", "instantperimeter", "door"],
  ["Exterior Garage Door", "instantperimeter", "door"],
  ["Side Window", "entryexitdelay", "window"],
  ["Doorbell Chime", "instantperimeter", "window"], // "door" as a whole word only
])("a Door_Window named %p in group %p is a %p", (name, group, expected) => {
  expect(zoneDeviceClass(z("Door_Window", group, "Closed", name))).toBe(
    expected as ReturnType<typeof zoneDeviceClass>,
  );
});

test.each([
  ["TakeoverModule", true],
  ["Keypad", true],
  ["Siren", true],
  ["Bluetooth", true],
  ["Door_Window", false],
  ["Motion", false],
])("isPlumbing(%p) is %p", (type, expected) => {
  expect(isPlumbing(z(type))).toBe(expected);
});

test("zoneState carries the device class when the type has one", () => {
  expect(zoneState(z("Door_Window", "entryexitdelay", "Open"))).toEqual({
    domain: "binary_sensor",
    on: true,
    deviceClass: "door",
  });
  expect(zoneState(z("Water", "", "Closed"))).toEqual({
    domain: "binary_sensor",
    on: false,
    deviceClass: "leak",
  });
});

test("zoneState for an unclassified type has no deviceClass key at all", () => {
  const state = zoneState(z("GlassBreak", "", "Activated"));
  expect(state).toEqual({ domain: "binary_sensor", on: true });
  expect("deviceClass" in state).toBe(false);
});

test.each<[string, boolean]>([
  ["Open", true],
  ["Active", true],
  ["Activated", true],
  ["OPEN", true],
  ["active", true],
  ["Closed", false],
  ["Idle", false],
  ["Normal", false],
  ["Tampered", false],
  ["", false],
  // Only the whole word counts.
  ["Inactive", false],
  ["Opened", false],
])("zoneOn(%p) is %p", (status, expected) => {
  expect(zoneOn(status)).toBe(expected);
});

// ───────── schemas ─────────

test("zone defaults everything but zone_id and keeps unknown fields", () => {
  expect(zone.parse({ zone_id: 4, zone_alarm_type: 3 })).toEqual({
    zone_id: 4,
    name: "",
    type: "",
    group: "",
    status: "",
    partition_id: 0,
    zone_alarm_type: 3,
  });
});

test("zone rejects a record without an integer zone_id", () => {
  expect(zone.safeParse({ name: "Front door" }).success).toBe(false);
  expect(zone.safeParse({ zone_id: 1.5 }).success).toBe(false);
  expect(zone.safeParse({ zone_id: "1" }).success).toBe(false);
});

test("zonePatch applies no defaults, so a partial update leaves other fields untouched", () => {
  const patch = zonePatch.parse({ zone_id: 4, name: "Back door" });
  expect(patch).toEqual({ zone_id: 4, name: "Back door" });
  for (const key of ["type", "group", "status", "partition_id", "id"]) {
    expect(key in patch).toBe(false);
  }
});

test("zonePatch still requires zone_id", () => {
  expect(zonePatch.safeParse({ status: "Open" }).success).toBe(false);
});

test("zoneEvent accepts a minimal ZONE_ACTIVE carrying only the id and status", () => {
  const event = zoneEvent.parse({
    event: "ZONE_EVENT",
    zone_event_type: "ZONE_ACTIVE",
    version: 1,
    zone: { zone_id: 3, status: "Open" },
  });
  expect(event.zone).toEqual({ zone_id: 3, status: "Open" });
  expect(event.zone_event_type).toBe("ZONE_ACTIVE");
});

test("zoneEvent accepts a zone without a status and rejects another event", () => {
  expect(
    zoneEvent.safeParse({ event: "ZONE_EVENT", zone_event_type: "ZONE_ADD", zone: { zone_id: 1 } })
      .success,
  ).toBe(true);
  expect(
    zoneEvent.safeParse({ event: "ARMING", zone_event_type: "ZONE_ACTIVE", zone: { zone_id: 1 } })
      .success,
  ).toBe(false);
});

test("armingEvent defaults partition_id and leaves delay absent unless sent", () => {
  const event = armingEvent.parse({ event: "ARMING", arming_type: "ARM-AWAY-EXIT-DELAY" });
  expect(event.partition_id).toBe(0);
  expect(event.delay).toBeUndefined();
  expect(
    armingEvent.parse({ event: "ARMING", arming_type: "EXIT_DELAY", partition_id: 1, delay: 60 }),
  ).toMatchObject({ partition_id: 1, delay: 60 });
  expect(armingEvent.safeParse({ event: "ARMING" }).success).toBe(false);
});

test("alarmEvent defaults alarm_type and partition_id", () => {
  expect(alarmEvent.parse({ event: "ALARM" })).toEqual({
    event: "ALARM",
    alarm_type: "",
    partition_id: 0,
  });
  expect(alarmEvent.parse({ event: "ALARM", alarm_type: "FIRE", partition_id: 2 })).toMatchObject({
    alarm_type: "FIRE",
    partition_id: 2,
  });
  expect(alarmEvent.safeParse({ event: "ARMING" }).success).toBe(false);
});

test("errorEvent defaults error_type, description and partition_id", () => {
  expect(errorEvent.parse({ event: "ERROR" })).toEqual({
    event: "ERROR",
    error_type: "",
    description: "",
    partition_id: 0,
  });
  expect(
    errorEvent.parse({ event: "ERROR", error_type: "usercode", description: "Invalid usercode" }),
  ).toMatchObject({ error_type: "usercode", description: "Invalid usercode" });
  expect(errorEvent.safeParse({ event: "ALARM" }).success).toBe(false);
});
