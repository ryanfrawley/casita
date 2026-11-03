import { expect, test } from "bun:test";
import { compileTemplate, type Discovered, parseDiscovery } from "../src/discovery.ts";

const parse = (topic: string, payload: unknown = {}) =>
  parseDiscovery("casita", topic, typeof payload === "string" ? payload : JSON.stringify(payload));

/** Parses a light config and returns the config, failing the test if there is none. */
function configOf(payload: unknown): NonNullable<Discovered["config"]> {
  const config = parse("casita/light/lamp/config", payload)?.config;
  if (!config) throw new Error("expected a config");
  return config;
}

// ───────── topics ─────────

test("a 3-segment topic yields component, key and object id", () => {
  expect(parse("casita/light/lamp/config")).toMatchObject({
    component: "light",
    key: "light/lamp",
    objectId: "lamp",
  });
});

test("a 4-segment topic includes the node id in the key", () => {
  expect(parse("casita/binary_sensor/node1/door/config")).toMatchObject({
    component: "binary_sensor",
    key: "binary_sensor/node1/door",
    objectId: "door",
  });
});

test("every supported component is accepted", () => {
  for (const component of ["light", "switch", "sensor", "binary_sensor", "cover", "button"]) {
    expect(parse(`casita/${component}/x/config`)?.component).toBe(
      component as Discovered["component"],
    );
  }
});

test("a multi-segment prefix works", () => {
  expect(parseDiscovery("home/disco", "home/disco/switch/plug/config", "{}")?.key).toBe(
    "switch/plug",
  );
});

test.each([
  ["other/light/lamp/config", "wrong prefix"],
  ["casitax/light/lamp/config", "prefix is only a string prefix of the first level"],
  ["casita", "the bare prefix"],
  ["casita/climate/thermostat/config", "unsupported component"],
  ["casita/light/lamp/state", "leaf is not config"],
  ["casita/light/lamp/config/extra", "config is not the leaf"],
  ["casita/light/config", "too few segments"],
  ["casita/light/a/b/c/config", "too many segments"],
])("%p is not a discovery topic (%s)", (topic) => {
  expect(parse(topic)).toBeUndefined();
});

test("an empty or whitespace payload removes the entity", () => {
  expect(parse("casita/light/lamp/config", "")).toEqual({
    component: "light",
    key: "light/lamp",
    objectId: "lamp",
    config: null,
  });
  expect(parse("casita/light/lamp/config", "  \n")?.config).toBeNull();
});

test("a non-JSON payload throws", () => {
  expect(() => parse("casita/light/lamp/config", "{nope")).toThrow("payload is not JSON");
});

test.each([["[]"], ["null"], ["42"], ['"text"']])(
  "a JSON payload that is not an object (%p) throws",
  (payload) => {
    expect(() => parse("casita/light/lamp/config", payload)).toThrow("payload is not an object");
  },
);

test("an invalid field throws with its path", () => {
  expect(() => configOf({ state_topic: "" })).toThrow("state_topic");
  expect(() => configOf({ brightness_scale: 0 })).toThrow("brightness_scale");
  expect(() => configOf({ dev: { ids: 5 } })).toThrow("device.identifiers");
});

// ───────── abbreviations ─────────

test("abbreviated keys are expanded", () => {
  const config = configOf({
    uniq_id: "u1",
    stat_t: "s",
    cmd_t: "c",
    avty_t: "a",
    pl_on: "1",
    pl_off: "0",
    pl_avail: "up",
    pl_not_avail: "down",
    val_tpl: "{{ value_json.x }}",
    unit_of_meas: "°C",
    dev_cla: "temperature",
    bri_cmd_t: "bc",
    bri_stat_t: "bs",
    bri_scl: 100,
    bri_val_tpl: "{{ value_json.b }}",
    pos_t: "p",
    set_pos_t: "sp",
    pl_open: "o",
    pl_cls: "cl",
    pl_stop: "st",
    pl_prs: "pr",
  });
  expect(config).toMatchObject({
    unique_id: "u1",
    state_topic: "s",
    command_topic: "c",
    availability_topic: "a",
    payload_on: "1",
    payload_off: "0",
    payload_available: "up",
    payload_not_available: "down",
    value_template: "{{ value_json.x }}",
    unit_of_measurement: "°C",
    device_class: "temperature",
    brightness_command_topic: "bc",
    brightness_state_topic: "bs",
    brightness_scale: 100,
    brightness_value_template: "{{ value_json.b }}",
    position_topic: "p",
    set_position_topic: "sp",
    payload_open: "o",
    payload_close: "cl",
    payload_stop: "st",
    payload_press: "pr",
  });
  expect(config).not.toHaveProperty("stat_t");
});

test("the dev block and its keys are expanded", () => {
  expect(
    configOf({ dev: { ids: ["d1"], mf: "Acme", mdl: "X1", sw: "1.2", name: "Hub" } }).device,
  ).toEqual({
    identifiers: ["d1"],
    manufacturer: "Acme",
    model: "X1",
    sw_version: "1.2",
    name: "Hub",
  });
});

test("an unabbreviated device block is accepted as is", () => {
  expect(configOf({ device: { identifiers: "d1", manufacturer: "Acme" } }).device).toEqual({
    identifiers: "d1",
    manufacturer: "Acme",
  });
});

test("the availability list is read", () => {
  expect(configOf({ avty: [{ topic: "a/1" }, { topic: "a/2" }] }).availability).toEqual([
    { topic: "a/1" },
    { topic: "a/2" },
  ]);
});

test("unknown keys are kept", () => {
  expect(configOf({ icon: "mdi:lamp" })).toMatchObject({ icon: "mdi:lamp" });
});

// ───────── ~ base topic ─────────

test("~ at the start of a topic field is replaced by the base", () => {
  const config = configOf({ "~": "home/lamp", stat_t: "~/state", cmd_t: "~/set" });
  expect(config.state_topic).toBe("home/lamp/state");
  expect(config.command_topic).toBe("home/lamp/set");
});

test("~ at the end of a topic field is replaced by the base", () => {
  expect(configOf({ "~": "home/lamp", avty_t: "status/~" }).availability_topic).toBe(
    "status/home/lamp",
  );
});

test("~ is substituted after abbreviations are expanded", () => {
  expect(configOf({ "~": "b", bri_stat_t: "~/bri" }).brightness_state_topic).toBe("b/bri");
});

test("~ in the middle of a topic, or in a non-topic field, is left alone", () => {
  const config = configOf({ "~": "base", stat_t: "a/~/b", name: "~/name" });
  expect(config.state_topic).toBe("a/~/b");
  expect(config.name).toBe("~/name");
});

test("without a base, ~ is left as written", () => {
  expect(configOf({ stat_t: "~/state" }).state_topic).toBe("~/state");
});

// ───────── defaults ─────────

test("defaults are filled in", () => {
  expect(configOf({})).toEqual({
    payload_available: "online",
    payload_not_available: "offline",
    payload_on: "ON",
    payload_off: "OFF",
    brightness_scale: 255,
    payload_open: "OPEN",
    payload_close: "CLOSE",
    payload_stop: "STOP",
    payload_press: "PRESS",
  });
});

test("numeric payload_on and payload_off are coerced to strings", () => {
  const config = configOf({ pl_on: 1, pl_off: 0 });
  expect(config.payload_on).toBe("1");
  expect(config.payload_off).toBe("0");
});

test("name, unit_of_measurement and device_class accept null", () => {
  expect(configOf({ name: null, unit_of_meas: null, dev_cla: null })).toMatchObject({
    name: null,
    unit_of_measurement: null,
    device_class: null,
  });
});

// ───────── compileTemplate ─────────

test("no template returns the raw payload", () => {
  expect(compileTemplate(undefined)("raw text")).toBe("raw text");
  expect(compileTemplate(undefined)('{"a":1}')).toBe('{"a":1}');
});

test("a dotted path extracts a nested value", () => {
  const extract = compileTemplate("{{ value_json.a.b_2 }}");
  expect(extract('{"a":{"b_2":{"c":[1]}}}')).toEqual({ c: [1] });
});

test("an index path extracts an array element", () => {
  expect(compileTemplate("{{ value_json.list[1] }}")('{"list":["a","b"]}')).toBe("b");
  expect(compileTemplate("{{ value_json[0].v }}")('[{"v":7}]')).toBe(7);
});

test("single- and double-quoted bracket keys allow any characters but quotes", () => {
  const payload = JSON.stringify({ "a key": { "with-dash.dot": 3 } });
  expect(compileTemplate("{{ value_json['a key'][\"with-dash.dot\"] }}")(payload)).toBe(3);
  expect(compileTemplate("{{ value_json[\"a key\"]['with-dash.dot'] }}")(payload)).toBe(3);
});

test("whitespace inside and around the braces is allowed", () => {
  const payload = '{"t":21.5}';
  expect(compileTemplate("{{value_json.t}}")(payload)).toBe(21.5);
  expect(compileTemplate("  {{   value_json.t   }}  ")(payload)).toBe(21.5);
});

test("extracted values keep their JSON type", () => {
  const payload = '{"n":0,"b":false,"z":null,"s":"x"}';
  expect(compileTemplate("{{ value_json.n }}")(payload)).toBe(0);
  expect(compileTemplate("{{ value_json.b }}")(payload)).toBe(false);
  expect(compileTemplate("{{ value_json.z }}")(payload)).toBeNull();
  expect(compileTemplate("{{ value_json.s }}")(payload)).toBe("x");
});

test.each([
  ["{{ value }}"],
  ["{{ value_json }}"],
  ["{{ value_json.a | float }}"],
  ["{{ value_json.a * 2 }}"],
  ["{{ value_json.1a }}"],
  ["{{ value_json[a] }}"],
  ["{{ value_json[-1] }}"],
  ["{{ value_json.a. }}"],
  ["{{ value_json.a }} extra"],
  ["{% if value_json.a %}on{% endif %}"],
  ["value_json.a"],
  [""],
])("an unsupported template %p throws", (template) => {
  expect(() => compileTemplate(template)).toThrow("unsupported template");
});

test("a non-JSON payload extracts undefined", () => {
  expect(compileTemplate("{{ value_json.a }}")("ON")).toBeUndefined();
  expect(compileTemplate("{{ value_json.a }}")("")).toBeUndefined();
});

test("a path through a missing key or a non-object extracts undefined", () => {
  const extract = compileTemplate("{{ value_json.a.b }}");
  expect(extract('{"x":1}')).toBeUndefined();
  expect(extract('{"a":5}')).toBeUndefined();
  expect(extract('{"a":"str"}')).toBeUndefined();
  expect(extract('{"a":null}')).toBeUndefined();
  expect(compileTemplate("{{ value_json[3] }}")("[1]")).toBeUndefined();
});

// Abbreviated keys inside availability entries ({"t": ...}) are not expanded, so a config with
// avty: [{ t: "x" }] is rejected; ~ is not substituted inside availability[].topic either.
test("availability entries expand t → topic and substitute ~", () => {
  expect(configOf({ "~": "home/lamp", avty: [{ t: "~/avail" }] }).availability).toEqual([
    { topic: "home/lamp/avail" },
  ]);
});

// A bracket key containing the other quote kind (['a"b']) passes TEMPLATE but the segment regex
// skips it, so the extractor silently returns the parent object instead of throwing or indexing.
test("a bracket key containing the other quote character is extracted or rejected", () => {
  const template = `{{ value_json.a['b"c'] }}`;
  const payload = JSON.stringify({ a: { 'b"c': 1, x: 2 } });
  let extracted: unknown;
  try {
    extracted = compileTemplate(template)(payload);
  } catch {
    return; // rejecting the template is also acceptable
  }
  expect(extracted).toBe(1);
});
