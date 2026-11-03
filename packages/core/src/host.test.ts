import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ConfigStore, InstanceConfig, IntegrationCatalog } from "./config.ts";
import { CoreError } from "./errors.ts";
import { IntegrationHost, jsonSchemaOf } from "./host.ts";
import { CommandRouter } from "./router.ts";
import { createCore } from "./testing.ts";
import {
  type Command,
  type DeviceId,
  type DeviceSetting,
  defineIntegration,
  type EntityId,
  type IntegrationContext,
  type SettingValue,
} from "./types.ts";
import { noopLogger } from "./util.ts";

type Ctx = IntegrationContext<{ fail?: number }>;

/** A scriptable integration: counts setups, fails the first `config.fail` of them, exposes its contexts. */
function fakeIntegration(id: string) {
  const contexts: Ctx[] = [];
  const commands: Command[] = [];
  const log: string[] = [];
  const integration = defineIntegration({
    id,
    name: id,
    version: "0",
    configSchema: z.strictObject({ fail: z.number().optional() }),
    async setup(ctx) {
      contexts.push(ctx);
      log.push("setup");
      ctx.signal.addEventListener("abort", () => log.push("abort"));
      if (contexts.length <= (ctx.config.fail ?? 0))
        throw new Error(`attempt ${contexts.length} failed`);
      const light = ctx.registerEntity(
        { uniqueId: "l", domain: "light", name: `${ctx.instanceId} light` },
        async (c) => {
          commands.push(c);
        },
      );
      ctx.reportState(light.id, { domain: "light", on: false });
      ctx.registerAction("echo", z.strictObject({ text: z.string() }), async (p) =>
        p.text.toUpperCase(),
      );
      return () => void log.push("teardown");
    },
  });
  return { integration, contexts, commands, log };
}

async function setup(instances: InstanceConfig[], catalog: IntegrationCatalog) {
  const core = await createCore();
  const router = new CommandRouter({ registry: core.registry, states: core.states, bus: core.bus });
  const config = { instances: () => instances } as ConfigStore;
  const host = new IntegrationHost({
    ...core,
    router,
    config,
    integrations: catalog,
    logFor: () => noopLogger,
    timezone: "UTC",
    backoffBaseMs: 10,
    backoffMaxMs: 25,
    teardownTimeoutMs: 20,
  });
  const statuses = () =>
    core.events.flatMap((e) =>
      e.type === "integration_status" ? [`${e.integrationId}:${e.status}`] : [],
    );
  return { ...core, router, host, statuses, instances };
}

const instance = (type: string, name: string, config: unknown = {}): InstanceConfig => ({
  id: `${type}.${name}`,
  type,
  name,
  config,
});

test("two instances of one integration run side by side with their own entities", async () => {
  const fake = fakeIntegration("fake");
  const { host, registry, router } = await setup(
    [instance("fake", "one"), instance("fake", "two")],
    new Map([["fake", fake.integration]]),
  );
  await host.start();
  expect(host.list().map((i) => [i.integrationId, i.status])).toEqual([
    ["fake.one", "running"],
    ["fake.two", "running"],
  ]);
  expect(registry.listEntities().map((e) => [e.id, e.integrationId])).toEqual([
    ["light.fake_one_light", "fake.one"],
    ["light.fake_two_light", "fake.two"],
  ] as [EntityId, string][]);

  await router.send(
    "light.fake_two_light" as EntityId,
    { domain: "light", action: "turn_on" },
    { kind: "system" },
  );
  expect(fake.commands).toEqual([{ domain: "light", action: "turn_on" }]);
  await host.stop();
});

test("a failing setup is retried with doubling, capped backoff", async () => {
  const fake = fakeIntegration("fake");
  const { host, statuses, db } = await setup(
    [instance("fake", "main", { fail: 3 })],
    new Map([["fake", fake.integration]]),
  );
  const started = Date.now();
  await host.start();
  expect(host.list()[0]).toMatchObject({ status: "error", error: "attempt 1 failed" });
  expect(db.query("SELECT status, error FROM integration_status").all()).toEqual([
    { status: "error", error: "attempt 1 failed" },
  ]);

  while (host.list()[0]?.status !== "running") await Bun.sleep(2);
  // Delays of 10, 20, then 25 (capped) before the fourth attempt.
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(fake.contexts).toHaveLength(4);
  expect(fake.contexts.slice(0, 3).every((c) => c.signal.aborted)).toBe(true);
  expect(statuses()).toEqual([
    "fake.main:starting",
    "fake.main:error",
    "fake.main:starting",
    "fake.main:error",
    "fake.main:starting",
    "fake.main:error",
    "fake.main:starting",
    "fake.main:running",
  ]);
  await host.stop();
});

test("invalid config is surfaced as an error and never started", async () => {
  const fake = fakeIntegration("fake");
  const { host } = await setup(
    [{ id: "fake.main", type: "fake", name: "main", error: "integration.fake.main.fail: bad" }],
    new Map([["fake", fake.integration]]),
  );
  await host.start();
  await Bun.sleep(30);
  expect(host.list()[0]).toMatchObject({
    status: "error",
    error: "integration.fake.main.fail: bad",
  });
  expect(fake.contexts).toHaveLength(0);
});

test("reload aborts the signal, runs teardown, then sets up again; entities keep their ids", async () => {
  const fake = fakeIntegration("fake");
  const { host, states, registry, router } = await setup(
    [instance("fake", "main")],
    new Map([["fake", fake.integration]]),
  );
  await host.start();
  const id = "light.fake_main_light" as EntityId;
  const first = fake.contexts[0];

  await host.reload("fake.main");
  expect(fake.log).toEqual(["setup", "abort", "teardown", "setup"]);
  expect(first?.signal.aborted).toBe(true);
  expect(registry.listEntities()).toHaveLength(1);
  expect(states.get(id)?.available).toBe(true);

  // The unloaded context is inert: late reports are dropped, registrations throw.
  first?.reportState(id, { domain: "light", on: true });
  expect(states.get(id)?.state).toEqual({ domain: "light", on: false });
  expect(() => first?.registerDevice({ uniqueId: "x", name: "x" })).toThrow(
    "after it was unloaded",
  );

  await router.send(id, { domain: "light", action: "turn_on" }, { kind: "system" });
  await expect(fake.commands).toHaveLength(1);
  await expect(host.reload("fake.nope")).rejects.toThrow("Unknown integration instance");
  await host.stop();
});

test("stop marks entities unavailable, drops handlers, and bounds a hanging teardown", async () => {
  const hanging = defineIntegration({
    id: "hang",
    name: "hang",
    version: "0",
    configSchema: z.strictObject({}),
    async setup(ctx) {
      const e = ctx.registerEntity({ uniqueId: "s", domain: "switch", name: "S" }, async () => {});
      ctx.reportState(e.id, { domain: "switch", on: true });
      return () => new Promise<void>(() => {});
    },
  });
  const { host, states, router, statuses } = await setup(
    [instance("hang", "main")],
    new Map([["hang", hanging]]),
  );
  await host.start();
  const started = Date.now();
  await host.stop();
  expect(Date.now() - started).toBeLessThan(200);
  expect(states.get("switch.s" as EntityId)?.available).toBe(false);
  expect(router.handlerFor("switch.s" as EntityId)).toBeUndefined();
  expect(statuses().at(-1)).toBe("hang.main:stopped");
});

test("removeDevice releases its entities' handlers and is refused once unloaded", async () => {
  const fake = fakeIntegration("fake");
  const { host, registry, router } = await setup(
    [instance("fake", "main")],
    new Map([["fake", fake.integration]]),
  );
  await host.start();
  const ctx = fake.contexts[0] as Ctx;
  const device = ctx.registerDevice({ uniqueId: "d", name: "Strip" });
  const a = ctx.registerEntity(
    { uniqueId: "a", domain: "switch", name: "A", deviceId: device.id },
    async () => {},
  );
  const b = ctx.registerEntity(
    { uniqueId: "b", domain: "switch", name: "B", deviceId: device.id },
    async () => {},
  );
  expect(router.handlerFor(a.id)).toBeDefined();

  ctx.removeDevice(device.id);
  expect(router.handlerFor(a.id)).toBeUndefined();
  expect(router.handlerFor(b.id)).toBeUndefined();
  // The instance's device-less entity keeps its handler.
  expect(router.handlerFor("light.fake_main_light" as EntityId)).toBeDefined();

  const kept = ctx.registerDevice({ uniqueId: "k", name: "Kept" });
  await host.reload("fake.main");
  expect(() => ctx.removeDevice(kept.id)).toThrow("after it was unloaded");
  expect(registry.getDevice(kept.id)).toBeDefined();
  await host.stop();
});

test("reporting state for another instance's entity throws", async () => {
  const fake = fakeIntegration("fake");
  const { host } = await setup(
    [instance("fake", "one"), instance("fake", "two")],
    new Map([["fake", fake.integration]]),
  );
  await host.start();
  const one = fake.contexts.find((c) => c.instanceId === "fake.one");
  expect(() =>
    one?.reportState("light.fake_two_light" as EntityId, { domain: "light", on: true }),
  ).toThrow("fake.one did not register light.fake_two_light");
  await host.stop();
});

test("actions validate their parameters and run only while the instance is running", async () => {
  const fake = fakeIntegration("fake");
  const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
  await host.start();
  await expect(await host.runAction("fake.main", "echo", { text: "hi" })).toBe("HI");
  await expect(host.runAction("fake.main", "echo", { text: 1 })).rejects.toThrow(
    "Invalid parameters for echo: text",
  );
  await expect(host.runAction("fake.main", "nope", {})).rejects.toThrow('no action "nope"');
  expect(host.list()[0]?.actions.map((a) => a.name)).toEqual(["echo"]);
  await host.stop();
  await expect(host.runAction("fake.main", "echo", { text: "hi" })).rejects.toThrow("no action");
});

test("entities of instances missing from config are orphaned at start; handlers follow a rename", async () => {
  const fake = fakeIntegration("fake");
  const { host, registry, router } = await setup(
    [instance("fake", "main")],
    new Map([["fake", fake.integration]]),
  );
  const stale = registry.registerEntity("gone.main", {
    uniqueId: "x",
    domain: "switch",
    name: "Stale",
  });
  await host.start();
  expect(registry.getEntity(stale.id)?.orphaned).toBe(true);

  const renamed = registry.renameEntity(
    "light.fake_main_light" as EntityId,
    "light.desk" as EntityId,
  );
  await router.send(renamed.id, { domain: "light", action: "turn_off" }, { kind: "system" });
  expect(fake.commands).toEqual([{ domain: "light", action: "turn_off" }]);
  await host.stop();
});

type SettingsCtx = IntegrationContext<{ settings?: boolean }>;

/**
 * Registers one device per instance and, unless `config.settings` is false, a provider for its
 * settings. Setup waits on `gate` after providing, so a test can look while it is starting.
 */
function settingsIntegration(id: string, gate?: Promise<void>) {
  const contexts: SettingsCtx[] = [];
  const sets: [DeviceId, string, SettingValue][] = [];
  let listed = 0;
  const settings: DeviceSetting[] = [
    { key: "12", label: "Auto off", type: "number", value: 0, min: 0, max: 100 },
    { key: "52", label: "Indicator", type: "boolean", value: false },
    {
      key: "22",
      label: "Switch type",
      type: "enum",
      value: 0,
      options: [
        { value: 0, label: "Single pole" },
        { value: 2, label: "Three way" },
      ],
    },
  ];
  const integration = defineIntegration({
    id,
    name: id,
    version: "0",
    configSchema: z.strictObject({ settings: z.boolean().optional() }),
    async setup(ctx) {
      contexts.push(ctx);
      ctx.registerDevice({ uniqueId: "d", name: `${ctx.instanceId} dimmer` });
      if (ctx.config.settings !== false)
        ctx.provideDeviceSettings({
          list: () => {
            listed++;
            return settings;
          },
          set: async (deviceId, key, value) => {
            if (value === 99) throw new Error("the device refused the value");
            sets.push([deviceId, key, value]);
          },
        });
      await gate;
    },
  });
  return { integration, contexts, sets, listed: () => listed };
}

describe("device settings", () => {
  const deviceOf = (
    registry: { listDevices(): { id: DeviceId; integrationId: string }[] },
    id: string,
  ) => registry.listDevices().find((d) => d.integrationId === id)?.id as DeviceId;

  test("lists a running instance's device settings from its provider", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const settings = await host.deviceSettings(deviceOf(registry, "fake.main"));
    expect(settings.map((s) => s.key)).toEqual(["12", "52", "22"]);
    await host.stop();
  });

  test("a provider's own failure is unavailable, with its message", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const failure = await host
      .setDeviceSetting(deviceOf(registry, "fake.main"), "12", 99)
      .catch((err: CoreError) => err);
    expect(failure).toBeInstanceOf(CoreError);
    expect(failure).toMatchObject({
      code: "unavailable",
      message: "the device refused the value",
    });
    await host.stop();
  });

  test("an unknown device is not_found", async () => {
    const fake = settingsIntegration("fake");
    const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
    await host.start();
    await expect(host.deviceSettings("nope" as DeviceId)).rejects.toMatchObject({
      code: "not_found",
      message: "Unknown device nope",
    });
    await expect(host.setDeviceSetting("nope" as DeviceId, "12", 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await host.stop();
  });

  test("a device whose instance is not loaded is unavailable", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    const stale = registry.registerDevice("gone.main", { uniqueId: "x", name: "Stale" });
    await host.start();
    expect(registry.getDevice(stale.id)?.orphaned).toBe(true);
    await expect(host.deviceSettings(stale.id)).rejects.toMatchObject({
      code: "unavailable",
      message: "gone.main is not loaded",
    });
    await expect(host.setDeviceSetting(stale.id, "12", 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    await host.stop();
  });

  test("an orphaned device is unavailable even while its instance id is loaded again", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    registry.markOrphans(new Set());
    expect(registry.getDevice(device)?.orphaned).toBe(true);
    await expect(host.deviceSettings(device)).rejects.toMatchObject({ code: "unavailable" });
    await host.stop();
  });

  test("an instance that is still starting is unavailable, without asking its provider", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = settingsIntegration("fake", gate);
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    const started = host.start();
    while (!fake.contexts.length) await Bun.sleep(1);
    expect(host.list()[0]?.status).toBe("starting");
    const device = deviceOf(registry, "fake.main");
    await expect(host.deviceSettings(device)).rejects.toMatchObject({
      code: "unavailable",
      message: "fake.main is not running",
    });
    await expect(host.setDeviceSetting(device, "12", 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fake.listed()).toBe(0);
    expect(fake.sets).toEqual([]);
    release();
    await started;
    expect(await host.deviceSettings(device)).toHaveLength(3);
    await host.stop();
  });

  test("an instance with no provider has no settings, and setting one is not_found", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main", { settings: false })],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    expect(await host.deviceSettings(device)).toEqual([]);
    await expect(host.setDeviceSetting(device, "12", 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await host.stop();
  });

  test("an unknown key is not_found and nothing is sent", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    await expect(host.setDeviceSetting(device, "999", 1)).rejects.toMatchObject({
      code: "not_found",
      message: `${device} has no setting "999"`,
    });
    expect(fake.sets).toEqual([]);
    await host.stop();
  });

  test("a value that does not fit is refused before the provider is asked to send it", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    await expect(host.setDeviceSetting(device, "12", 101)).rejects.toMatchObject({
      code: "invalid",
      message: "Auto off is at most 100",
    });
    await expect(host.setDeviceSetting(device, "52", 1)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(host.setDeviceSetting(device, "22", 1)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(fake.sets).toEqual([]);
    await host.stop();
  });

  test("the provider is sent the checked value, and that value is returned", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    expect(await host.setDeviceSetting(device, "12", "40")).toBe(40);
    expect(await host.setDeviceSetting(device, "22", "three way")).toBe(2);
    expect(await host.setDeviceSetting(device, "52", true)).toBe(true);
    expect(fake.sets).toEqual([
      [device, "12", 40],
      [device, "22", 2],
      [device, "52", true],
    ]);
    await host.stop();
  });

  test("list reports which instances keep device settings", async () => {
    const fake = settingsIntegration("fake");
    const { host } = await setup(
      [instance("fake", "one"), instance("fake", "two", { settings: false })],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    expect(host.list().map((i) => [i.integrationId, i.deviceSettings])).toEqual([
      ["fake.one", true],
      ["fake.two", false],
    ]);
    await host.stop();
  });

  test("a reload drops the provider; it is back only if the new setup provides one", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry, instances } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    expect(host.list()[0]?.deviceSettings).toBe(true);

    instances[0] = instance("fake", "main", { settings: false });
    await host.reload("fake.main");
    expect(host.list()[0]?.deviceSettings).toBe(false);
    expect(await host.deviceSettings(device)).toEqual([]);
    await host.stop();
  });

  test("stop drops the provider", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry } = await setup(
      [instance("fake", "main")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const device = deviceOf(registry, "fake.main");
    await host.stop();
    expect(host.list()[0]?.deviceSettings).toBe(false);
    await expect(host.setDeviceSetting(device, "12", 1)).rejects.toThrow();
    expect(fake.listed()).toBe(0);
    expect(fake.sets).toEqual([]);
  });

  test("provideDeviceSettings is refused once the instance is unloaded", async () => {
    const fake = settingsIntegration("fake");
    const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
    await host.start();
    const first = fake.contexts[0] as SettingsCtx;
    await host.reload("fake.main");
    expect(() => first.provideDeviceSettings({ list: () => [], set: async () => {} })).toThrow(
      "after it was unloaded",
    );
    await host.stop();
  });

  test("settingsChanged announces only the instance's own devices, and nothing once unloaded", async () => {
    const fake = settingsIntegration("fake");
    const { host, registry, events } = await setup(
      [instance("fake", "one"), instance("fake", "two")],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const changes = () => events.filter((e) => e.type === "settings_changed");
    const one = fake.contexts.find((c) => c.instanceId === "fake.one") as SettingsCtx;
    const mine = deviceOf(registry, "fake.one");
    const theirs = deviceOf(registry, "fake.two");

    one.settingsChanged(mine);
    one.settingsChanged(theirs);
    one.settingsChanged("nope" as DeviceId);
    expect(changes()).toEqual([{ type: "settings_changed", deviceId: mine }]);

    await host.reload("fake.one");
    one.settingsChanged(mine);
    expect(changes()).toHaveLength(1);
    await host.stop();
  });

  // Bug: setDeviceSetting looks the provider up again after awaiting list(); if the instance
  // stopped meanwhile, `provider?.set` is skipped and the value is returned as though sent.
  test("a setting is not reported as sent when the instance stops while it is checked", async () => {
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const sets: SettingValue[] = [];
    const slow = defineIntegration({
      id: "slow",
      name: "slow",
      version: "0",
      configSchema: z.strictObject({}),
      async setup(ctx) {
        ctx.registerDevice({ uniqueId: "d", name: "Dimmer" });
        ctx.provideDeviceSettings({
          list: async () => {
            await blocked;
            return [{ key: "12", label: "Auto off", type: "number", value: 0 }];
          },
          set: async (_device, _key, value) => {
            sets.push(value);
          },
        });
      },
    });
    const { host, registry } = await setup([instance("slow", "main")], new Map([["slow", slow]]));
    await host.start();
    const pending = host.setDeviceSetting(deviceOf(registry, "slow.main"), "12", 5);
    await host.stop();
    unblock();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(sets).toEqual([]);
  });
});

describe("runnable", () => {
  test("lists every configured instance before start, with no actions yet", async () => {
    const fake = fakeIntegration("fake");
    const { host } = await setup(
      [instance("fake", "one"), instance("fake", "two")],
      new Map([["fake", fake.integration]]),
    );
    expect(host.runnable()).toEqual([{ id: "fake.one" }, { id: "fake.two" }]);
  });

  test("a running instance lists its actions with their parameters as JSON Schema", async () => {
    const fake = fakeIntegration("fake");
    const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
    await host.start();
    expect(host.runnable()).toEqual([
      {
        id: "fake.main",
        actions: [
          {
            name: "echo",
            schema: expect.objectContaining({
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            }),
          },
        ],
      },
    ]);
    await host.stop();
  });

  test("an instance in error is listed without actions", async () => {
    const fake = fakeIntegration("fake");
    const { host } = await setup(
      [instance("fake", "ok"), instance("fake", "bad", { fail: 99 })],
      new Map([["fake", fake.integration]]),
    );
    await host.start();
    const byId = Object.fromEntries(host.runnable().map((r) => [r.id, r]));
    expect(byId["fake.bad"]).toEqual({ id: "fake.bad" });
    expect(byId["fake.ok"]?.actions?.map((a) => a.name)).toEqual(["echo"]);
    await host.stop();
  });

  test("a stopped instance is listed without actions", async () => {
    const fake = fakeIntegration("fake");
    const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
    await host.start();
    await host.stop();
    expect(host.runnable()).toEqual([{ id: "fake.main" }]);
  });

  test("an instance is listed once, configured and loaded", async () => {
    const fake = fakeIntegration("fake");
    const { host } = await setup([instance("fake", "main")], new Map([["fake", fake.integration]]));
    await host.start();
    expect(host.runnable().map((r) => r.id)).toEqual(["fake.main"]);
    await host.stop();
  });

  test("with nothing configured, nothing is runnable", async () => {
    const { host } = await setup([], new Map());
    expect(host.runnable()).toEqual([]);
  });
});

describe("jsonSchemaOf", () => {
  test("describes the input a caller writes: optional fields aren't required, defaults optional", () => {
    const schema = jsonSchemaOf(
      z.strictObject({
        deviceId: z.string(),
        color: z.number().int().optional(),
        effect: z.enum(["pulse", "solid"]).default("pulse"),
      }),
    );
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        deviceId: { type: "string" },
        color: { type: "integer" },
        effect: { type: "string", enum: ["pulse", "solid"] },
      },
      required: ["deviceId"],
      additionalProperties: false,
    });
  });

  test("what JSON Schema can't say is anything, not a throw", () => {
    const schema = jsonSchemaOf(z.object({ when: z.date(), n: z.bigint() }));
    expect(schema).toMatchObject({ type: "object", properties: { when: {}, n: {} } });
  });

  test("a schema it can't read at all is `{}`", () => {
    expect(jsonSchemaOf({} as z.ZodType)).toEqual({});
  });
});
