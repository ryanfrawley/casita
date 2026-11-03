import { describe, expect, test } from "bun:test";
import {
  actionLabel,
  type Field,
  formParams,
  initialValues,
  redacted,
  schemaFields,
  settingHint,
  settingInput,
  type TypedSetting,
  typedValue,
  uptime,
} from "./forms.ts";

const objectSchema = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

const field = (overrides: Partial<Field> & Pick<Field, "name" | "kind">): Field => ({
  required: false,
  initial: overrides.kind === "boolean" ? false : "",
  ...overrides,
});

describe("schemaFields", () => {
  describe("schemas with nothing to ask", () => {
    test("gives no fields for a value that is not an object", () => {
      expect(schemaFields(undefined)).toEqual([]);
      expect(schemaFields(null)).toEqual([]);
      expect(schemaFields("object")).toEqual([]);
      expect(schemaFields(42)).toEqual([]);
      expect(schemaFields([{ type: "string" }])).toEqual([]);
    });

    test("gives no fields for an empty schema", () => {
      expect(schemaFields({})).toEqual([]);
    });

    test("gives an object schema with no properties declared nothing per property", () => {
      expect(schemaFields(objectSchema({}))).toEqual([]);
    });
  });

  describe("schemas that are not an object of properties", () => {
    const params: Field[] = [
      { name: "params", kind: "json", required: false, initial: "", whole: true },
    ];

    test("gives one optional JSON field named params for an array schema", () => {
      expect(schemaFields({ type: "array", items: { type: "number" } })).toEqual(params);
    });

    test("gives one optional JSON field for an object type without properties", () => {
      expect(schemaFields({ type: "object" })).toEqual(params);
      expect(schemaFields({ type: "object", properties: [] })).toEqual(params);
    });

    test("gives one optional JSON field for a schema with properties but no object type", () => {
      expect(schemaFields({ properties: { a: { type: "string" } } })).toEqual(params);
    });

    test("gives one optional JSON field for a union schema", () => {
      expect(schemaFields({ anyOf: [{ type: "string" }, { type: "number" }] })).toEqual(params);
    });
  });

  describe("an object of properties", () => {
    test("gives one field per property, in the schema's order", () => {
      const fields = schemaFields(
        objectSchema({ zeta: { type: "string" }, alpha: { type: "string" }, mid: {} }),
      );
      expect(fields.map((f) => f.name)).toEqual(["zeta", "alpha", "mid"]);
    });

    test("marks exactly the properties in the required list as required", () => {
      const fields = schemaFields(
        objectSchema({ a: { type: "string" }, b: { type: "string" } }, ["b"]),
      );
      expect(fields.map((f) => [f.name, f.required])).toEqual([
        ["a", false],
        ["b", true],
      ]);
    });

    test("treats every property as optional when required is missing or not a list", () => {
      expect(schemaFields(objectSchema({ a: { type: "string" } }))[0]?.required).toBe(false);
      const odd = { ...objectSchema({ a: { type: "string" } }), required: "a" };
      expect(schemaFields(odd)[0]?.required).toBe(false);
    });

    test("carries a description through and omits a non-string one", () => {
      const [described, bare] = schemaFields(
        objectSchema({
          a: { type: "string", description: "Seconds to stay open" },
          b: { type: "string", description: 5 },
        }),
      );
      expect(described?.description).toBe("Seconds to stay open");
      expect(bare?.description).toBeUndefined();
    });
  });

  describe("text", () => {
    test("makes a string property a text field starting empty", () => {
      expect(schemaFields(objectSchema({ name: { type: "string" } }))).toEqual([
        { name: "name", kind: "text", required: false, initial: "", description: undefined },
      ]);
    });

    test("starts with a string default", () => {
      const [f] = schemaFields(objectSchema({ name: { type: "string", default: "hall" } }));
      expect(f?.initial).toBe("hall");
    });

    test("ignores a default that is not a string", () => {
      const [f] = schemaFields(objectSchema({ name: { type: "string", default: 3 } }));
      expect(f?.initial).toBe("");
    });
  });

  describe("number", () => {
    test("makes a number property a non-integer number field", () => {
      const [f] = schemaFields(objectSchema({ level: { type: "number" } }));
      expect(f?.kind).toBe("number");
      expect(f?.integer).toBe(false);
      expect(f?.initial).toBe("");
      expect(f?.min).toBeUndefined();
      expect(f?.max).toBeUndefined();
    });

    test("makes an integer property a number field marked integer", () => {
      const [f] = schemaFields(objectSchema({ count: { type: "integer" } }));
      expect(f?.kind).toBe("number");
      expect(f?.integer).toBe(true);
    });

    test("takes min and max from minimum and maximum", () => {
      const [f] = schemaFields(
        objectSchema({ duration: { type: "integer", minimum: 0, maximum: 254 } }),
      );
      expect(f?.min).toBe(0);
      expect(f?.max).toBe(254);
    });

    test("ignores a minimum or maximum that is not a number", () => {
      const [f] = schemaFields(
        objectSchema({ n: { type: "number", minimum: "1", maximum: null } }),
      );
      expect(f?.min).toBeUndefined();
      expect(f?.max).toBeUndefined();
    });

    test("holds a numeric default as text, as the input does", () => {
      const [a, b] = schemaFields(
        objectSchema({
          a: { type: "number", default: 2.5 },
          b: { type: "integer", default: 0 },
        }),
      );
      expect(a?.initial).toBe("2.5");
      expect(b?.initial).toBe("0");
    });

    test("ignores a default that is not a number", () => {
      const [f] = schemaFields(objectSchema({ n: { type: "number", default: "7" } }));
      expect(f?.initial).toBe("");
    });
  });

  describe("boolean", () => {
    test("makes a boolean property a boolean field starting false", () => {
      const [f] = schemaFields(objectSchema({ on: { type: "boolean" } }));
      expect(f?.kind).toBe("boolean");
      expect(f?.initial).toBe(false);
    });

    test("starts true only when the default is true", () => {
      const [yes, no, truthy] = schemaFields(
        objectSchema({
          yes: { type: "boolean", default: true },
          no: { type: "boolean", default: false },
          truthy: { type: "boolean", default: "true" },
        }),
      );
      expect(yes?.initial).toBe(true);
      expect(no?.initial).toBe(false);
      expect(truthy?.initial).toBe(false);
    });
  });

  describe("select", () => {
    test("makes a string enum a select with its options", () => {
      const [f] = schemaFields(
        objectSchema({ mode: { type: "string", enum: ["heat", "cool", "auto"] } }),
      );
      expect(f?.kind).toBe("select");
      expect(f?.options).toEqual(["heat", "cool", "auto"]);
      expect(f?.initial).toBe("");
    });

    test("makes a string enum a select even without a type", () => {
      const [f] = schemaFields(objectSchema({ mode: { enum: ["a", "b"] } }));
      expect(f?.kind).toBe("select");
    });

    test("starts with a string default", () => {
      const [f] = schemaFields(objectSchema({ mode: { enum: ["a", "b"], default: "b" } }));
      expect(f?.initial).toBe("b");
    });

    test("does not make a select of an enum that is not all strings", () => {
      const [f] = schemaFields(objectSchema({ level: { type: "integer", enum: [1, 2, 3] } }));
      expect(f?.kind).toBe("number");
      expect(f?.options).toBeUndefined();
    });
  });

  describe("json", () => {
    test("types arrays, nested objects, unions and untyped properties as JSON", () => {
      const fields = schemaFields(
        objectSchema({
          list: { type: "array", items: { type: "string" } },
          nested: { type: "object", properties: { a: { type: "string" } } },
          either: { anyOf: [{ type: "string" }, { type: "number" }] },
          untyped: {},
          notASchema: "string",
        }),
      );
      expect(fields.map((f) => f.kind)).toEqual(["json", "json", "json", "json", "json"]);
      expect(fields.every((f) => f.initial === "")).toBe(true);
    });

    test("holds a default as JSON text", () => {
      const [list, nested, nil] = schemaFields(
        objectSchema({
          list: { type: "array", default: [1, 2] },
          nested: { type: "object", default: { a: "b" } },
          nil: { default: null },
        }),
      );
      expect(list?.initial).toBe("[1,2]");
      expect(nested?.initial).toBe('{"a":"b"}');
      expect(nil?.initial).toBe("null");
    });
  });
});

describe("initialValues", () => {
  test("maps each field's name to its initial value", () => {
    const fields = schemaFields(
      objectSchema({
        name: { type: "string", default: "hall" },
        level: { type: "number", default: 3 },
        on: { type: "boolean", default: true },
        list: { type: "array" },
      }),
    );
    expect(initialValues(fields)).toEqual({ name: "hall", level: "3", on: true, list: "" });
  });

  test("gives an empty object for no fields", () => {
    expect(initialValues([])).toEqual({});
  });
});

describe("formParams", () => {
  describe("text", () => {
    test("trims the text", () => {
      const fields = [field({ name: "name", kind: "text" })];
      expect(formParams(fields, { name: "  hall  " })).toEqual({
        params: { name: "hall" },
        errors: {},
      });
    });

    test("leaves an empty optional field out of params", () => {
      const fields = [field({ name: "name", kind: "text" })];
      const result = formParams(fields, { name: "   " });
      expect(result).toEqual({ params: {}, errors: {} });
      expect("name" in result.params).toBe(false);
    });

    test("reports an empty required field as needed", () => {
      const fields = [field({ name: "name", kind: "text", required: true })];
      expect(formParams(fields, { name: " " })).toEqual({
        params: {},
        errors: { name: "This is needed." },
      });
    });
  });

  describe("number", () => {
    const num = (overrides: Partial<Field> = {}) => [
      field({ name: "n", kind: "number", integer: false, ...overrides }),
    ];

    test("parses the number", () => {
      expect(formParams(num(), { n: " 2.5 " })).toEqual({ params: { n: 2.5 }, errors: {} });
    });

    test("accepts zero and negative numbers", () => {
      expect(formParams(num(), { n: "0" }).params).toEqual({ n: 0 });
      expect(formParams(num(), { n: "-3" }).params).toEqual({ n: -3 });
    });

    test("reports text that is not a number", () => {
      expect(formParams(num(), { n: "abc" })).toEqual({ params: {}, errors: { n: "A number." } });
      expect(formParams(num(), { n: "Infinity" }).errors).toEqual({ n: "A number." });
    });

    test("reports a fraction for an integer field", () => {
      expect(formParams(num({ integer: true }), { n: "1.5" })).toEqual({
        params: {},
        errors: { n: "A whole number." },
      });
    });

    test("accepts a whole number for an integer field", () => {
      expect(formParams(num({ integer: true }), { n: "4" }).params).toEqual({ n: 4 });
    });

    test("reports a number below the minimum", () => {
      expect(formParams(num({ min: 1 }), { n: "0" })).toEqual({
        params: {},
        errors: { n: "At least 1." },
      });
    });

    test("reports a number above the maximum", () => {
      expect(formParams(num({ max: 254 }), { n: "255" })).toEqual({
        params: {},
        errors: { n: "At most 254." },
      });
    });

    test("accepts the bounds themselves, including a zero or negative range", () => {
      expect(formParams(num({ min: 0, max: 254 }), { n: "0" }).params).toEqual({ n: 0 });
      expect(formParams(num({ min: 0, max: 254 }), { n: "254" }).params).toEqual({ n: 254 });
      expect(formParams(num({ min: -10, max: -1 }), { n: "-5" }).params).toEqual({ n: -5 });
    });

    test("leaves an empty optional number out and reports an empty required one", () => {
      expect(formParams(num(), { n: "" })).toEqual({ params: {}, errors: {} });
      expect(formParams(num({ required: true }), { n: "" }).errors).toEqual({
        n: "This is needed.",
      });
    });
  });

  describe("boolean", () => {
    test("always sends a boolean as true or false", () => {
      const fields = [field({ name: "a", kind: "boolean" }), field({ name: "b", kind: "boolean" })];
      expect(formParams(fields, { a: true, b: false })).toEqual({
        params: { a: true, b: false },
        errors: {},
      });
    });

    test("sends false for a boolean that was not given and starts false", () => {
      const fields = [field({ name: "a", kind: "boolean" })];
      expect(formParams(fields, {}).params).toEqual({ a: false });
    });

    test("never reports a required boolean as missing", () => {
      const fields = [field({ name: "a", kind: "boolean", required: true })];
      expect(formParams(fields, { a: false })).toEqual({ params: { a: false }, errors: {} });
    });
  });

  describe("select", () => {
    test("passes the chosen option through", () => {
      const fields = [field({ name: "mode", kind: "select", options: ["heat", "cool"] })];
      expect(formParams(fields, { mode: "cool" }).params).toEqual({ mode: "cool" });
    });

    test("leaves an unchosen optional select out and reports an unchosen required one", () => {
      const optional = [field({ name: "mode", kind: "select", options: ["a"] })];
      const required = [field({ name: "mode", kind: "select", options: ["a"], required: true })];
      expect(formParams(optional, { mode: "" })).toEqual({ params: {}, errors: {} });
      expect(formParams(required, { mode: "" }).errors).toEqual({ mode: "This is needed." });
    });
  });

  describe("json", () => {
    const json = [field({ name: "list", kind: "json" }), field({ name: "other", kind: "text" })];

    test("parses the JSON typed", () => {
      expect(formParams(json, { list: ' [1, "a", {"b": null}] ' }).params).toEqual({
        list: [1, "a", { b: null }],
      });
    });

    test("reports JSON that does not parse", () => {
      expect(formParams(json, { list: "[1," })).toEqual({
        params: {},
        errors: { list: "This isn't valid JSON." },
      });
    });
  });

  test("reports every error together", () => {
    const fields = [
      field({ name: "name", kind: "text", required: true }),
      field({ name: "level", kind: "number", max: 10 }),
      field({ name: "list", kind: "json" }),
      field({ name: "ok", kind: "text" }),
    ];
    expect(formParams(fields, { name: "", level: "11", list: "{", ok: "fine" })).toEqual({
      params: { ok: "fine" },
      errors: {
        name: "This is needed.",
        level: "At most 10.",
        list: "This isn't valid JSON.",
      },
    });
  });

  test("falls back to a field's initial value when it is missing from values", () => {
    const fields = schemaFields(
      objectSchema({
        name: { type: "string", default: "hall" },
        level: { type: "integer", default: 3 },
        on: { type: "boolean", default: true },
        list: { type: "array", default: [1] },
      }),
    );
    expect(formParams(fields, {})).toEqual({
      params: { name: "hall", level: 3, on: true, list: [1] },
      errors: {},
    });
  });

  test("round-trips the initial values of a schema form", () => {
    const fields = schemaFields(
      objectSchema({ a: { type: "string" }, b: { type: "number", default: 1 } }, ["a"]),
    );
    expect(formParams(fields, initialValues(fields))).toEqual({
      params: { b: 1 },
      errors: { a: "This is needed." },
    });
  });

  test("gives empty params and no errors for no fields", () => {
    expect(formParams([], {})).toEqual({ params: {}, errors: {} });
  });

  describe("the single params field of a schema that is not an object of properties", () => {
    const fields = schemaFields({ type: "array" });

    test("makes typed JSON that is an object the whole params", () => {
      expect(formParams(fields, { params: '{"zone": 2, "minutes": 5}' })).toEqual({
        params: { zone: 2, minutes: 5 },
        errors: {},
      });
    });

    test("wraps typed JSON that is not an object as params", () => {
      expect(formParams(fields, { params: "[1,2]" }).params).toEqual({ params: [1, 2] });
      expect(formParams(fields, { params: "5" }).params).toEqual({ params: 5 });
      expect(formParams(fields, { params: "null" }).params).toEqual({ params: null });
    });

    test("gives empty params when left empty", () => {
      expect(formParams(fields, { params: "" })).toEqual({ params: {}, errors: {} });
      expect(formParams(fields, {})).toEqual({ params: {}, errors: {} });
    });

    test("reports JSON that does not parse", () => {
      expect(formParams(fields, { params: "{nope" })).toEqual({
        params: {},
        errors: { params: "This isn't valid JSON." },
      });
    });
  });

  // BUG: the unwrap for the single-`params`-field case keys only on the field's name and kind,
  // so a real object schema whose only property happens to be called `params` (and is typed as
  // JSON) has its value flattened into the top level instead of being sent under `params`.
  test("keeps a real property named params under params when its value is an object", () => {
    const fields = schemaFields(
      objectSchema({ params: { type: "object", properties: { a: { type: "number" } } } }),
    );
    // Expected { params: { a: 1 } }; actual { a: 1 }.
    expect(formParams(fields, { params: '{"a": 1}' }).params).toEqual({ params: { a: 1 } });
  });
});

test("a string the integration marked scan: qr is a text field a camera can fill", () => {
  const [qr, pin] = schemaFields({
    type: "object",
    properties: {
      qr: { type: "string", scan: "qr", description: "The QR code." },
      pin: { type: "string" },
    },
    required: ["qr"],
  });
  expect(qr).toMatchObject({ name: "qr", kind: "text", required: true, scan: "qr" });
  expect(pin?.scan).toBeUndefined();
});

describe("actionLabel", () => {
  test("turns underscores into spaces and capitalises the first word", () => {
    expect(actionLabel("permit_join")).toBe("Permit join");
  });

  test("turns hyphens into spaces", () => {
    expect(actionLabel("run-zone")).toBe("Run zone");
  });

  test("capitalises a single word", () => {
    expect(actionLabel("reboot")).toBe("Reboot");
  });

  test("splits camelCase parameter names into words", () => {
    expect(actionLabel("timeoutSec")).toBe("Timeout sec");
    expect(actionLabel("bitMask")).toBe("Bit mask");
  });

  test("writes initialisms in capitals wherever they stand", () => {
    expect(actionLabel("pin")).toBe("PIN");
    expect(actionLabel("qr")).toBe("QR");
    expect(actionLabel("nodeId")).toBe("Node ID");
    expect(actionLabel("provision_qr")).toBe("Provision QR");
    expect(actionLabel("backup_nvm")).toBe("Backup NVM");
  });

  test("leaves an already-capitalised name alone", () => {
    expect(actionLabel("Reboot")).toBe("Reboot");
    expect(actionLabel("Permit join")).toBe("Permit join");
  });

  test("collapses runs of separators and trims leading and trailing ones", () => {
    expect(actionLabel("__start__zone--now_")).toBe("Start zone now");
  });

  test("gives an empty string for an empty name", () => {
    expect(actionLabel("")).toBe("");
  });
});

describe("redacted", () => {
  const MASK = "••••••••";

  test("covers string values under credential-like keys, whatever their case", () => {
    expect(
      redacted({
        token: "t",
        apiToken: "a",
        clientSecret: "c",
        PASSWORD: "p",
        apiKey: "k",
      }),
    ).toEqual({ token: MASK, apiToken: MASK, clientSecret: MASK, PASSWORD: MASK, apiKey: MASK });
  });

  test("leaves other keys untouched", () => {
    expect(redacted({ host: "mqtt.local", port: 1883, tls: true })).toEqual({
      host: "mqtt.local",
      port: 1883,
      tls: true,
    });
  });

  test("leaves empty strings, numbers, booleans and null under credential keys as they are", () => {
    expect(redacted({ token: "", secret: 42, password: false, apiKey: null })).toEqual({
      token: "",
      secret: 42,
      password: false,
      apiKey: null,
    });
  });

  test("covers credentials at any depth, including in arrays of objects", () => {
    const config = {
      mqtt: { url: "mqtt://x", password: "hunter2" },
      auth: { oidc: [{ issuer: "https://id", clientId: "casita", clientSecret: "s3cret" }] },
    };
    expect(redacted(config)).toEqual({
      mqtt: { url: "mqtt://x", password: MASK },
      auth: { oidc: [{ issuer: "https://id", clientId: "casita", clientSecret: MASK }] },
    });
  });

  test("covers each string in an array held under a credential key", () => {
    expect(redacted({ tokens: ["a", "", "b"] })).toEqual({ tokens: [MASK, "", MASK] });
  });

  test("preserves arrays and nesting of non-secret values", () => {
    const config = { zones: [{ name: "front", ids: [1, 2] }], deep: { a: { b: ["x"] } } };
    expect(redacted(config)).toEqual(config);
  });

  test("does not mutate its input", () => {
    const config = { auth: { oidc: [{ clientSecret: "s3cret" }] }, password: "p" };
    const copy = structuredClone(config);
    redacted(config);
    expect(config).toEqual(copy);
  });

  test("returns plain values outside any key as they are", () => {
    expect(redacted("secret")).toBe("secret");
    expect(redacted(5)).toBe(5);
    expect(redacted(null)).toBeNull();
  });
});

describe("typedValue", () => {
  test("parses text that is JSON", () => {
    expect(typedValue("45")).toBe(45);
    expect(typedValue("true")).toBe(true);
    expect(typedValue('"x"')).toBe("x");
    expect(typedValue('{"a":1}')).toEqual({ a: 1 });
    expect(typedValue("[1]")).toEqual([1]);
    expect(typedValue("null")).toBeNull();
  });

  test("trims before parsing", () => {
    expect(typedValue("  45 \n")).toBe(45);
  });

  test("keeps text that is not JSON as the trimmed text", () => {
    expect(typedValue("metric")).toBe("metric");
    expect(typedValue("  America/Los_Angeles ")).toBe("America/Los_Angeles");
    expect(typedValue("")).toBe("");
  });
});

describe("uptime", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  test("counts minutes under an hour", () => {
    expect(uptime(0)).toBe("0 min");
    expect(uptime(MIN - 1)).toBe("0 min");
    expect(uptime(59 * MIN + 59_999)).toBe("59 min");
  });

  test("counts hours and minutes under a day", () => {
    expect(uptime(HOUR)).toBe("1h 0m");
    expect(uptime(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });

  test("counts days and hours from a day on", () => {
    expect(uptime(DAY)).toBe("1d 0h");
    expect(uptime(3 * DAY + 4 * HOUR + 30 * MIN)).toBe("3d 4h");
  });
});

describe("settingInput", () => {
  const timer: TypedSetting = {
    label: "Auto off",
    type: "number",
    min: 0,
    max: 32767,
    options: [{ value: 0, label: "Disabled" }],
  };
  test.each([
    ["300", { value: 300 }],
    [" 300 ", { value: 300 }],
    ["disabled", { value: 0 }],
    ["", { error: "A number." }],
    ["soon", { error: "A number." }],
    ["-1", { error: "At least 0." }],
    ["40000", { error: "At most 32767." }],
    ["1.5", { error: "A whole number." }],
  ])("%p", (text, expected) => {
    expect(settingInput(timer, text)).toEqual(expected);
  });
  test("a step counts from the minimum; text is taken as it is", () => {
    expect(settingInput({ ...timer, min: 1, step: 2 }, "4")).toEqual({ error: "In steps of 2." });
    expect(settingInput({ ...timer, min: 1, step: 2 }, "5")).toEqual({ value: 5 });
    expect(settingInput({ label: "Name", type: "string" }, " hi ")).toEqual({ value: " hi " });
  });
});

test("settingHint gives the range with its unit and the values it names", () => {
  expect(
    settingHint({
      label: "Auto off",
      type: "number",
      min: 0,
      max: 32767,
      unit: "seconds",
      options: [{ value: 0, label: "Disabled" }],
    }),
  ).toBe("0 to 32767 seconds. 0 Disabled");
  expect(settingHint({ label: "Level", type: "number" })).toBeUndefined();
});
