import { describe, expect, test } from "bun:test";
import type { Area, Device, Entity, StateRecord } from "../types.ts";
import { compile } from "./compile.ts";
import type { CExpr } from "./compiled.ts";
import { clock, type Env, evaluate, evaluateWithDeps, stateValue } from "./eval.ts";
import { REGISTRY } from "./fixtures.ts";
import { commandOf, paramsOf, run } from "./run.ts";
import { type Host, isUnavailable, UNAVAILABLE, type Value } from "./values.ts";

// ───────── a house ─────────

const entity = (id: string, extra: Partial<Entity> = {}): Entity =>
  ({
    id,
    uniqueId: id,
    domain: id.split(".")[0],
    integrationId: "test",
    name: id.split(".")[1],
    capabilities: {},
    ...extra,
  }) as Entity;

const record = (
  id: string,
  state: StateRecord["state"],
  extra: Partial<StateRecord> = {},
): StateRecord =>
  ({
    entityId: id,
    state,
    available: true,
    changedAt: 1000,
    updatedAt: 2000,
    ...extra,
  }) as StateRecord;

function house(overrides: Partial<Host> = {}): Host & { states: Map<string, StateRecord> } {
  const entities: Entity[] = [
    entity("sensor.living_temp", {
      deviceId: "dev_thermostat" as Entity["deviceId"],
      capabilities: {},
    }),
    entity("sensor.outside", { areaId: "garage" as Entity["areaId"] }),
    entity("light.hall", {
      areaId: "hall" as Entity["areaId"],
      capabilities: { brightness: true },
    }),
    entity("light.living_lamp", { deviceId: "dev_lamp" as Entity["deviceId"] }),
    entity("switch.porch", { deviceId: "dev_porch" as Entity["deviceId"], hidden: true }),
    entity("lock.front", { areaId: "hall" as Entity["areaId"] }),
    entity("cover.garage", { areaId: "garage" as Entity["areaId"] }),
    entity("climate.living", { deviceId: "dev_thermostat" as Entity["deviceId"] }),
  ];
  const devices = [
    {
      id: "dev_thermostat",
      name: "Thermostat",
      areaId: "living",
      manufacturer: "Acme",
      integrationId: "acme.home",
    },
    { id: "dev_lamp", name: "Lamp", areaId: "living", integrationId: "hue.home", icon: "lamp" },
    { id: "dev_porch", name: "Porch switch", areaId: "hall", integrationId: "rachio.yard" },
  ] as unknown as Device[];
  const areas = [
    { id: "living", name: "Living room" },
    { id: "hall", name: "Hall" },
    { id: "garage", name: "Garage" },
  ] as unknown as Area[];
  const states = new Map<string, StateRecord>([
    [
      "sensor.living_temp",
      record("sensor.living_temp", { domain: "sensor", value: 21.5, unit: "°C" }),
    ],
    [
      "sensor.outside",
      record("sensor.outside", { domain: "sensor", value: 9 }, { attributes: { humidity: 70 } }),
    ],
    ["light.hall", record("light.hall", { domain: "light", on: true, brightness: 0.4 })],
    ["light.living_lamp", record("light.living_lamp", { domain: "light", on: false })],
    ["switch.porch", record("switch.porch", { domain: "switch", on: false }, { available: false })],
    ["lock.front", record("lock.front", { domain: "lock", locked: true })],
    ["cover.garage", record("cover.garage", { domain: "cover", position: 0, motion: "stopped" })],
    [
      "climate.living",
      record("climate.living", { domain: "climate", mode: "heat", targetTemp: 22 }),
    ],
  ]);
  return {
    states,
    state: (id) => states.get(id),
    entity: (id) => entities.find((e) => e.id === id),
    entities: () => entities,
    devices: () => devices,
    areas: () => areas,
    screen: () => "Desktop",
    now: () => Date.UTC(2026, 9, 7, 12, 30),
    timezone: "UTC",
    present: (e, r) => `${e.id}:${r ? JSON.stringify(r.state) : "none"}`,
    unit: (_e, r) => (r?.state.domain === "sensor" ? (r.state.unit ?? null) : null),
    ago: (ms, now) => `${Math.round((now - ms) / 60_000)} min ago`,
    when: (ms, format) => `${format}:${ms}`,
    format: (x, places) => x.toFixed(places),
    ...overrides,
  };
}

/** Compiles one expression as a state initialiser, with `vars` declared before it, and returns its code. */
function code(source: string, vars: string[] = []): CExpr {
  const declared = vars.map((name) => `state ${name} = 0\n`).join("");
  const result = compile({
    source: `page P {\n${declared}state v = ${source}\nCard { } }`,
    registry: REGISTRY,
  });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  const init = result.page?.state.find((s) => s.name === "v")?.init;
  if (!init) throw new Error("no expression");
  return init;
}

const env = (host: Host, vars: Record<string, Value> = {}): Env => ({
  host,
  vars: new Map(Object.entries(vars)),
});
const ev = (source: string, host = house(), vars: Record<string, Value> = {}) =>
  evaluate(code(source, Object.keys(vars)), env(host, vars));

describe("state as a value", () => {
  test("each domain reads as one value", () => {
    expect(stateValue({ domain: "light", on: true })).toBe("On");
    expect(stateValue({ domain: "switch", on: false })).toBe("Off");
    expect(stateValue({ domain: "binary_sensor", on: true })).toBe("On");
    expect(stateValue({ domain: "sensor", value: 3 })).toBe(3);
    expect(stateValue({ domain: "sensor", value: null })).toBe(null);
    expect(stateValue({ domain: "climate", mode: "cool" })).toBe("Cool");
    expect(stateValue({ domain: "cover", motion: "opening" })).toBe("Opening");
    expect(stateValue({ domain: "cover", motion: "stopped", position: 0 })).toBe("Closed");
    expect(stateValue({ domain: "cover", motion: "stopped", position: 0.5 })).toBe("Open");
    expect(stateValue({ domain: "lock", locked: false })).toBe("Unlocked");
    expect(stateValue({ domain: "button", pressedAt: 5 })).toBe(5);
    expect(stateValue({ domain: "button" })).toBe(null);
    expect(stateValue({ domain: "weather", condition: "partly-cloudy-night" })).toBe(
      "PartlyCloudyNight",
    );
  });
});

describe("evaluation", () => {
  test("literals and arithmetic", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 % 3")).toBe(1);
    expect(ev("-4 + 60%")).toBe(-3.4);
    expect(ev('"a" + 1')).toBe("a1");
    expect(ev("!true || false")).toBe(false);
    expect(ev("1 / 0")).toBe(null);
  });

  test("entity fields", () => {
    expect(ev("sensor.living_temp.value")).toBe(21.5);
    expect(ev("sensor.living_temp.unit")).toBe("°C");
    expect(ev("sensor.living_temp.name")).toBe("living_temp");
    expect(ev("sensor.living_temp.domain")).toBe("sensor");
    expect(ev("sensor.living_temp.changedAt")).toBe(1000);
    expect(ev("light.hall.value == .On")).toBe(true);
    expect(ev("lock.front.value == .Locked")).toBe(true);
    expect(ev("climate.living.value == .Heat")).toBe(true);
    expect(ev("cover.garage.value == .Closed")).toBe(true);
    expect(ev("light.hall.attr.brightness")).toBe(0.4);
    expect(ev("light.hall.capabilities")).toEqual(["brightness"]);
    expect(ev("sensor.outside#humidity.value")).toBe(70);
    expect(ev("sensor.outside#humidity.available")).toBe(true);
    expect(ev("climate.living#targetTemp.value")).toBe(22);
  });

  test("unavailable propagates and ?? recovers", () => {
    expect(isUnavailable(ev("switch.porch.value"))).toBe(true);
    expect(isUnavailable(ev("switch.porch.value == .On"))).toBe(true);
    expect(isUnavailable(ev("switch.porch.value == .On && true"))).toBe(true);
    expect(ev("switch.porch.available")).toBe(false);
    expect(ev("switch.porch.value ?? .Off")).toBe("Off");
    expect(isUnavailable(ev("round(switch.porch.attr.x)"))).toBe(true);
    expect(isUnavailable(ev("sensor.outside#missing.value"))).toBe(true);
    const gone = house({ state: () => undefined });
    expect(isUnavailable(ev("sensor.living_temp.value", gone))).toBe(true);
  });

  test("areas and devices", () => {
    expect(ev("count(areas)")).toBe(3);
    expect(ev("area.living.name")).toBe("Living room");
    expect(ev("area.living.entities")).toEqual([
      { $: "entity", id: "sensor.living_temp" },
      { $: "entity", id: "light.living_lamp" },
      { $: "entity", id: "climate.living" },
    ]);
    // Hidden entities are left out; an entity's area may come through its device.
    expect(ev("area.hall.entities")).toEqual([
      { $: "entity", id: "light.hall" },
      { $: "entity", id: "lock.front" },
    ]);
    expect(ev("area.living.devices")).toEqual([
      { $: "device", id: "dev_thermostat" },
      { $: "device", id: "dev_lamp" },
    ]);
    expect(ev("device.dev_thermostat.entities")).toEqual([
      { $: "entity", id: "sensor.living_temp" },
      { $: "entity", id: "climate.living" },
    ]);
    expect(ev("device.dev_thermostat.manufacturer")).toBe("Acme");
    expect(ev("device.dev_lamp.model")).toBe(null);
    // A device's icon: chosen, else its kind's, else its first shown entity's domain.
    expect(ev("device.dev_lamp.icon")).toBe("lamp");
    expect(ev("device.dev_porch.icon")).toBe("irrigation");
    expect(ev("device.dev_thermostat.icon")).toBe("sensor");
    expect(ev("sensor.living_temp.area.name")).toBe("Living room");
    expect(ev("sensor.living_temp.device.name")).toBe("Thermostat");
    expect(ev("light.hall.device")).toBe(null);
    expect(ev("areas[1].name")).toBe("Hall");
    expect(ev("areas[9]")).toBe(null);
    expect(ev("area.living == sensor.living_temp.area")).toBe(true);
  });

  test("screen and now", () => {
    expect(ev("screen == .Desktop")).toBe(true);
    expect(ev("screen == .Phone ? 1 : 3")).toBe(3);
    expect(ev("now.time")).toBe(12 * 60 + 30);
    expect(ev("now.date")).toBe("2026-10-07");
    expect(ev("now.weekday == .Wed")).toBe(true);
    expect(ev("now.time > 07:00 && now.time < 23:00")).toBe(true);
    expect(ev("since(sensor.living_temp.changedAt) > 1h")).toBe(true);
  });

  test("the function library", () => {
    expect(ev("round(2.5) + round(-2.5) + round(1.25, 1)")).toBe(1.3);
    expect(ev("clamp(5, 0, 3) + min(1, 2, 0) + max(1, 2) + abs(-1) + floor(1.5) + ceil(1.5)")).toBe(
      9,
    );
    expect(ev("format(sensor.living_temp.value, 1)")).toBe("21.5");
    expect(ev("unit(sensor.living_temp)")).toBe("°C");
    expect(ev("present(light.hall)")).toBe(
      'light.hall:{"domain":"light","on":true,"brightness":0.4}',
    );
    expect(ev("ago(sensor.living_temp.changedAt)")).toBe(
      `${Math.round((Date.UTC(2026, 9, 7, 12, 30) - 1000) / 60_000)} min ago`,
    );
    expect(ev("date(sensor.living_temp.changedAt)")).toBe("date:1000");
    expect(ev("time(sensor.living_temp.changedAt) + datetime(1)")).toBe("time:1000datetime:1");
    expect(isUnavailable(ev("date(switch.porch.changedAt)"))).toBe(true);
    expect(ev("any(area.living.entities, (e) => e.value == .Heat)")).toBe(true);
    expect(ev("all(area.living.entities, (e) => e.available)")).toBe(true);
    expect(ev("first(sort(areas, (a) => a.name)).name")).toBe("Garage");
    expect(ev("first([])")).toBe(null);
    expect(ev('lower("A") + upper("b") + trim(" c ")')).toBe("aBc");
    expect(ev('contains("abc", "b") && starts("abc", "a")')).toBe(true);
    expect(ev("between(2, 1, 3)")).toBe(true);
    expect(ev("count(area.living.entities)")).toBe(3);
    expect(ev('count(filter(area.living.entities, (e) => e.domain == "light"))')).toBe(1);
    expect(ev("filter([1, 2, 3], (n) => n > 1)")).toEqual([2, 3]);
  });

  test("lists and lambdas close over their scope", () => {
    expect(ev("[1, 2, 3][1]")).toBe(2);
    expect(ev("any([1, 2], (n) => n == hot)", house(), { hot: 2 })).toBe(true);
    expect(ev("any([1, 2], (n) => n == hot)", house(), { hot: 3 })).toBe(false);
  });

  test("a bound variable wins over nothing, and reads as null when unbound", () => {
    expect(ev("hot > 20", house(), { hot: 25 })).toBe(true);
    expect(evaluate(["var", "missing"], env(house()))).toBe(null);
  });
});

describe("dependencies", () => {
  test("only what was read is a dependency", () => {
    const { deps } = evaluateWithDeps(
      code("light.hall.value == .On ? sensor.living_temp.value : (screen == .Phone ? 1 : 0)"),
      env(house()),
    );
    expect([...deps].sort()).toEqual(["state:light.hall", "state:sensor.living_temp"]);
  });

  test("the branch not taken is not a dependency", () => {
    const off = house();
    off.states.set("light.hall", record("light.hall", { domain: "light", on: false }));
    const { deps } = evaluateWithDeps(
      code("light.hall.value == .On ? sensor.living_temp.value : (screen == .Phone ? 1 : 0)"),
      env(off),
    );
    expect([...deps].sort()).toEqual(["screen", "state:light.hall"]);
  });

  test("registry, now and variables are dependencies too", () => {
    const { deps } = evaluateWithDeps(
      code("count(area.living.entities) + now.ms + hot", ["hot"]),
      env(house(), { hot: 1 }),
    );
    expect([...deps].sort()).toEqual(["now", "registry", "var:hot"]);
  });

  test("the host's own onRead still hears every read", () => {
    const heard: string[] = [];
    const { deps } = evaluateWithDeps(code("screen"), env(house({ onRead: (d) => heard.push(d) })));
    expect(heard).toEqual(["screen"]);
    expect([...deps]).toEqual(["screen"]);
  });
});

describe("clock", () => {
  test("wall-clock parts in a zone", () => {
    const ms = Date.UTC(2026, 9, 7, 23, 30);
    expect(clock(ms, "UTC")).toEqual({ minutes: 23 * 60 + 30, date: "2026-10-07", weekday: "Wed" });
    expect(clock(ms, "Australia/Sydney")).toEqual({
      minutes: 10 * 60 + 30,
      date: "2026-10-08",
      weekday: "Thu",
    });
    expect(clock(Date.UTC(2026, 9, 7, 0, 5), "UTC").minutes).toBe(5);
  });
});

describe("statements", () => {
  const handlers = (source: string) => {
    const result = compile({ source, registry: REGISTRY, requirePage: true });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
    return result;
  };

  test("call builds the command from the id and the arguments", () => {
    expect(commandOf("light.hall", "turn_on", { brightness: 0.6, transitionMs: 1500 })).toEqual({
      domain: "light",
      action: "turn_on",
      brightness: 0.6,
      transitionMs: 1500,
    });
    expect(commandOf("climate.living", "set_mode", { mode: "Heat" })).toEqual({
      domain: "climate",
      action: "set_mode",
      mode: "heat",
    });
    expect(commandOf("light.hall", "turn_on", { brightness: UNAVAILABLE })).toEqual({
      domain: "light",
      action: "turn_on",
    });
  });

  test("if, set, call and after run in order over the house", async () => {
    const result = handlers(`page P {
      state n = 1
      Card { onPress: () => { set n = n + 1; if n > 1 { call light.hall.turn_on { brightness: n / 10 } } else { call light.hall.turn_off } } }
      on switch.porch changed { if cover.garage.value == .Closed { call cover.garage.open } after 5m { call cover.garage.close } }
    }`);
    const calls: unknown[] = [];
    const sets: unknown[] = [];
    const later: { ms: number; fn: () => Promise<void> }[] = [];
    const actions = {
      call: (id: string, command: unknown) => void calls.push([id, command]),
      set: (name: string, value: Value) => void sets.push([name, value]),
      after: (ms: number, fn: () => Promise<void>) => void later.push({ ms, fn }),
    };
    const press = result.page?.root.props.onPress;
    if (!press || !("h" in press)) throw new Error("no handler");
    await run(press.h.body, env(house(), { n: 1 }), actions);
    expect(sets).toEqual([["n", 2]]);
    expect(calls).toEqual([
      ["light.hall", { domain: "light", action: "turn_on", brightness: 0.2 }],
    ]);

    calls.length = 0;
    await run(result.serverHandlers[0]?.body ?? [], env(house()), actions);
    expect(calls).toEqual([["cover.garage", { domain: "cover", action: "open" }]]);
    expect(later).toHaveLength(1);
    expect(later[0]?.ms).toBe(300_000);
    await later[0]?.fn();
    expect(calls[1]).toEqual(["cover.garage", { domain: "cover", action: "close" }]);
  });
});

describe("run statements", () => {
  test("paramsOf sends a device, area or entity as its id, and drops absent values", () => {
    expect(
      paramsOf({
        deviceId: { $: "device", id: "dev_porch" },
        area: { $: "area", id: "hall" },
        entity: { $: "entity", id: "light.hall" },
        n: 0,
        s: "",
        b: false,
        gone: null,
        down: UNAVAILABLE,
      }),
    ).toEqual({
      deviceId: "dev_porch",
      area: "hall",
      entity: "light.hall",
      n: 0,
      s: "",
      b: false,
    });
  });

  test("paramsOf maps lists, nested ones too", () => {
    expect(
      paramsOf({
        ids: [{ $: "device", id: "a" }, { $: "entity", id: "light.b" }, 3],
        nested: [[{ $: "area", id: "hall" }]],
        empty: [],
      }),
    ).toEqual({ ids: ["a", "light.b", 3], nested: [["hall"]], empty: [] });
  });

  test("paramsOf of nothing is nothing", () => {
    expect(paramsOf({})).toEqual({});
  });

  test("run evaluates its arguments over the house and hands them to actions.run", async () => {
    const ran: unknown[] = [];
    const actions = {
      call: () => {},
      set: () => {},
      after: () => {},
      run: async (id: string, action: string, params: Record<string, unknown>) =>
        void ran.push([id, action, params]),
    };
    await run(
      [
        [
          "run",
          "zwave-js.main",
          "led_notify",
          {
            deviceId: ["lookup", "device", "dev_porch"],
            color: ["bin", "+", ["lit", 1], ["lit", 2]],
            effect: ["lit", "pulse"],
            gone: ["lit", null],
          },
        ],
        ["run", "zwave-js.main", "ping", {}],
      ],
      env(house()),
      actions,
    );
    expect(ran).toEqual([
      ["zwave-js.main", "led_notify", { deviceId: "dev_porch", color: 3, effect: "pulse" }],
      ["zwave-js.main", "ping", {}],
    ]);
  });

  test("run waits for the action before the next statement", async () => {
    const order: string[] = [];
    const actions = {
      call: (id: string) => void order.push(`call ${id}`),
      set: () => {},
      after: () => {},
      run: async () => {
        await Bun.sleep(5);
        order.push("run");
      },
    };
    await run(
      [
        ["run", "x.main", "go", {}],
        ["call", "light.hall", "turn_on", {}],
      ],
      env(house()),
      actions,
    );
    expect(order).toEqual(["run", "call light.hall"]);
  });

  test("run throws where there is no actions.run, as in the browser", async () => {
    const actions = { call: () => {}, set: () => {}, after: () => {} };
    await expect(run([["run", "x.main", "go", {}]], env(house()), actions)).rejects.toThrow(
      "`run` only runs on the server",
    );
  });
});
