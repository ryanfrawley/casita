import { afterEach, expect, test } from "bun:test";
import { createTestContext, type TestContext } from "@casita/integration-testing";
import type { Fetch } from "../src/api.ts";
import { createRachioIntegration, nextRun, pollInterval } from "../src/index.ts";
import { FakeRachio } from "./fake-cloud.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(
  config: Record<string, unknown> = {},
  prepare: (cloud: FakeRachio) => void = () => {},
  /** Wraps the fake's fetch, to fail or alter chosen requests. */
  wrap: (fetch: Fetch) => Fetch = (fetch) => fetch,
) {
  const cloud = await FakeRachio.create();
  prepare(cloud);
  const integration = createRachioIntegration({
    fetch: wrap(cloud.fetch),
    now: () => 2_000_000,
    settleMs: 5,
  });
  const t = createTestContext(
    integration.configSchema.parse({ apiKey: "good-key", pollSeconds: 15, ...config }),
  );
  cleanups.push(() => t.abort());
  await integration.setup(t.ctx);
  return { cloud, t, integration };
}

async function until(done: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}
const on = (t: TestContext<unknown>, uniqueId: string) =>
  (t.state(uniqueId)?.state as { on?: boolean } | undefined)?.on;

test("discovers the controller and its enabled zones, in zone order", async () => {
  const { t } = await setup();
  expect([...t.devices.values()]).toMatchObject([
    { uniqueId: "dev-1", name: "Backyard", manufacturer: "Rachio", model: "GENERATION3_8ZONE" },
  ]);
  expect<string[][]>([...t.entities.values()].map((e) => [e.id, e.uniqueId])).toEqual([
    ["switch.backyard_lawn", "zone-1"],
    ["switch.backyard_roses", "zone-2"],
    ["switch.backyard_schedules", "dev-1-enabled"],
    ["binary_sensor.backyard_rain_delay", "dev-1-rain-delay"],
    ["binary_sensor.backyard_rain_sensor", "dev-1-rain-sensor"],
    ["sensor.backyard_next_run", "dev-1-next-run"],
  ]);
});

test("reports state from the first poll: idle zones, schedules enabled, no rain delay", async () => {
  const { t, cloud } = await setup();
  expect([
    on(t, "zone-1"),
    on(t, "zone-2"),
    on(t, "dev-1-enabled"),
    on(t, "dev-1-rain-delay"),
  ]).toEqual([false, false, true, false]);
  expect(cloud.calls()).toEqual([
    "GET /person/info",
    "GET /person/person-1",
    "GET /device/dev-1/current_schedule",
  ]);
});

test("a zone that is already running is reported on, with when it ends", async () => {
  const { t } = await setup({}, (cloud) => {
    cloud.running = { zoneId: "zone-2", startedAt: 1_000_000, seconds: 600 };
  });
  expect(on(t, "zone-2")).toBe(true);
  expect(on(t, "zone-1")).toBe(false);
  expect(t.state("zone-2")?.attributes).toEqual({ endsAt: 1_600_000 });
});

test("turning a zone on starts it for the default run time; state follows from the next poll", async () => {
  const { t, cloud } = await setup({ defaultRunMinutes: 7 });
  await t.command("zone-1", { domain: "switch", action: "turn_on" });
  expect(cloud.requests.at(-1)).toEqual({
    call: "PUT /zone/start",
    body: { id: "zone-1", duration: 420 },
  });
  expect(on(t, "zone-1")).toBe(false); // not until Rachio says so
  await until(() => on(t, "zone-1") === true, "zone on");

  await t.command("zone-1", { domain: "switch", action: "turn_off" });
  expect(cloud.requests.at(-1)).toEqual({ call: "PUT /device/stop_water", body: { id: "dev-1" } });
  await until(() => on(t, "zone-1") === false, "zone off");
});

test("the schedules switch puts the controller in and out of standby; state follows from the next poll", async () => {
  const { t, cloud } = await setup();
  await t.command("dev-1-enabled", { domain: "switch", action: "turn_off" });
  expect(cloud.requests.at(-1)).toEqual({ call: "PUT /device/off", body: { id: "dev-1" } });
  expect(cloud.device().on).toBe(false);
  // Standby shows only in the controller list, so that is read again before the poll.
  await until(() => on(t, "dev-1-enabled") === false, "schedules off");

  await t.command("dev-1-enabled", { domain: "switch", action: "turn_on" });
  expect(cloud.requests.at(-1)).toEqual({ call: "PUT /device/on", body: { id: "dev-1" } });
  await until(() => on(t, "dev-1-enabled") === true, "schedules on");
});

test("actions: run a zone for a chosen time, stop, rain delay, status", async () => {
  const { t, cloud } = await setup();
  expect(await t.runAction("run_zone", { entityId: "switch.backyard_roses", minutes: 25 })).toEqual(
    {
      entityId: "switch.backyard_roses",
      minutes: 25,
    },
  );
  expect(cloud.requests.at(-1)).toEqual({
    call: "PUT /zone/start",
    body: { id: "zone-2", duration: 1500 },
  });
  await expect(t.runAction("run_zone", { entityId: "switch.nope", minutes: 5 })).rejects.toThrow(
    "is not a Rachio zone",
  );
  await expect(
    t.runAction("run_zone", { entityId: "switch.backyard_roses", minutes: 500 }),
  ).rejects.toThrow();

  await t.runAction("stop_water", {});
  expect(cloud.running).toBeUndefined();

  await t.runAction("rain_delay", { hours: 12 });
  expect(cloud.requests.find((r) => r.call === "PUT /device/rain_delay")?.body).toEqual({
    id: "dev-1",
    duration: 43_200,
  });
  await until(() => on(t, "dev-1-rain-delay") === true, "rain delay");
  expect(t.state("dev-1-rain-delay")?.attributes).toEqual({ until: 45_200_000 });

  expect(await t.runAction("status", {})).toEqual({
    controllers: 1,
    pollSeconds: 31,
    requestsRemainingToday: cloud.remaining,
  });
  await expect(t.runAction("stop_water", { deviceId: "nope" })).rejects.toThrow(
    "Unknown controller nope",
  );
});

test("a rejected API key or an unreachable API rejects setup with a readable message", async () => {
  await expect(setup({ apiKey: "wrong" })).rejects.toThrow("Rachio rejected the API key");
  await expect(
    setup({}, (cloud) => {
      cloud.down = true;
    }),
  ).rejects.toThrow("Cannot reach Rachio: getaddrinfo");
});

test("an offline controller's entities are unavailable", async () => {
  const { t } = await setup({}, (cloud) => {
    cloud.device().status = "OFFLINE";
  });
  expect(t.states.size).toBe(0);
  expect(t.availability.map((a) => a.available)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
});

test("entities go unavailable after repeated failed polls, and at once when the daily limit is spent", async () => {
  const { t, cloud } = await setup();
  cloud.down = true;
  await t.command("zone-1", { domain: "switch", action: "turn_on" }).catch(() => {});
  await expect(t.command("zone-1", { domain: "switch", action: "turn_on" })).rejects.toThrow(
    "Cannot reach Rachio",
  );
  expect([...t.states.values()].every((s) => s.available)).toBe(true); // a command failing is not a poll failing

  const limited = await setup({}, (c) => {
    c.remaining = 4; // three for setup, one for the command below
  });
  await limited.t.command("zone-1", { domain: "switch", action: "turn_on" });
  await until(() => [...limited.t.states.values()].every((s) => !s.available), "unavailable");
  await expect(
    limited.t.command("zone-1", { domain: "switch", action: "turn_off" }),
  ).rejects.toThrow("Rachio's daily request limit is used up");
  // Further calls are refused locally rather than sent.
  const sent = limited.cloud.requests.length;
  await limited.t.runAction("stop_water", {}).catch(() => {});
  expect(limited.cloud.requests.length).toBe(sent);
});

test("the poll interval stretches to keep a day of polling inside the request limit", () => {
  expect(pollInterval(60, 1)).toBe(60);
  expect(pollInterval(15, 1)).toBe(31);
  expect(pollInterval(60, 3)).toBe(93);
  // Polling plus list refreshes at that interval, for a full day, fits in the 3,500 limit with reserve.
  for (const controllers of [1, 2, 5]) {
    const perDay = (86_400 / pollInterval(15, controllers)) * controllers + 96 * 2;
    expect(perDay).toBeLessThanOrEqual(3000);
  }
});

test("cleans up on abort: polling stops", async () => {
  const { t, cloud } = await setup({ pollSeconds: 15 });
  t.abort();
  const before = cloud.requests.length;
  await Bun.sleep(30);
  expect(cloud.requests.length).toBe(before);
});

// ───────── multiple controllers, refreshes, failures ─────────

const FRONT_YARD = {
  id: "dev-2",
  name: "Front Yard",
  status: "ONLINE",
  on: true,
  model: "GENERATION2_16ZONE",
  zones: [{ id: "zone-21", zoneNumber: 1, name: "Hedge", enabled: true }],
};
const addFrontYard = (cloud: FakeRachio) => {
  cloud.person.devices.push(structuredClone(FRONT_YARD));
};

/** Anything a poll does shows up as a report, an availability change, or a log line. */
const activity = (t: TestContext<unknown>) =>
  t.reports.length + t.availability.length + t.logs.length;

/** Runs something that schedules a poll after `settleMs`, and waits for that poll to finish. */
async function andPoll(t: TestContext<unknown>, run: () => Promise<unknown>): Promise<void> {
  const before = activity(t);
  await run();
  await until(() => activity(t) > before, "the poll");
  await Bun.sleep(5); // a poll of several controllers reports between requests
}
const allAvailable = (t: TestContext<unknown>) => [...t.states.values()].every((s) => s.available);
const noneAvailable = (t: TestContext<unknown>) =>
  [...t.states.values()].every((s) => !s.available);
/** rain_delay re-reads the controller list, which is the only refresh a test can reach quickly. */
const refreshList = (t: TestContext<unknown>, deviceId = "dev-1") =>
  andPoll(t, () => t.runAction("rain_delay", { deviceId, hours: 0 }));

test("two controllers: both are discovered and polled, and the poll interval stretches for both", async () => {
  const { t, cloud } = await setup({}, addFrontYard);
  expect([...t.devices.values()].map((d) => d.uniqueId)).toEqual(["dev-1", "dev-2"]);
  expect(t.entity("zone-21").name).toBe("Front Yard Hedge");
  expect(on(t, "zone-21")).toBe(false);
  expect(on(t, "dev-2-enabled")).toBe(true);
  expect(cloud.calls("current_schedule")).toEqual([
    "GET /device/dev-1/current_schedule",
    "GET /device/dev-2/current_schedule",
  ]);
  expect(await t.runAction("status", {})).toMatchObject({ controllers: 2, pollSeconds: 62 });
  expect(t.logs.find((l) => l.level === "info")?.data).toEqual({ seconds: 62 });
});

test("two controllers: device-wide actions must say which, and go to the one named", async () => {
  const { t, cloud } = await setup({}, addFrontYard);
  await expect(t.runAction("stop_water", {})).rejects.toThrow(
    "Say which controller with deviceId: Backyard (dev-1), Front Yard (dev-2)",
  );
  await expect(t.runAction("rain_delay", { hours: 1 })).rejects.toThrow("Say which controller");

  await t.runAction("stop_water", { deviceId: "dev-2" });
  expect(cloud.requests.at(-1)).toEqual({ call: "PUT /device/stop_water", body: { id: "dev-2" } });
  await refreshList(t, "dev-2");
  expect(cloud.requests.find((r) => r.call === "PUT /device/rain_delay")?.body).toEqual({
    id: "dev-2",
    duration: 0,
  });
});

test("two controllers: a zone on the second runs there and only that zone reports on", async () => {
  const { t, cloud } = await setup({}, addFrontYard);
  await t.command("zone-21", { domain: "switch", action: "turn_on" });
  expect(cloud.requests.at(-1)).toEqual({
    call: "PUT /zone/start",
    body: { id: "zone-21", duration: 600 },
  });
  await until(() => on(t, "zone-21") === true, "zone-21 on");
  // The fake reports the same running zone for every controller; only the zone that matches is on.
  expect([on(t, "zone-1"), on(t, "zone-2")]).toEqual([false, false]);

  await t.command("zone-21", { domain: "switch", action: "turn_off" });
  expect(cloud.requests.at(-1)).toEqual({ call: "PUT /device/stop_water", body: { id: "dev-2" } });
});

test("a zone enabled in the app between refreshes becomes a switch", async () => {
  const { t, cloud } = await setup();
  const zones = cloud.device().zones as { id: string; enabled: boolean }[];
  for (const zone of zones) if (zone.id === "zone-3") zone.enabled = true;
  await refreshList(t);
  expect(t.entity("zone-3").id as string).toBe("switch.backyard_zone_3");
  expect(on(t, "zone-3")).toBe(false);
});

test("a zone disabled in the app between refreshes is no longer offered as a working switch", async () => {
  const { t, cloud } = await setup();
  const zones = cloud.device().zones as { id: string; enabled: boolean }[];
  for (const zone of zones) if (zone.id === "zone-1") zone.enabled = false;
  await refreshList(t);
  // Either removed, or kept but unavailable; not left looking live with its last state.
  const entity = [...t.entities.values()].find((e) => e.uniqueId === "zone-1");
  const state = entity ? t.states.get(entity.id) : undefined;
  expect(state === undefined || !state.available).toBe(true);
});

test("a controller that goes offline is unavailable from the next refresh, and comes back", async () => {
  const { t, cloud } = await setup();
  expect(allAvailable(t)).toBe(true);

  cloud.device().status = "OFFLINE";
  const asked = cloud.calls("current_schedule").length;
  await refreshList(t);
  expect(noneAvailable(t)).toBe(true);
  expect(cloud.calls("current_schedule")).toHaveLength(asked); // an offline controller is not asked

  cloud.device().status = "ONLINE";
  await refreshList(t);
  expect(allAvailable(t)).toBe(true);
  expect(t.states.size).toBe(6);
});

test("one offline controller does not affect the other", async () => {
  const { t } = await setup({}, (cloud) => {
    addFrontYard(cloud);
    cloud.device("dev-2").status = "OFFLINE";
  });
  expect(t.state("zone-1")?.available).toBe(true);
  expect(t.state("zone-21")).toBeUndefined(); // nothing known about it yet
  expect(t.availability.filter((a) => a.available === false)).toHaveLength(5);
});

test("entities go unavailable on exactly the third failed poll in a row, and recover on the next good one", async () => {
  const flaky = { failing: false };
  const wrap =
    (fetch: Fetch): Fetch =>
    async (url, init) => {
      if (flaky.failing && url.includes("/current_schedule")) throw new Error("socket hang up");
      return fetch(url, init);
    };
  const { t } = await setup({}, () => {}, wrap);
  // Turning the schedules switch on succeeds, then polls after settleMs.
  const poke = () =>
    andPoll(t, () => t.command("dev-1-enabled", { domain: "switch", action: "turn_on" }));
  const failures = () => t.logs.filter((l) => l.msg === "Rachio poll failed").length;

  flaky.failing = true;
  await poke();
  await poke();
  expect(failures()).toBe(2);
  expect(allAvailable(t)).toBe(true);

  await poke();
  expect(failures()).toBe(3);
  expect(noneAvailable(t)).toBe(true);
  expect(t.logs.at(-1)?.data).toEqual({
    error: "Cannot reach Rachio: socket hang up",
    failures: 3,
  });

  const marked = t.availability.length;
  await poke();
  expect(noneAvailable(t)).toBe(true);
  expect(t.availability).toHaveLength(marked); // already unavailable; not marked again

  flaky.failing = false;
  await poke();
  expect(allAvailable(t)).toBe(true);

  // The count starts again after a good poll: two more failures are tolerated.
  flaky.failing = true;
  await poke();
  await poke();
  expect(allAvailable(t)).toBe(true);
});

test("a controller removed from the account stops being polled and does not take the others down", async () => {
  // Rachio answers 404 for a controller that is no longer on the account.
  const removed = new Set<string>();
  const wrap =
    (fetch: Fetch): Fetch =>
    async (url, init) => {
      for (const id of removed)
        if (url.includes(`/device/${id}/`))
          return Response.json({ error: "Not found" }, { status: 404 });
      return fetch(url, init);
    };
  const { t, cloud } = await setup({}, addFrontYard, wrap);
  cloud.person.devices.splice(1, 1);
  removed.add("dev-2");
  await refreshList(t);
  await refreshList(t);
  await refreshList(t);
  expect(t.state("zone-1")?.available).toBe(true);
  expect(t.state("dev-1-enabled")?.available).toBe(true);
  expect(t.logs.filter((l) => l.msg === "Rachio poll failed")).toEqual([]);
});

test("the poll interval is stretched again when a controller is added to the account", async () => {
  const { t, cloud } = await setup();
  expect(await t.runAction("status", {})).toMatchObject({ controllers: 1, pollSeconds: 31 });
  addFrontYard(cloud);
  await refreshList(t);
  // Two controllers polled every 31 s is about 5,600 requests a day, over the 3,500 limit.
  expect(await t.runAction("status", {})).toMatchObject({ controllers: 2, pollSeconds: 62 });
});

test("pollInterval at its edges", () => {
  // No controllers is treated like one.
  expect(pollInterval(15, 0)).toBe(31);
  expect(pollInterval(15, -3)).toBe(31);
  // Right around the one-controller floor of 31 s.
  expect(pollInterval(30, 1)).toBe(31);
  expect(pollInterval(31, 1)).toBe(31);
  expect(pollInterval(32, 1)).toBe(32);
  // The configured value wins when it is already slower.
  expect(pollInterval(3600, 10)).toBe(3600);
  // Stretching grows with the number of controllers.
  expect([2, 4, 10, 100].map((n) => pollInterval(15, n))).toEqual([62, 124, 308, 3077]);
});

// ───────── last watered, rain sensor, next run ─────────

const SATURDAY = Date.UTC(2026, 9, 3, 19, 0); // Sat 3 Oct 2026, noon in Los Angeles
const schedule = (extra: Record<string, unknown> = {}) => ({
  name: "Basic Schedule",
  enabled: true,
  summary: "Every Mon, Thu, Sat end by sunrise",
  scheduleJobTypes: ["DAY_OF_WEEK_6", "DAY_OF_WEEK_1", "DAY_OF_WEEK_4"],
  zones: [{ zoneId: "zone-1" }],
  ...extra,
});
const controller = (extra: Record<string, unknown> = {}) =>
  ({
    id: "dev-1",
    name: "Backyard",
    on: true,
    timeZone: "America/Los_Angeles",
    zones: [{ id: "zone-1", zoneNumber: 1, name: "Lawn", enabled: true }],
    scheduleRules: [schedule()],
    flexScheduleRules: [],
    ...extra,
  }) as Parameters<typeof nextRun>[0];

test("next run: the nearest scheduled weekday, in the controller's time zone, with Rachio's timing", () => {
  expect(nextRun(controller(), SATURDAY)).toEqual({
    when: "today, end by sunrise",
    schedule: "Basic Schedule",
    summary: "Every Mon, Thu, Sat end by sunrise",
  });
  expect(nextRun(controller(), SATURDAY + 86_400_000)?.when).toBe("tomorrow, end by sunrise"); // Sunday
  expect(nextRun(controller(), SATURDAY + 3 * 86_400_000)?.when).toBe("Thu, end by sunrise"); // Tuesday
  // 05:00 UTC on Sunday is still Saturday evening in Los Angeles.
  expect(nextRun(controller(), Date.UTC(2026, 9, 4, 5, 0))?.when).toBe("today, end by sunrise");
});

test("next run: a schedule that already watered today moves to its next day", () => {
  const watered = controller({
    zones: [
      {
        id: "zone-1",
        zoneNumber: 1,
        name: "Lawn",
        enabled: true,
        lastWateredDate: SATURDAY - 6 * 3_600_000,
      },
    ],
  });
  expect(nextRun(watered, SATURDAY)?.when).toBe("Mon, end by sunrise");
  // Watering some other zone by hand does not count as the schedule having run.
  const other = controller({
    zones: [
      { id: "zone-1", zoneNumber: 1, name: "Lawn", enabled: true },
      {
        id: "zone-2",
        zoneNumber: 2,
        name: "Roses",
        enabled: true,
        lastWateredDate: SATURDAY - 3_600_000,
      },
    ],
  });
  expect(nextRun(other, SATURDAY)?.when).toBe("today, end by sunrise");
});

test("next run: disabled, interval, and absent schedules; the soonest of several wins", () => {
  expect(
    nextRun(controller({ scheduleRules: [schedule({ enabled: false })] }), SATURDAY),
  ).toBeUndefined();
  expect(
    nextRun(
      controller({ scheduleRules: [schedule({ scheduleJobTypes: ["INTERVAL_3"] })] }),
      SATURDAY,
    ),
  ).toBeUndefined();
  expect(nextRun(controller({ scheduleRules: [] }), SATURDAY)).toBeUndefined();
  const two = controller({
    scheduleRules: [
      schedule({
        name: "Wednesdays",
        scheduleJobTypes: ["DAY_OF_WEEK_3"],
        summary: "Every Wed at 6:00 AM",
      }),
      schedule({ name: "Sundays", scheduleJobTypes: ["DAY_OF_WEEK_0"], summary: undefined }),
    ],
  });
  expect(nextRun(two, SATURDAY)).toEqual({
    when: "tomorrow",
    schedule: "Sundays",
    summary: undefined,
  });
  expect(nextRun(two, SATURDAY + 2 * 86_400_000)).toMatchObject({
    when: "Wed, at 6:00 AM",
    schedule: "Wednesdays",
  });
});

test("zones carry when they were last watered; the rain sensor and next run are entities", async () => {
  const { t } = await setup({}, (cloud) => {
    const device = cloud.device();
    device.rainSensorTripped = true;
    device.timeZone = "America/Los_Angeles";
    device.scheduleRules = [schedule()];
    (device.zones as Record<string, unknown>[])[1] = {
      id: "zone-1",
      zoneNumber: 1,
      name: "Lawn",
      enabled: true,
      lastWateredDate: 1_500_000,
      lastWateredSeconds: 0,
      lastWateredDuration: 419,
    };
  });
  expect(t.state("zone-1")?.attributes).toEqual({
    endsAt: undefined,
    lastWateredAt: 1_500_000,
    lastWateredSeconds: 419,
  });
  expect(t.state("zone-2")?.attributes).toEqual({
    endsAt: undefined,
    lastWateredAt: undefined,
    lastWateredSeconds: undefined,
  });
  expect(on(t, "dev-1-rain-sensor")).toBe(true);
  const next = t.state("dev-1-next-run");
  expect(next?.state).toMatchObject({
    domain: "sensor",
    value: expect.stringMatching(/, end by sunrise$/),
  });
  expect(next?.attributes).toEqual({
    schedule: "Basic Schedule",
    summary: "Every Mon, Thu, Sat end by sunrise",
  });
});

test("with no fixed-weekday schedule the next run has no value", async () => {
  const { t } = await setup();
  expect(t.state("dev-1-next-run")?.state).toEqual({ domain: "sensor", value: null });
  expect(on(t, "dev-1-rain-sensor")).toBe(false);
});

test("when a run ends, the controller list is read again so last-watered is fresh", async () => {
  const { t, cloud } = await setup();
  await t.command("zone-1", { domain: "switch", action: "turn_on" });
  await until(() => on(t, "zone-1") === true, "zone on");
  const lists = cloud.calls("/person/person-1").length;
  (cloud.device().zones as Record<string, unknown>[])[1] = {
    id: "zone-1",
    zoneNumber: 1,
    name: "Lawn",
    enabled: true,
    lastWateredDate: 1_900_000,
    lastWateredDuration: 600,
  };
  await t.command("zone-1", { domain: "switch", action: "turn_off" });
  await until(
    () =>
      (t.state("zone-1")?.attributes as { lastWateredAt?: number })?.lastWateredAt === 1_900_000,
    "last watered",
  );
  expect(cloud.calls("/person/person-1").length).toBe(lists + 1);
  expect(on(t, "zone-1")).toBe(false);
});

// ───────── next run: weekdays, time zones, DST, timing phrases ─────────

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A controller whose only zone was last watered at `ms`. */
const wateredAt = (ms: number, extra: Record<string, unknown> = {}) =>
  controller({
    zones: [{ id: "zone-1", zoneNumber: 1, name: "Lawn", enabled: true, lastWateredDate: ms }],
    ...extra,
  });
/** A controller with one schedule on the given weekdays (0 is Sunday). */
const weekly = (days: number[], extra: Record<string, unknown> = {}) =>
  controller({
    scheduleRules: [
      schedule({ scheduleJobTypes: days.map((d) => `DAY_OF_WEEK_${d}`), summary: undefined }),
    ],
    ...extra,
  });

test("next run: every weekday reads today, tomorrow, then the weekday name for each day ahead", () => {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let offset = 0; offset < 7; offset++) {
    const now = SATURDAY + offset * DAY; // noon in Los Angeles
    const today = (6 + offset) % 7;
    const seen = [0, 1, 2, 3, 4, 5, 6].map(
      (ahead) => nextRun(weekly([(today + ahead) % 7]), now)?.when,
    );
    expect(seen).toEqual([
      "today",
      "tomorrow",
      ...[2, 3, 4, 5, 6].map((ahead) => names[(today + ahead) % 7]),
    ]);
  }
});

test("next run: the day turns at midnight in Los Angeles, not at midnight UTC", () => {
  const saturdays = weekly([6]);
  expect(nextRun(saturdays, Date.UTC(2026, 9, 3, 23, 59))?.when).toBe("today"); // 4:59 pm Sat
  expect(nextRun(saturdays, Date.UTC(2026, 9, 4, 0, 0))?.when).toBe("today"); // 5 pm Sat; Sun in UTC
  expect(nextRun(saturdays, Date.UTC(2026, 9, 4, 6, 59))?.when).toBe("today"); // 11:59 pm Sat
  expect(nextRun(saturdays, Date.UTC(2026, 9, 4, 7, 0))?.when).toBe("Sat"); // midnight, Sun
});

test("next run: in Auckland the day turns thirteen hours ahead of UTC", () => {
  const sundays = weekly([0], { timeZone: "Pacific/Auckland" });
  // 10:59 UTC Saturday is 11:59 pm Saturday in Auckland (NZDT, +13).
  expect(nextRun(sundays, Date.UTC(2026, 9, 3, 10, 59))?.when).toBe("tomorrow");
  // 11:00 UTC Saturday is already Sunday there, while still Saturday in UTC.
  expect(nextRun(sundays, Date.UTC(2026, 9, 3, 11, 0))?.when).toBe("today");
});

test("next run: a controller with no time zone uses the host's, which is UTC under bun test", () => {
  const saturdays = weekly([6], { timeZone: undefined });
  expect(nextRun(saturdays, Date.UTC(2026, 9, 3, 23, 59))?.when).toBe("today");
  expect(nextRun(saturdays, Date.UTC(2026, 9, 4, 0, 0))?.when).toBe("Sat");
});

test("next run: on the autumn DST change the 25-hour Sunday stays Sunday to its last minute", () => {
  // Los Angeles falls back on Sun 1 Nov 2026; Monday starts at 08:00 UTC rather than 07:00.
  const sundays = weekly([0]);
  expect(nextRun(sundays, Date.UTC(2026, 10, 1, 7, 0))?.when).toBe("today"); // 00:00 PDT
  expect(nextRun(sundays, Date.UTC(2026, 10, 2, 7, 30))?.when).toBe("today"); // 11:30 pm PST
  expect(nextRun(sundays, Date.UTC(2026, 10, 2, 8, 0))?.when).toBe("Sun"); // Monday
});

test("next run: on the spring DST change the 23-hour Sunday ends at 07:00 UTC", () => {
  // Los Angeles springs forward on Sun 8 Mar 2026.
  const mondays = weekly([1]);
  expect(nextRun(mondays, Date.UTC(2026, 2, 8, 8, 0))?.when).toBe("tomorrow"); // 00:00 PST Sun
  expect(nextRun(mondays, Date.UTC(2026, 2, 9, 6, 59))?.when).toBe("tomorrow"); // 11:59 pm PDT Sun
  expect(nextRun(mondays, Date.UTC(2026, 2, 9, 7, 0))?.when).toBe("today"); // 00:00 PDT Mon
});

test("next run: watering early on a 25-hour DST day still counts as today 24 hours later", () => {
  const sundays = (days: number[]) =>
    wateredAt(Date.UTC(2026, 10, 1, 7, 30), {
      scheduleRules: [schedule({ scheduleJobTypes: days.map((d) => `DAY_OF_WEEK_${d}`) })],
    });
  // 00:30 PDT Sunday watered; 11:30 pm PST the same Sunday is 24 h later in UTC.
  expect(nextRun(sundays([0, 3]), Date.UTC(2026, 10, 2, 7, 30))?.when).toBe("Wed, end by sunrise");
});

test("next run: a schedule whose only day is today and that already ran is a week away, under its own schedule", () => {
  const ran = wateredAt(SATURDAY - HOUR, {
    scheduleRules: [schedule({ scheduleJobTypes: ["DAY_OF_WEEK_6"] })],
  });
  expect(nextRun(ran, SATURDAY)).toMatchObject({
    schedule: "Basic Schedule",
    summary: "Every Mon, Thu, Sat end by sunrise",
  });
  // Any other schedule due sooner than a week wins over it.
  const withTuesdays = wateredAt(SATURDAY - HOUR, {
    scheduleRules: [
      schedule({ scheduleJobTypes: ["DAY_OF_WEEK_6"] }),
      schedule({ name: "Tuesdays", scheduleJobTypes: ["DAY_OF_WEEK_2"], zones: [] }),
    ],
  });
  expect(nextRun(withTuesdays, SATURDAY)?.schedule).toBe("Tuesdays");
});

test("next run: a schedule a full week away does not read as just today's weekday name", () => {
  // On a Saturday, "Sat, end by sunrise" for next Saturday reads like today's run.
  const ran = wateredAt(SATURDAY - HOUR, {
    scheduleRules: [schedule({ scheduleJobTypes: ["DAY_OF_WEEK_6"] })],
  });
  const when = nextRun(ran, SATURDAY)?.when;
  expect(when).toContain("Sat");
  expect(when).not.toBe("Sat, end by sunrise");
});

test("next run: an every-day schedule that already ran today is next due tomorrow", () => {
  const daily = wateredAt(SATURDAY - HOUR, {
    scheduleRules: [
      schedule({
        summary: "Every day at 5:30 AM",
        scheduleJobTypes: [0, 1, 2, 3, 4, 5, 6].map((d) => `DAY_OF_WEEK_${d}`),
      }),
    ],
  });
  expect(nextRun(daily, SATURDAY)?.when).toBe("tomorrow, at 5:30 AM");
});

test("next run: two schedules due the same day give one schedule's name, summary, and timing together", () => {
  const evening = schedule({
    name: "Evening",
    summary: "Every Sat at 9:00 PM",
    scheduleJobTypes: ["DAY_OF_WEEK_6"],
  });
  const morning = schedule({
    name: "Morning",
    summary: "Every Sat at 5:30 AM",
    scheduleJobTypes: ["DAY_OF_WEEK_6"],
  });
  for (const rules of [
    [evening, morning],
    [morning, evening],
  ]) {
    const next = nextRun(controller({ scheduleRules: rules }), SATURDAY);
    const rule = rules.find((r) => r.name === next?.schedule);
    expect(rule).toBeDefined();
    expect(next?.summary).toBe(rule?.summary);
    expect(next?.when).toBe(`today, ${rule?.summary?.replace("Every Sat ", "")}`);
  }
});

test("next run: flex schedules on fixed weekdays count, and one due sooner beats a fixed schedule", () => {
  const flex = schedule({
    name: "Flex Daily",
    summary: "Every Sun end by sunrise",
    scheduleJobTypes: ["DAY_OF_WEEK_0"],
  });
  expect(nextRun(controller({ scheduleRules: [], flexScheduleRules: [flex] }), SATURDAY)).toEqual({
    when: "tomorrow, end by sunrise",
    schedule: "Flex Daily",
    summary: "Every Sun end by sunrise",
  });
  const fixedTuesday = schedule({
    name: "Tue",
    summary: undefined,
    scheduleJobTypes: ["DAY_OF_WEEK_2"],
  });
  expect(
    nextRun(controller({ scheduleRules: [fixedTuesday], flexScheduleRules: [flex] }), SATURDAY)
      ?.schedule,
  ).toBe("Flex Daily");
  // A flex schedule without fixed weekdays (Rachio's usual) says nothing.
  const anyDay = schedule({ name: "Flex", scheduleJobTypes: [] });
  expect(nextRun(controller({ scheduleRules: [], flexScheduleRules: [anyDay] }), SATURDAY)).toBe(
    undefined,
  );
  // A disabled flex schedule is skipped like a disabled fixed one.
  expect(
    nextRun(
      controller({ scheduleRules: [], flexScheduleRules: [{ ...flex, enabled: false }] }),
      SATURDAY,
    ),
  ).toBeUndefined();
});

test("next run: only well-formed DAY_OF_WEEK_0..6 job types are read as weekdays", () => {
  const types = (scheduleJobTypes: string[]) =>
    nextRun(
      controller({ scheduleRules: [schedule({ scheduleJobTypes, summary: undefined })] }),
      SATURDAY,
    )?.when;
  expect(types(["INTERVAL_3", "DAY_OF_WEEK_2"])).toBe("Tue");
  expect(types(["ODD", "DAY_OF_WEEK_1", "EVEN"])).toBe("Mon");
  expect(types(["DAY_OF_WEEK_7"])).toBeUndefined();
  expect(types(["DAY_OF_WEEK_10"])).toBeUndefined();
  expect(types(["day_of_week_6"])).toBeUndefined();
  expect(types(["DAY_OF_WEEK_6_EXTRA"])).toBeUndefined();
  expect(types(["DAY_OF_WEEK_2", "DAY_OF_WEEK_2"])).toBe("Tue");
});

test.each([
  ["Every day at 5:30 AM", "today, at 5:30 AM"],
  ["Every Sat start at 6:00 AM", "today, start at 6:00 AM"],
  ["Every 3 days end by sunrise", "today, end by sunrise"],
  ["Every Sat starts after sunset", "today, starts after sunset"],
  ["Every Sat end before sunrise (cycle and soak)", "today, end before sunrise (cycle and soak)"],
  ["Every weekend at 7:00 AM", "today, at 7:00 AM"],
  ["Lawn, twice a week", "today"],
  ["", "today"],
  [undefined, "today"],
])("next run: summary %p reads %p", (summary, when) => {
  const next = nextRun(
    controller({ scheduleRules: [schedule({ summary, scheduleJobTypes: ["DAY_OF_WEEK_6"] })] }),
    SATURDAY,
  );
  expect(next?.when).toBe(when);
  expect(next?.summary).toBe(summary);
});

test("next run: a last watering later today (clock skew) counts as today's run; other days do not", () => {
  expect(nextRun(wateredAt(SATURDAY + HOUR), SATURDAY)?.when).toBe("Mon, end by sunrise");
  expect(nextRun(wateredAt(SATURDAY + DAY), SATURDAY)?.when).toBe("today, end by sunrise");
  expect(nextRun(wateredAt(SATURDAY + 365 * DAY), SATURDAY)?.when).toBe("today, end by sunrise");
});

test("next run: a watering last week on the same weekday, or long ago, does not count as today's", () => {
  expect(nextRun(wateredAt(SATURDAY - 7 * DAY), SATURDAY)?.when).toBe("today, end by sunrise");
  expect(nextRun(wateredAt(SATURDAY - 365 * DAY), SATURDAY)?.when).toBe("today, end by sunrise");
  expect(nextRun(wateredAt(0), SATURDAY)?.when).toBe("today, end by sunrise");
  // Yesterday evening in Los Angeles, though the same UTC date as an early-morning "now".
  const lateFriday = Date.UTC(2026, 9, 3, 6, 30); // 11:30 pm Fri PDT
  expect(nextRun(wateredAt(lateFriday), Date.UTC(2026, 9, 3, 8, 0))?.when).toBe(
    "today, end by sunrise",
  );
});

test("next run: a schedule naming a zone that no longer exists, or no zones, is still due", () => {
  const gone = controller({
    scheduleRules: [schedule({ zones: [{ zoneId: "zone-gone" }] })],
  });
  expect(nextRun(gone, SATURDAY)?.when).toBe("today, end by sunrise");
  const none = controller({ scheduleRules: [schedule({ zones: [] })] });
  expect(nextRun(none, SATURDAY)?.when).toBe("today, end by sunrise");
  // A missing zone next to one watered today: the watered one still marks the run done.
  const mixed = wateredAt(SATURDAY - HOUR, {
    scheduleRules: [schedule({ zones: [{ zoneId: "zone-gone" }, { zoneId: "zone-1" }] })],
  });
  expect(nextRun(mixed, SATURDAY)?.when).toBe("Mon, end by sunrise");
});

test("next run: an unrecognised time zone does not throw", () => {
  // Intl.DateTimeFormat throws RangeError for it, which nextRun lets through.
  expect(() => nextRun(controller({ timeZone: "Not/AZone" }), SATURDAY)).not.toThrow();
});

// ───────── poll: re-reading the list when a run ends ─────────

const lists = (cloud: FakeRachio) => cloud.calls("GET /person/person-1").length;
/** Stopping water when none is running changes nothing, and polls after settleMs. */
const poke = (t: TestContext<unknown>) => andPoll(t, () => t.runAction("stop_water", {}));

test("polls with nothing running never re-read the controller list", async () => {
  const { t, cloud } = await setup();
  const before = lists(cloud);
  await poke(t);
  await poke(t);
  await poke(t);
  expect(lists(cloud)).toBe(before);
});

test("a zone that keeps running does not re-read the list on each poll", async () => {
  const { t, cloud } = await setup({}, (c) => {
    c.running = { zoneId: "zone-1", startedAt: 1_000_000, seconds: 600 };
  });
  const before = lists(cloud);
  // Starting the running zone again keeps it running, and polls after settleMs.
  const again = () =>
    andPoll(t, () => t.command("zone-1", { domain: "switch", action: "turn_on" }));
  await again();
  await again();
  expect(on(t, "zone-1")).toBe(true);
  expect(lists(cloud)).toBe(before);
});

test("a run that stops re-reads the list exactly once, and later polls do not read it again", async () => {
  const { t, cloud } = await setup();
  await t.command("zone-1", { domain: "switch", action: "turn_on" });
  await until(() => on(t, "zone-1") === true, "zone on");
  const before = lists(cloud);
  await t.command("zone-1", { domain: "switch", action: "turn_off" });
  await until(() => lists(cloud) === before + 1, "the re-read");
  await Bun.sleep(20); // the poll that follows the re-read
  await poke(t);
  await poke(t);
  await poke(t);
  expect(lists(cloud)).toBe(before + 1);
  expect(on(t, "zone-1")).toBe(false);
});

test("a failed re-read after a run stops logs a warning and leaves the entities as they were", async () => {
  const failList = { on: false };
  const wrap =
    (fetch: Fetch): Fetch =>
    async (url, init) => {
      if (failList.on && url.endsWith("/person/person-1")) throw new Error("socket hang up");
      return fetch(url, init);
    };
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const { t } = await setup({}, () => {}, wrap);
    await t.command("zone-1", { domain: "switch", action: "turn_on" });
    await until(() => on(t, "zone-1") === true, "zone on");
    const entities = [...t.entities.keys()];

    failList.on = true;
    await t.command("zone-1", { domain: "switch", action: "turn_off" });
    await until(() => t.logs.some((l) => l.msg === "Rachio poll failed"), "the warning");
    await Bun.sleep(10);

    expect(t.logs.filter((l) => l.level === "warn")).toEqual([
      {
        level: "warn",
        msg: "Rachio poll failed",
        data: { error: "Cannot reach Rachio: socket hang up", failures: 1 },
      },
    ]);
    expect(on(t, "zone-1")).toBe(false); // reported before the re-read was tried
    expect([...t.entities.keys()]).toEqual(entities);
    expect(allAvailable(t)).toBe(true);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a controller with an unrecognised time zone still has its state reported", async () => {
  const { t } = await setup({}, (cloud) => {
    const device = cloud.device();
    device.timeZone = "Not/AZone";
    device.scheduleRules = [schedule()];
  });
  expect(t.logs.filter((l) => l.msg === "Rachio poll failed")).toEqual([]);
  expect(on(t, "dev-1-enabled")).toBe(true);
  expect(on(t, "dev-1-rain-delay")).toBe(false);
});
