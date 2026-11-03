import { describe, expect, test } from "bun:test";
import { createCore } from "../testing.ts";
import type { Command, CommandSource, DeviceId, EntityId, StateRecord } from "../types.ts";
import { noopLogger } from "../util.ts";
import { AutomationStore } from "./automations.ts";
import type { CServerHandler } from "./compiled.ts";
import { PageRuntime, type PageRuntimeDeps } from "./runtime.ts";
import { PageStore } from "./store.ts";

/** A registry the compiler and the runtime agree on: the house registered through the core. */
async function setup(
  opts: { runLog?: number; integrations?: PageRuntimeDeps["integrations"] } = {},
) {
  const core = await createCore();
  const { db, bus, now, events, registry, states } = core;
  registry.registerEntity("fixture", { uniqueId: "porch", domain: "switch", name: "Porch" });
  registry.registerEntity("fixture", { uniqueId: "hall", domain: "light", name: "Hall" });
  const casaRegistry = () => ({
    entities: registry.listEntities().map((e) => ({ id: e.id, domain: e.domain, name: e.name })),
    areas: [],
    devices: registry.listDevices().map((d) => ({ id: d.id, name: d.name })),
  });
  const pages = new PageStore({ db, bus, now, registry: casaRegistry });
  const automations = new AutomationStore({ db, bus, now, registry: casaRegistry });
  const sent: { id: string; command: Command; source: CommandSource }[] = [];
  let refuse: Error | undefined;
  let hold: Promise<void> | undefined;
  const router = {
    send: async (id: EntityId, command: Command, source: CommandSource) => {
      if (hold) await hold;
      if (refuse) throw refuse;
      sent.push({ id, command, source });
      return { status: "sent" as const, entityId: id, command, latencyMs: 0 };
    },
  };
  const runtime = new PageRuntime({
    pages,
    automations,
    bus,
    states,
    registry,
    router,
    logFor: () => noopLogger,
    timezone: "UTC",
    now,
    runLog: opts.runLog,
    integrations: opts.integrations,
  });
  const statuses = () =>
    events.flatMap((e) => (e.type === "automation_status" ? [e] : ([] as never[])));
  const porch = (on: boolean): StateRecord => ({
    entityId: "switch.porch" as EntityId,
    state: { domain: "switch", on },
    available: true,
    changedAt: now(),
    updatedAt: now(),
  });
  const flip = (on: boolean) =>
    bus.emit({
      type: "state_changed",
      entityId: "switch.porch" as EntityId,
      old: porch(!on),
      new: porch(on),
    });
  return {
    ...core,
    pages,
    automations,
    runtime,
    sent,
    statuses,
    flip,
    refuse: (err?: Error) => {
      refuse = err;
    },
    hold: (promise?: Promise<void>) => {
      hold = promise;
    },
  };
}

const ON: CServerHandler = {
  trigger: { kind: "changed", entity: "switch.porch", to: ["member", "On"] },
  body: [["call", "light.hall", "turn_on", {}]],
  line: 2,
};
const OFF_LATER: CServerHandler = {
  trigger: { kind: "changed", entity: "switch.porch", to: ["member", "Off"] },
  body: [["after", 30, [["call", "light.hall", "turn_off", {}]]]],
  line: 3,
};
const register = (
  runtime: PageRuntime,
  handlers: CServerHandler[],
  extra: Partial<Parameters<PageRuntime["register"]>[1]> = {},
) =>
  runtime.register("automation:x", {
    handlers,
    enabled: true,
    entities: [],
    devices: [],
    restart: true,
    ...extra,
  });

const SOURCE = `automation HallLight {
  on switch.porch changed to .On { call light.hall.turn_on }
}
`;

test("start arms every stored automation as `automation:<id>` and says so", async () => {
  const { automations, runtime, statuses } = await setup();
  automations.save("hall_light", SOURCE);
  runtime.start();
  expect(runtime.list()).toEqual([
    {
      automationId: "automation:hall_light",
      status: "running",
      handlers: 1,
      error: undefined,
      lastRunAt: undefined,
    },
  ]);
  expect(statuses().at(-1)).toEqual({
    type: "automation_status",
    automationId: "automation:hall_light",
    status: "running",
    error: undefined,
  });
  runtime.stop();
});

test("a trigger fires the handler as the automation and remembers the run", async () => {
  const { automations, runtime, sent, flip, now } = await setup();
  automations.save("hall_light", SOURCE);
  runtime.start();
  flip(true);
  await Bun.sleep(5);
  expect(sent).toEqual([
    {
      id: "light.hall",
      command: { domain: "light", action: "turn_on" },
      source: { kind: "automation", automationId: "automation:hall_light" },
    },
  ]);
  expect(runtime.runs("automation:hall_light")).toEqual([
    {
      at: now(),
      line: 2,
      trigger: "switch.porch changed",
      calls: [{ entityId: "light.hall", command: { domain: "light", action: "turn_on" } }],
      actions: [],
      armed: [],
    },
  ]);
  expect(runtime.status("automation:hall_light")?.lastRunAt).toBe(now());
  runtime.stop();
});

test("a refused command is recorded on the run and the registration, which keeps running", async () => {
  const { automations, runtime, flip, refuse, statuses } = await setup();
  automations.save("hall_light", SOURCE);
  runtime.start();
  refuse(new Error("not permitted"));
  flip(true);
  await Bun.sleep(5);
  const [run] = runtime.runs("automation:hall_light");
  expect(run?.calls[0]?.error).toBe("not permitted");
  expect(runtime.status("automation:hall_light")).toMatchObject({
    status: "running",
    error: "line 2: light.hall refused turn_on: not permitted",
  });
  expect(statuses().at(-1)).toMatchObject({
    status: "running",
    error: "line 2: light.hall refused turn_on: not permitted",
  });
  runtime.stop();
});

test("in an automation, a firing of any handler cancels the timers another left", async () => {
  const { runtime, sent, flip } = await setup();
  register(runtime, [ON, OFF_LATER]);
  flip(false);
  await Bun.sleep(5);
  expect(runtime.runs("automation:x")[0]?.armed).toEqual([30]);
  flip(true);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
  runtime.stop();
});

test("in a page, each handler's timers are its own and survive the others' firings", async () => {
  const { runtime, sent, flip } = await setup();
  register(runtime, [ON, OFF_LATER], { restart: false });
  flip(false);
  await Bun.sleep(5);
  flip(true);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_on", "turn_off"]);
  runtime.stop();
});

test("a firing superseded while its command was in flight arms nothing", async () => {
  const { runtime, sent, flip, hold } = await setup();
  const callThenAfter: CServerHandler = {
    ...OFF_LATER,
    body: [
      ["call", "light.hall", "turn_on", {}],
      ["after", 30, [["call", "light.hall", "turn_off", {}]]],
    ],
  };
  register(runtime, [ON, callThenAfter]);
  let release = () => {};
  hold(new Promise<void>((resolve) => (release = resolve)));
  flip(false); // waits on the call
  await Bun.sleep(5);
  hold(undefined);
  flip(true); // outranks it
  await Bun.sleep(5);
  release();
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_on", "turn_on"]);
  expect(runtime.runs("automation:x").find((r) => r.line === 3)?.armed).toEqual([]);
  runtime.stop();
});

test("every timer a firing armed is cancelled by the next, not only the last", async () => {
  const { runtime, sent, flip } = await setup();
  const two: CServerHandler = {
    ...OFF_LATER,
    body: [
      ["after", 20, [["call", "light.hall", "turn_off", {}]]],
      ["after", 30, [["call", "light.hall", "turn_off", {}]]],
    ],
  };
  register(runtime, [ON, two]);
  flip(false);
  await Bun.sleep(5);
  expect(runtime.runs("automation:x")[0]?.armed).toEqual([20, 30]);
  flip(true);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
  runtime.stop();
});

test("a timer that fires is a run of its own", async () => {
  const { runtime, sent, flip, now } = await setup();
  register(runtime, [OFF_LATER]);
  flip(false);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_off"]);
  expect(runtime.runs("automation:x")).toEqual([
    {
      at: now(),
      line: 3,
      trigger: "after 0s",
      calls: [{ entityId: "light.hall", command: { domain: "light", action: "turn_off" } }],
      actions: [],
      armed: [],
    },
    { at: now(), line: 3, trigger: "switch.porch changed", calls: [], actions: [], armed: [30] },
  ]);
  runtime.stop();
});

test("registering what is already registered keeps its pending timers; a change drops them", async () => {
  const { runtime, sent, flip } = await setup();
  register(runtime, [OFF_LATER]);
  flip(false);
  await Bun.sleep(5);
  register(runtime, [OFF_LATER]);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_off"]);

  flip(false);
  await Bun.sleep(5);
  register(runtime, [OFF_LATER, ON]);
  await Bun.sleep(60);
  expect(sent.map((s) => s.command.action)).toEqual(["turn_off"]);
  runtime.stop();
});

test("a disabled automation is stopped and fires nothing", async () => {
  const { runtime, sent, flip, statuses } = await setup();
  register(runtime, [ON], { enabled: false });
  expect(runtime.status("automation:x")).toMatchObject({ status: "stopped", handlers: 1 });
  expect(statuses().at(-1)).toMatchObject({ automationId: "automation:x", status: "stopped" });
  flip(true);
  await Bun.sleep(5);
  expect(sent).toEqual([]);
  runtime.stop();
});

test("an entity that is gone makes the status an error until it is back", async () => {
  const { runtime, registry, statuses } = await setup();
  runtime.start();
  register(runtime, [ON], { entities: ["light.hall", "light.nowhere"] });
  expect(runtime.status("automation:x")).toMatchObject({
    status: "error",
    error: "light.nowhere is gone; the automation waits on it",
  });
  registry.registerEntity("fixture", { uniqueId: "nowhere", domain: "light", name: "Nowhere" });
  expect(runtime.status("automation:x")).toMatchObject({ status: "running", error: undefined });
  expect(statuses().at(-1)).toMatchObject({ status: "running" });
  runtime.stop();
});

test("a device an automation looks up is tracked like an entity: renamed away, it is gone", async () => {
  const { automations, runtime, registry, statuses } = await setup();
  registry.registerDevice("fixture", { uniqueId: "t", name: "Thermostat" });
  runtime.start();
  automations.save(
    "x",
    'automation X {\n  on switch.porch changed to .On { if device.thermostat.name == "x" { call light.hall.turn_on } }\n}\n',
  );
  expect(automations.get("x")?.devices).toEqual(["thermostat"]);
  expect(runtime.status("automation:x")).toMatchObject({ status: "running" });

  registry.renameDevice("thermostat" as DeviceId, "hvac" as DeviceId);
  expect(runtime.status("automation:x")).toMatchObject({
    status: "error",
    error: "device.thermostat is gone; the automation waits on it",
  });
  expect(statuses().at(-1)).toMatchObject({ status: "error" });
  // Renamed back, it runs again without a save.
  registry.renameDevice("hvac" as DeviceId, "thermostat" as DeviceId);
  expect(runtime.status("automation:x")).toMatchObject({ status: "running", error: undefined });
  runtime.stop();
});

test("the store's changes re-register: a save, a switch, a delete", async () => {
  const { automations, runtime, statuses } = await setup();
  runtime.start();
  expect(runtime.list()).toEqual([]);
  automations.save("hall_light", SOURCE);
  expect(runtime.status("automation:hall_light")).toMatchObject({ status: "running" });
  automations.setEnabled("hall_light", false);
  expect(runtime.status("automation:hall_light")).toMatchObject({ status: "stopped" });
  automations.setEnabled("hall_light", true);
  expect(runtime.status("automation:hall_light")).toMatchObject({ status: "running" });
  automations.delete("hall_light");
  expect(runtime.list()).toEqual([]);
  expect(statuses().at(-1)).toMatchObject({
    automationId: "automation:hall_light",
    status: "stopped",
  });
  runtime.stop();
});

test("the run log keeps the last few, newest first", async () => {
  const { runtime, flip, clock } = await setup({ runLog: 3 });
  register(runtime, [ON]);
  for (let i = 0; i < 5; i++) {
    clock.now += 1;
    flip(false);
    flip(true);
    await Bun.sleep(2);
  }
  const runs = runtime.runs("automation:x");
  expect(runs).toHaveLength(3);
  expect(runs.map((r) => r.at)).toEqual([1_000_005, 1_000_004, 1_000_003]);
  runtime.stop();
});

test("stop disarms everything", async () => {
  const { runtime, sent, flip } = await setup();
  register(runtime, [OFF_LATER]);
  flip(false);
  runtime.stop();
  await Bun.sleep(60);
  expect(sent).toEqual([]);
  expect(runtime.list()).toEqual([]);
});

describe("run", () => {
  /** An integration host that records what it was asked to run, refusing what `refuse` names. */
  const fakeHost = (refuse?: string) => {
    const ran: [string, string, unknown][] = [];
    return {
      ran,
      integrations: {
        runAction: async (integrationId: string, name: string, params: unknown) => {
          if (name === refuse) throw new Error(`${name} is not supported`);
          ran.push([integrationId, name, params]);
          return { ok: true };
        },
      },
    };
  };
  const NOTIFY: CServerHandler = {
    trigger: { kind: "changed", entity: "switch.porch", to: ["member", "On"] },
    body: [
      [
        "run",
        "zwave-js.main",
        "led_notify",
        { deviceId: ["lit", "dev_porch"], color: ["lit", 0], gone: ["lit", null] },
      ],
    ],
    line: 4,
  };

  test("a firing runs the action through the host and records it on the run", async () => {
    const host = fakeHost();
    const { runtime, flip, now } = await setup({ integrations: host.integrations });
    register(runtime, [NOTIFY]);
    flip(true);
    await Bun.sleep(5);
    expect(host.ran).toEqual([
      ["zwave-js.main", "led_notify", { deviceId: "dev_porch", color: 0 }],
    ]);
    expect(runtime.runs("automation:x")).toEqual([
      {
        at: now(),
        line: 4,
        trigger: "switch.porch changed",
        calls: [],
        actions: [
          {
            integrationId: "zwave-js.main",
            action: "led_notify",
            params: { deviceId: "dev_porch", color: 0 },
          },
        ],
        armed: [],
      },
    ]);
    expect(runtime.status("automation:x")).toMatchObject({ status: "running", error: undefined });
    runtime.stop();
  });

  test("a stored automation's `run` compiles and runs end to end", async () => {
    const host = fakeHost();
    const { automations, runtime, flip } = await setup({ integrations: host.integrations });
    automations.save(
      "porch",
      'automation Porch {\n  on switch.porch changed to .On { run zwave_js.main.led_notify { effect: "pulse" } }\n}\n',
    );
    runtime.start();
    flip(true);
    await Bun.sleep(5);
    // With no integrations in the registry, the name is kept as written.
    expect(host.ran).toEqual([["zwave_js.main", "led_notify", { effect: "pulse" }]]);
    runtime.stop();
  });

  test("a failing action is recorded on the run and the registration, which keeps running", async () => {
    const host = fakeHost("led_notify");
    const { runtime, flip, sent, statuses } = await setup({ integrations: host.integrations });
    register(runtime, [
      { ...NOTIFY, body: [...NOTIFY.body, ["call", "light.hall", "turn_on", {}]] },
    ]);
    flip(true);
    await Bun.sleep(5);
    const [run] = runtime.runs("automation:x");
    expect(run?.actions[0]?.error).toBe("led_notify is not supported");
    // The failure doesn't stop the statements after it.
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    const error = "line 4: zwave-js.main led_notify failed: led_notify is not supported";
    expect(runtime.status("automation:x")).toMatchObject({ status: "running", error });
    expect(statuses().at(-1)).toEqual({
      type: "automation_status",
      automationId: "automation:x",
      status: "running",
      error,
    });
    runtime.stop();
  });

  test("with no integration host, the action fails the same way", async () => {
    const { runtime, flip } = await setup();
    register(runtime, [NOTIFY]);
    flip(true);
    await Bun.sleep(5);
    expect(runtime.runs("automation:x")[0]?.actions[0]?.error).toBe("no integrations here");
    expect(runtime.status("automation:x")?.error).toBe(
      "line 4: zwave-js.main led_notify failed: no integrations here",
    );
    runtime.stop();
  });

  test("an action run by a timer is on the timer's run", async () => {
    const host = fakeHost();
    const { runtime, flip } = await setup({ integrations: host.integrations });
    register(runtime, [{ ...NOTIFY, body: [["after", 0, NOTIFY.body]] }]);
    flip(true);
    await Bun.sleep(30);
    const runs = runtime.runs("automation:x");
    expect(runs.map((r) => [r.trigger, r.actions.length])).toEqual([
      ["after 0s", 1],
      ["switch.porch changed", 0],
    ]);
    runtime.stop();
  });
});

describe("test", () => {
  const RAIN = `automation Rain {
  on weather.home#x changed { if weather.home#x.value == "rain" { call light.hall.turn_on } }
}
`;
  /** The house with a weather entity whose `x` attribute is reported as `x`. */
  const withWeather = async (x: string) => {
    const env = await setup();
    env.registry.registerEntity("fixture", { uniqueId: "home", domain: "weather", name: "Home" });
    env.states.report(
      "fixture",
      "weather.home" as EntityId,
      { domain: "weather", condition: "clear" },
      { x },
    );
    return env;
  };

  test("nothing registered under the key is an error", async () => {
    const { runtime } = await setup();
    await expect(runtime.test("automation:nope")).rejects.toThrow(
      "Nothing is registered as automation:nope",
    );
  });

  test("a registration with no handlers is an error", async () => {
    const { runtime } = await setup();
    register(runtime, []);
    await expect(runtime.test("automation:x")).rejects.toThrow("automation:x has no handlers");
    runtime.stop();
  });

  test("with several handlers, a line is needed, and the message lists them", async () => {
    const { runtime, sent } = await setup();
    register(runtime, [ON, OFF_LATER]);
    await expect(runtime.test("automation:x")).rejects.toThrow(
      "Say which handler to test: line 2, line 3",
    );
    await expect(runtime.test("automation:x", { line: 9 })).rejects.toThrow(
      "No handler starts on line 9; try line 2, line 3",
    );
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    expect(runtime.runs("automation:x")).toEqual([]);
    runtime.stop();
  });

  test("the one handler runs with no line, logged as a test, and its run is returned", async () => {
    const { runtime, sent, now } = await setup();
    register(runtime, [ON]);
    const run = await runtime.test("automation:x");
    expect(run).toEqual({
      at: now(),
      line: 2,
      trigger: "test",
      calls: [{ entityId: "light.hall", command: { domain: "light", action: "turn_on" } }],
      actions: [],
      armed: [],
    });
    expect(runtime.runs("automation:x")).toEqual([run]);
    expect(sent).toEqual([
      {
        id: "light.hall",
        command: { domain: "light", action: "turn_on" },
        source: { kind: "automation", automationId: "automation:x" },
      },
    ]);
    runtime.stop();
  });

  test("the handler on the given line is the one that runs", async () => {
    const { runtime, sent } = await setup();
    register(runtime, [ON, OFF_LATER]);
    const run = await runtime.test("automation:x", { line: 3 });
    expect(run.line).toBe(3);
    expect(run.armed).toEqual([30]);
    expect(sent).toEqual([]);
    runtime.stop();
  });

  test("the run resolves only once its statements have run", async () => {
    const { runtime, hold } = await setup();
    register(runtime, [ON]);
    let release = () => {};
    hold(new Promise<void>((resolve) => (release = resolve)));
    let done = false;
    const testing = runtime.test("automation:x").then((run) => {
      done = true;
      return run;
    });
    await Bun.sleep(5);
    expect(done).toBe(false);
    release();
    const run = await testing;
    expect(run.calls.map((c) => c.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });

  test("a refused command is on the returned run, not thrown", async () => {
    const { runtime, refuse } = await setup();
    register(runtime, [ON]);
    refuse(new Error("not permitted"));
    const run = await runtime.test("automation:x");
    expect(run.calls[0]?.error).toBe("not permitted");
    runtime.stop();
  });

  test("a disabled automation arms nothing but can be tested", async () => {
    const { runtime, sent, flip } = await setup();
    register(runtime, [ON], { enabled: false });
    flip(true);
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    const run = await runtime.test("automation:x");
    expect(run.trigger).toBe("test");
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    expect(runtime.status("automation:x")?.status).toBe("stopped");
    runtime.stop();
  });

  test("a stored, disabled automation is testable through the store", async () => {
    const { automations, runtime, sent } = await setup();
    runtime.start();
    automations.save("hall_light", SOURCE);
    automations.setEnabled("hall_light", false);
    await runtime.test("automation:hall_light");
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });

  test("the label lists what is pretended, text quoted", async () => {
    const { runtime } = await setup();
    register(runtime, [ON]);
    const run = await runtime.test("automation:x", {
      pretend: { "sensor.x": 21, "weather.home#x": "rain", "switch.porch": true },
    });
    expect(run.trigger).toBe(
      'test, pretending sensor.x = 21, weather.home#x = "rain", switch.porch = true',
    );
    runtime.stop();
  });

  test("an empty pretend is a plain test", async () => {
    const { runtime } = await setup();
    register(runtime, [ON]);
    expect((await runtime.test("automation:x", { pretend: {} })).trigger).toBe("test");
    runtime.stop();
  });

  test("without pretending, the handler reads the house as it is", async () => {
    const { automations, runtime, sent } = await withWeather("dry");
    runtime.start();
    automations.save("rain", RAIN);
    const run = await runtime.test("automation:rain");
    expect(run.calls).toEqual([]);
    expect(sent).toEqual([]);
    runtime.stop();
  });

  test("a pretended attribute is what the handler reads, and the house is unchanged", async () => {
    const { automations, runtime, sent, states } = await withWeather("dry");
    runtime.start();
    automations.save("rain", RAIN);
    const run = await runtime.test("automation:rain", { pretend: { "weather.home#x": "rain" } });
    expect(run.calls.map((c) => c.command.action)).toEqual(["turn_on"]);
    expect(sent.map((s) => s.id)).toEqual(["light.hall"]);
    expect(states.get("weather.home" as EntityId)?.attributes).toEqual({ x: "dry" });
    // The next plain test reads the house again.
    expect((await runtime.test("automation:rain")).calls).toEqual([]);
    runtime.stop();
  });

  test("a pretended entity value is what the handler reads", async () => {
    const { automations, runtime, sent } = await setup();
    runtime.start();
    automations.save(
      "porch",
      "automation Porch {\n  every 1h { if switch.porch.value == .On { call light.hall.turn_on } }\n}\n",
    );
    expect((await runtime.test("automation:porch")).calls).toEqual([]);
    await runtime.test("automation:porch", { pretend: { "switch.porch": "On" } });
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });

  test("a timer a test arms fires later as its own run", async () => {
    const { runtime, sent } = await setup();
    register(runtime, [OFF_LATER]);
    const run = await runtime.test("automation:x");
    expect(run.armed).toEqual([30]);
    expect(sent).toEqual([]);
    await Bun.sleep(60);
    expect(sent.map((s) => s.command.action)).toEqual(["turn_off"]);
    expect(runtime.runs("automation:x").map((r) => r.trigger)).toEqual(["after 0s", "test"]);
    runtime.stop();
  });

  test("a real firing after a test cancels the test's timers, as any firing would", async () => {
    const { runtime, sent, flip } = await setup();
    register(runtime, [ON, OFF_LATER]);
    await runtime.test("automation:x", { line: 3 });
    flip(true);
    await Bun.sleep(60);
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });

  test("a test cancels the timers a real firing left", async () => {
    const { runtime, sent, flip } = await setup();
    register(runtime, [ON, OFF_LATER]);
    flip(false);
    await Bun.sleep(5);
    await runtime.test("automation:x", { line: 2 });
    await Bun.sleep(60);
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });

  test("after stop there is nothing to test", async () => {
    const { runtime } = await setup();
    register(runtime, [ON]);
    runtime.stop();
    await expect(runtime.test("automation:x")).rejects.toThrow("Nothing is registered");
  });
});

describe("triggers, now that every handler can also be tested", () => {
  test("an `every` handler fires on its schedule", async () => {
    const { runtime, sent } = await setup();
    register(runtime, [
      {
        trigger: { kind: "every", ms: 15 },
        body: [["call", "light.hall", "turn_on", {}]],
        line: 5,
      },
    ]);
    await Bun.sleep(50);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(runtime.runs("automation:x")[0]?.trigger).toStartWith("every ");
    runtime.stop();
  });

  test("a disabled `every` handler never fires", async () => {
    const { runtime, sent } = await setup();
    register(
      runtime,
      [
        {
          trigger: { kind: "every", ms: 10 },
          body: [["call", "light.hall", "turn_on", {}]],
          line: 5,
        },
      ],
      { enabled: false },
    );
    await Bun.sleep(40);
    expect(sent).toEqual([]);
    runtime.stop();
  });

  test("an `at` handler arms without firing until its time", async () => {
    const { runtime, sent } = await setup();
    register(runtime, [
      {
        trigger: { kind: "at", minutes: 7 * 60 },
        body: [["call", "light.hall", "turn_on", {}]],
        line: 6,
      },
    ]);
    expect(runtime.status("automation:x")?.status).toBe("running");
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    expect((await runtime.test("automation:x")).trigger).toBe("test");
    expect(sent.map((s) => s.command.action)).toEqual(["turn_on"]);
    runtime.stop();
  });
});
