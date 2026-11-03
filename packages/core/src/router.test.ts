import { expect, test } from "bun:test";
import { Bus } from "./bus.ts";
import { CommandError, CommandRouter } from "./router.ts";
import type {
  AreaId,
  Capabilities,
  Command,
  CommandSource,
  CoreEvent,
  Domain,
  Entity,
  EntityId,
  EntityState,
  StateRecord,
} from "./types.ts";

const source: CommandSource = { kind: "system" };

function setup(
  opts: {
    handlerTimeoutMs?: number;
    confirmTimeoutMs?: number;
    confirmTimeoutsMs?: Partial<Record<Domain, number>>;
  } = {},
) {
  const bus = new Bus();
  const events: CoreEvent[] = [];
  bus.onAny((e) => events.push(e));
  const entities = new Map<EntityId, Entity>();
  const records = new Map<EntityId, StateRecord>();
  const areas = new Map<EntityId, AreaId>();
  const aliases = new Map<EntityId, EntityId>();
  const router = new CommandRouter({
    bus,
    registry: {
      getEntity: (id) => entities.get(id),
      entitiesInArea: (areaId) => [...entities.values()].filter((e) => areas.get(e.id) === areaId),
      aliasTarget: (id) => aliases.get(id),
    },
    states: { get: (id) => records.get(id) },
    ...opts,
  });

  const sent: Command[] = [];
  function report(id: EntityId, state: EntityState, available = true) {
    const old = records.get(id);
    const record: StateRecord = { entityId: id, state, available, changedAt: 0, updatedAt: 0 };
    records.set(id, record);
    bus.emit({ type: "state_changed", entityId: id, old, new: record });
  }
  function add(
    name: string,
    state: EntityState,
    capabilities: Capabilities = {},
    extra: Partial<Entity> & { handler?: false; areaId?: AreaId } = {},
  ): EntityId {
    const id = `${state.domain}.${name}` as EntityId;
    const { handler, ...rest } = extra;
    entities.set(id, {
      id,
      uniqueId: id,
      domain: state.domain as Domain,
      integrationId: "demo.main",
      name,
      capabilities,
      ...rest,
    });
    if (extra.areaId) areas.set(id, extra.areaId);
    report(id, state);
    if (handler !== false) {
      router.registerHandler(id, async (command) => {
        sent.push(command);
      });
    }
    return id;
  }
  return { router, bus, events, sent, add, report, aliases, records };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    return err instanceof CommandError ? err.code : `not a CommandError: ${err}`;
  }
}

// ───────── error codes ─────────

test("not_found, with a rename hint when the id is an alias", async () => {
  const { router, aliases } = setup();
  const id = "light.old" as EntityId;
  const cmd: Command = { domain: "light", action: "turn_on" };
  expect(await codeOf(router.send(id, cmd, source))).toBe("not_found");
  aliases.set(id, "light.new" as EntityId);
  await expect(router.send(id, cmd, source)).rejects.toThrow("light.old was renamed to light.new");
});

test("disabled", async () => {
  const { router, add } = setup();
  const id = add("a", { domain: "switch", on: false }, {}, { disabled: true });
  expect(await codeOf(router.send(id, { domain: "switch", action: "turn_on" }, source))).toBe(
    "disabled",
  );
});

test("domain_mismatch", async () => {
  const { router, add } = setup();
  const id = add("a", { domain: "switch", on: false });
  expect(await codeOf(router.send(id, { domain: "light", action: "turn_on" }, source))).toBe(
    "domain_mismatch",
  );
});

test("unavailable: no state yet, or reported unavailable", async () => {
  const { router, add, report, records } = setup();
  const id = add("a", { domain: "switch", on: false });
  report(id, { domain: "switch", on: false }, false);
  expect(await codeOf(router.send(id, { domain: "switch", action: "turn_on" }, source))).toBe(
    "unavailable",
  );
  records.delete(id);
  expect(await codeOf(router.send(id, { domain: "switch", action: "turn_on" }, source))).toBe(
    "unavailable",
  );
});

test("unsupported: missing capability, or a read-only entity", async () => {
  const { router, add } = setup();
  const light = add("a", { domain: "light", on: false });
  const on = { domain: "light", action: "turn_on" } as const;
  expect(await codeOf(router.send(light, { ...on, brightness: 0.5 }, source))).toBe("unsupported");
  expect(await codeOf(router.send(light, { ...on, colorTempK: 3000 }, source))).toBe("unsupported");
  expect(await codeOf(router.send(light, { ...on, rgb: [1, 2, 3] }, source))).toBe("unsupported");
  const cover = add("c", { domain: "cover", motion: "stopped" });
  expect(
    await codeOf(
      router.send(cover, { domain: "cover", action: "set_position", position: 1 }, source),
    ),
  ).toBe("unsupported");
  const readOnly = add("ro", { domain: "switch", on: false }, {}, { handler: false });
  expect(await codeOf(router.send(readOnly, { domain: "switch", action: "turn_on" }, source))).toBe(
    "unsupported",
  );
});

test("invalid", async () => {
  const { router, add } = setup();
  const light = add("a", { domain: "light", on: false }, { rgb: true });
  expect(
    await codeOf(
      router.send(light, { domain: "light", action: "turn_on", rgb: [0, 256, 0] }, source),
    ),
  ).toBe("invalid");
  const climate = add("t", { domain: "climate", mode: "heat" });
  expect(
    await codeOf(
      router.send(climate, { domain: "climate", action: "set_target", temp: Number.NaN }, source),
    ),
  ).toBe("invalid");
});

test("forbidden: a policy that rejects, and sees the normalized command and source", async () => {
  const { router, add, sent } = setup();
  const id = add("front", { domain: "lock", locked: true });
  const seen: unknown[] = [];
  router.use((ctx) => {
    seen.push([ctx.entity.id, ctx.command, ctx.source, ctx.state.state]);
    if (
      ctx.command.domain === "lock" &&
      ctx.command.action === "unlock" &&
      ctx.source.kind === "automation"
    ) {
      throw new CommandError("forbidden", "Automations may not unlock");
    }
  });
  const unlock: Command = { domain: "lock", action: "unlock" };
  expect(await codeOf(router.send(id, unlock, { kind: "automation", automationId: "x" }))).toBe(
    "forbidden",
  );
  expect(sent).toEqual([]);
  expect(await codeOf(router.send(id, unlock, source))).toBe("resolved");
  expect(seen[1]).toEqual([id, unlock, source, { domain: "lock", locked: true }]);
});

test("timeout and failed emit command_failed; a failing handler keeps its message", async () => {
  const { router, add, events } = setup({ handlerTimeoutMs: 10 });
  const slow = add("slow", { domain: "switch", on: false }, {}, { handler: false });
  router.registerHandler(slow, () => new Promise(() => {}));
  const broken = add("broken", { domain: "switch", on: false }, {}, { handler: false });
  router.registerHandler(broken, async () => {
    throw new Error("Broker is offline");
  });
  const cmd: Command = { domain: "switch", action: "turn_on" };
  expect(await codeOf(router.send(slow, cmd, source))).toBe("timeout");
  expect(await codeOf(router.send(broken, cmd, source))).toBe("failed");
  expect(events.filter((e) => e.type === "command_failed")).toMatchObject([
    { entityId: slow, code: "timeout", source },
    { entityId: broken, code: "failed", error: "Broker is offline" },
  ]);
});

// ───────── queueing ─────────

test("latest wins: a waiting command is superseded, the running one finishes, order holds", async () => {
  const { router, add } = setup();
  const id = add("a", { domain: "light", on: false }, { brightness: true }, { handler: false });
  const started: number[] = [];
  const gates: Array<() => void> = [];
  router.registerHandler(id, (command) => {
    if (command.domain === "light" && command.action === "turn_on")
      started.push(command.brightness ?? -1);
    return new Promise((resolve) => gates.push(resolve));
  });
  const send = (brightness: number) =>
    codeOf(router.send(id, { domain: "light", action: "turn_on", brightness }, source));

  const first = send(0.1);
  const second = send(0.2);
  const third = send(0.3);
  expect(await second).toBe("superseded");
  expect(started).toEqual([0.1]);
  gates[0]?.();
  expect(await first).toBe("resolved");
  await Bun.sleep(0);
  expect(started).toEqual([0.1, 0.3]);
  gates[1]?.();
  expect(await third).toBe("resolved");
});

test("entities queue independently", async () => {
  const { router, add, sent } = setup();
  const a = add("a", { domain: "switch", on: false }, {}, { handler: false });
  router.registerHandler(a, () => new Promise(() => {}));
  const b = add("b", { domain: "switch", on: false });
  // `a` never answers, so its command times out ten seconds on, long after this test; caught, so
  // the rejection is not blamed on whichever test is running by then.
  router.send(a, { domain: "switch", action: "turn_on" }, source).catch(() => {});
  await router.send(b, { domain: "switch", action: "turn_on" }, source);
  expect(sent).toHaveLength(1);
});

// ───────── confirmation ─────────

test("confirm resolves confirmed on a matching report, unconfirmed on timeout, sent without confirm", async () => {
  const { router, add, report } = setup({ confirmTimeoutMs: 20 });
  const id = add("a", { domain: "light", on: false }, { brightness: true }, { handler: false });
  let echo = true;
  router.registerHandler(id, async (command) => {
    if (!echo || command.domain !== "light" || command.action !== "turn_on") return;
    // A fast device: the report lands before the handler resolves.
    report(id, { domain: "light", on: true, brightness: (command.brightness ?? 1) + 0.01 });
  });
  const cmd: Command = { domain: "light", action: "turn_on", brightness: 0.5 };

  expect((await router.send(id, cmd, source)).status).toBe("sent");
  expect((await router.send(id, cmd, source, { confirm: true })).status).toBe("confirmed");
  echo = false;
  const pending = router.send(id, cmd, source, { confirm: true });
  report(id, { domain: "light", on: true, brightness: 0.9 }); // not what was asked for
  expect((await pending).status).toBe("unconfirmed");
});

test("a cover waits its domain's confirm timeout, not the default", async () => {
  const { router, add, report } = setup({ confirmTimeoutMs: 20, confirmTimeoutsMs: { cover: 80 } });
  const id = add(
    "garage",
    { domain: "cover", motion: "stopped", position: 0 },
    {},
    { handler: false },
  );
  // Like a garage opener: it warns for a while, then reports motion well after the default window.
  router.registerHandler(id, async () => {
    setTimeout(() => report(id, { domain: "cover", motion: "opening", position: 0 }), 40);
  });
  const cmd: Command = { domain: "cover", action: "open" };

  expect((await router.send(id, cmd, source, { confirm: true })).status).toBe("confirmed");

  // No report at all: unconfirmed once the override runs out.
  router.registerHandler(id, async () => {});
  expect((await router.send(id, cmd, source, { confirm: true })).status).toBe("unconfirmed");
});

test("covers default to a long confirm timeout; other domains keep confirmTimeoutMs", async () => {
  const { router, add, report } = setup({ confirmTimeoutMs: 20 });
  const light = add("l", { domain: "light", on: false }, {}, { handler: false });
  const cover = add(
    "c",
    { domain: "cover", motion: "stopped", position: 0 },
    {},
    { handler: false },
  );
  router.registerHandler(light, async () => {});
  router.registerHandler(cover, async () => {});

  const result = await router.send(light, { domain: "light", action: "turn_on" }, source, {
    confirm: true,
  });
  expect(result.status).toBe("unconfirmed");

  // The cover's 10 s default is still waiting well after the light's window closed...
  let settled = false;
  const pending = router.send(cover, { domain: "cover", action: "open" }, source, {
    confirm: true,
  });
  pending.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 60));
  expect(settled).toBe(false);
  // ...and a matching report settles it, so the test does not sit out the 10 s.
  report(cover, { domain: "cover", motion: "opening", position: 0 });
  expect((await pending).status).toBe("confirmed");
});

test("a caller's override for another domain applies to it and keeps the cover default", async () => {
  const { router, add, report } = setup({ confirmTimeoutMs: 20, confirmTimeoutsMs: { lock: 80 } });
  const lock = add("front", { domain: "lock", locked: false }, {}, { handler: false });
  const cover = add(
    "c",
    { domain: "cover", motion: "stopped", position: 0 },
    {},
    { handler: false },
  );
  // A slow deadbolt: it reports locked after the default window but inside its override.
  router.registerHandler(lock, async () => {
    setTimeout(() => report(lock, { domain: "lock", locked: true }), 40);
  });
  router.registerHandler(cover, async () => {});

  const locked = await router.send(lock, { domain: "lock", action: "lock" }, source, {
    confirm: true,
  });
  expect(locked.status).toBe("confirmed");

  // Passing { lock } merges with the defaults rather than replacing them: the cover still waits.
  let settled = false;
  const pending = router.send(cover, { domain: "cover", action: "open" }, source, {
    confirm: true,
  });
  pending.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 60));
  expect(settled).toBe(false);
  report(cover, { domain: "cover", motion: "opening", position: 0 });
  expect((await pending).status).toBe("confirmed");
});

test("button.press needs only availability and confirms on the next press report", async () => {
  const { router, add, report, sent } = setup({ confirmTimeoutMs: 20 });
  const id = add("doorbell", { domain: "button" }, {}, { handler: false });
  router.registerHandler(id, async (command) => {
    sent.push(command);
    report(id, { domain: "button", pressedAt: 123 });
  });
  const result = await router.send(id, { domain: "button", action: "press" }, source, {
    confirm: true,
  });
  expect(result).toMatchObject({
    status: "confirmed",
    command: { domain: "button", action: "press" },
  });
  report(id, { domain: "button", pressedAt: 123 }, false);
  expect(await codeOf(router.send(id, { domain: "button", action: "press" }, source))).toBe(
    "unavailable",
  );
});

// ───────── normalization ─────────

const fullLight: Capabilities = {
  brightness: true,
  transition: true,
  colorTemp: { minK: 2000, maxK: 6500 },
};

test.each<[string, EntityState, Capabilities, Command, Command]>([
  [
    "toggle when on",
    { domain: "switch", on: true },
    {},
    { domain: "switch", action: "toggle" },
    { domain: "switch", action: "turn_off" },
  ],
  [
    "toggle when off",
    { domain: "switch", on: false },
    {},
    { domain: "switch", action: "toggle" },
    { domain: "switch", action: "turn_on" },
  ],
  [
    "brightness 0 turns off",
    { domain: "light", on: true },
    fullLight,
    { domain: "light", action: "turn_on", brightness: 0, transitionMs: 300 },
    { domain: "light", action: "turn_off", transitionMs: 300 },
  ],
  [
    "brightness clamps to 1",
    { domain: "light", on: true },
    fullLight,
    { domain: "light", action: "turn_on", brightness: 1.7 },
    { domain: "light", action: "turn_on", brightness: 1 },
  ],
  [
    "color temperature clamps to range",
    { domain: "light", on: true },
    fullLight,
    { domain: "light", action: "turn_on", colorTempK: 9000 },
    { domain: "light", action: "turn_on", colorTempK: 6500 },
  ],
  [
    "transition stripped on turn_on",
    { domain: "light", on: true },
    { brightness: true },
    { domain: "light", action: "turn_on", brightness: 0.4, transitionMs: 500 },
    { domain: "light", action: "turn_on", brightness: 0.4 },
  ],
  [
    "transition stripped on turn_off",
    { domain: "light", on: true },
    {},
    { domain: "light", action: "turn_off", transitionMs: 500 },
    { domain: "light", action: "turn_off" },
  ],
  [
    "cover position clamps",
    { domain: "cover", motion: "stopped" },
    { position: true },
    { domain: "cover", action: "set_position", position: -2 },
    { domain: "cover", action: "set_position", position: 0 },
  ],
  [
    "target snaps to step then clamps",
    { domain: "climate", mode: "heat" },
    { tempRange: { min: 10, max: 30, step: 0.5 } },
    { domain: "climate", action: "set_target", temp: 21.3 },
    { domain: "climate", action: "set_target", temp: 21.5 },
  ],
  [
    "target clamps to max",
    { domain: "climate", mode: "heat" },
    { tempRange: { min: 10, max: 30, step: 0.5 } },
    { domain: "climate", action: "set_target", temp: 45 },
    { domain: "climate", action: "set_target", temp: 30 },
  ],
])("normalize: %s", async (_name, state, capabilities, command, expected) => {
  const { router, add, sent } = setup();
  const id = add("a", state, capabilities);
  const result = await router.send(id, command, source);
  expect(JSON.parse(JSON.stringify(result.command))).toEqual(expected);
  expect(JSON.parse(JSON.stringify(sent))).toEqual([expected]);
});

// ───────── area fan-out ─────────

test("sendToArea targets matching, enabled entities and reports per-entity failures", async () => {
  const { router, add, report, sent } = setup();
  const areaId = "kitchen" as AreaId;
  add("a", { domain: "light", on: false }, {}, { areaId });
  const down = add("b", { domain: "light", on: false }, {}, { areaId });
  report(down, { domain: "light", on: false }, false);
  add("c", { domain: "light", on: false }, {}, { areaId, disabled: true });
  add("d", { domain: "switch", on: false }, {}, { areaId });
  add("e", { domain: "light", on: false }, {}, { areaId: "hall" as AreaId });

  const results = await router.sendToArea(areaId, { domain: "light", action: "turn_on" }, source);
  expect(results).toMatchObject([
    { entityId: "light.a", result: { status: "sent" } },
    { entityId: down, error: { code: "unavailable" } },
  ]);
  expect(sent).toHaveLength(1);
});
