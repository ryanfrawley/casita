// casa/check.ts
// Resolves names, checks types and partitions handlers, emitting the compact tree as it goes.
// One walk does all three: every expression is typed once, and what it compiles to falls out
// of its resolution (a theme path, an entity, a binding).

import { BINARY_SENSOR_CLASSES, type Domain, SENSOR_CLASSES } from "../types.ts";
import type {
  Child,
  ComponentDecl,
  EntityRef,
  Expr,
  Handler,
  Lambda,
  Node,
  PageDecl,
  Prop,
  SensorDecl,
  StateDecl,
  Statement,
  TypeExpr,
} from "./ast.ts";
import {
  BUILTINS,
  COMMON_PROPS,
  GRID_COLUMNS_MAX,
  MAP_ZOOM_MAX,
  type PropSpec,
  propsOf,
} from "./builtins.ts";
import type {
  CChild,
  CComponent,
  CExpr,
  CFn,
  CHandler,
  CNode,
  CSensor,
  CSensorType,
  CServerHandler,
  CStmt,
  CTrigger,
} from "./compiled.ts";
import { type Diagnostics, didYouMean, type Span } from "./diagnostics.ts";
import { FUNCTIONS } from "./functions.ts";
import { GROUP_NAMES, isGroupPrefix, themePathType } from "./theme.ts";
import {
  ANY,
  AREA,
  AREA_FIELDS,
  ATTRIBUTE,
  ATTRIBUTE_FIELDS,
  assignable,
  BOOL,
  comparable,
  DEVICE,
  DEVICE_FIELDS,
  DOMAIN_VALUE,
  DURATION,
  ENTITY,
  ENTITY_FIELDS,
  entityOf,
  enumOf,
  fitsSlot,
  hasVar,
  join,
  list,
  NOW,
  NOW_FIELDS,
  NULL,
  NUMBER,
  ordered,
  SCREEN,
  STRING,
  show,
  substitute,
  TIME,
  type Type,
  union,
} from "./types.ts";

// ───────── what the checker needs to know about the house ─────────

export interface Registry {
  entities: readonly { id: string; domain: Domain; name?: string }[];
  areas: readonly { id: string; name?: string }[];
  devices: readonly { id: string; name?: string }[];
  /** Icon names the gallery knows; unset skips the check. */
  icons?: readonly string[];
  /**
   * The integration instances `run` may reach, by id (`zwave-js.main`); unset skips the check.
   * `actions` is unset while an instance isn't running, when what it offers isn't known.
   */
  integrations?: readonly {
    id: string;
    /** Each action's parameters as JSON Schema, as `get_integrations` lists them. */
    actions?: readonly { name: string; schema?: unknown }[];
  }[];
}

/** `zwave-js.main` as `run` writes it: `zwave_js.main`, since `-` can't be in a name. */
export const runName = (integrationId: string): string => integrationId.replaceAll("-", "_");

/** An action's parameters as the checker types them; an open one takes other names too. */
export function actionParams(schema: unknown): {
  params: Record<string, Type>;
  open: boolean;
  required: string[];
} {
  const node = asObject(schema);
  const properties = asObject(node?.properties);
  if (!node || !properties) return { params: {}, open: true, required: [] };
  const params: Record<string, Type> = {};
  for (const [name, property] of Object.entries(properties)) params[name] = jsonType(property);
  const required = Array.isArray(node.required)
    ? node.required.filter((r): r is string => typeof r === "string")
    : [];
  // Zod leaves `additionalProperties` out of an input schema and drops unknown keys when it
  // parses, so a name it doesn't list would vanish: only an explicit allowance opens it.
  const extra = node.additionalProperties;
  return { params, open: extra === true || asObject(extra) !== undefined, required };
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A JSON Schema property as a Casa type; what doesn't map is ANY, checked when it runs. */
function jsonType(schema: unknown): Type {
  const node = asObject(schema);
  if (!node) return ANY;
  const alternatives = node.anyOf ?? node.oneOf;
  if (Array.isArray(alternatives)) return unionOf(alternatives.map(jsonType));
  if (Array.isArray(node.enum)) {
    // One type per kind of value: `["pulse", "solid"]` is a string, not two.
    const kinds = new Set(node.enum.map((v) => (v === null ? "null" : typeof v)));
    return jsonType({ type: [...kinds] });
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return unionOf(
    types.map((t): Type => {
      switch (t) {
        case "number":
        case "integer":
          return NUMBER;
        // A device, area or entity is sent as its id.
        case "string":
          return union(STRING, DEVICE, AREA, ENTITY);
        case "boolean":
          return BOOL;
        case "null":
          return NULL;
        case "array":
          return list(jsonType(node.items));
        default:
          return ANY;
      }
    }),
  );
}

const unionOf = (types: Type[]): Type =>
  types.some((t) => t.kind === "any") || types.length === 0
    ? ANY
    : types.length === 1
      ? (types[0] as Type)
      : union(...types);

/** An entity or attribute stands for the thing, not its value. */
const isReference = (type: Type): boolean => type.kind === "entity" || type.kind === "attribute";

/** A value a reference is never equal to. */
const isPlainValue = (type: Type): boolean =>
  ["number", "string", "bool", "duration", "time"].includes(type.kind);

/** A duration argument takes a Duration literal or a plain number of milliseconds. */
const MS = union(NUMBER, DURATION);

/** Functions that read the clock, which a sensor's value may not (E070). */
const READS_NOW = new Set(["ago", "date", "time", "datetime"]);

/** A sensor's `type`, and what its value is checked against. */
const SENSOR_TYPES: Record<CSensorType, Type> = { String: STRING, Number: NUMBER, Bool: BOOL };

/** A number written as one; `-1` parses as a minus on `1`, so a negative literal is one step down. */
const literalNumber = (value: Expr | Lambda): number | undefined =>
  value.kind === "number"
    ? value.value
    : value.kind === "unary" && value.op === "-" && value.operand.kind === "number"
      ? -value.operand.value
      : undefined;

/** `.Door` in source is the class `door`; the member list is for the message. */
const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const SENSOR_CLASS_MEMBERS = SENSOR_CLASSES.map(pascal);
const BINARY_CLASS_MEMBERS = BINARY_SENSOR_CLASSES.map(pascal);

/** The arguments each command takes, for E060. */
const COMMANDS: Record<Domain, Record<string, Record<string, Type>>> = {
  light: {
    turn_on: { brightness: NUMBER, colorTempK: NUMBER, rgb: list(NUMBER), transitionMs: MS },
    turn_off: { transitionMs: MS },
  },
  switch: { turn_on: {}, turn_off: {}, toggle: {} },
  climate: { set_mode: { mode: DOMAIN_VALUE.climate }, set_target: { temp: NUMBER } },
  cover: { open: {}, close: {}, stop: {}, set_position: { position: NUMBER } },
  lock: { lock: {}, unlock: {} },
  button: { press: {} },
  sensor: {},
  binary_sensor: {},
  weather: {},
};
const REQUIRED_ARGS: Record<string, string[]> = {
  "climate.set_mode": ["mode"],
  "climate.set_target": ["temp"],
  "cover.set_position": ["position"],
};

// ───────── scope ─────────

type BindingKind = "param" | "state" | "for" | "lambda" | "input";

interface Binding {
  type: Type;
  kind: BindingKind;
}

class Scope {
  constructor(
    private readonly bindings: Map<string, Binding>,
    private readonly parent?: Scope,
  ) {}
  get(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.get(name);
  }
  child(bound: Record<string, Binding>): Scope {
    return new Scope(new Map(Object.entries(bound)), this);
  }
  static empty(): Scope {
    return new Scope(new Map());
  }
}

/** Where an expression runs, which decides what it may read. */
type Runtime = "browser" | "server";

export interface Checked {
  components: Record<string, CComponent>;
  state: { name: string; init: CExpr }[];
  root: CNode;
  serverHandlers: CServerHandler[];
  /** The sensor, when one was given to check. */
  sensor?: CSensor;
  /** Theme paths the page references, each with where it first appears. */
  themeRefs: Map<string, Span>;
  /** Theme paths the shared components reference; covered, but not the page's own. */
  sharedRefs: Set<string>;
  /** Theme paths Casita's bundled components reference: every theme has them. */
  bundledRefs: Set<string>;
  entities: Set<string>;
  /** Device ids looked up as `device.<id>`. */
  devices: Set<string>;
  name: string;
}

interface ComponentInfo {
  decl: ComponentDecl;
  params: Record<string, { type: Type; required: boolean }>;
  hasSlot: boolean;
  used: boolean;
}

export function check(
  page: PageDecl,
  components: ComponentDecl[],
  registry: Registry,
  diagnostics: Diagnostics,
  /** An automation's handlers are server handlers too; only the E050 wording differs. */
  mode: "page" | "automation" | "sensor" = "page",
  /** A sensor declaration to check over the page, in sensor mode. */
  sensorDecl?: SensorDecl,
): Checked {
  const automation = mode !== "page";
  const entityIds = new Map(registry.entities.map((e) => [e.id, e]));
  const areaIds = new Set(registry.areas.map((a) => a.id));
  const deviceIds = new Set(registry.devices.map((d) => d.id));
  const themeRefs = new Map<string, Span>();
  const sharedRefs = new Set<string>();
  const bundledRefs = new Set<string>();
  const entities = new Set<string>();
  const devices = new Set<string>();
  const infos = new Map<string, ComponentInfo>();

  const error = (code: string, span: Span, message: string) =>
    diagnostics.error(code, span, message);

  // ───────── types written in source ─────────

  const typeFrom = (t: TypeExpr): Type => {
    switch (t.kind) {
      case "list":
        return list(typeFrom(t.of));
      case "enum":
        return enumOf(...t.members);
      case "name":
        switch (t.name) {
          case "Number":
            return NUMBER;
          case "String":
            return STRING;
          case "Bool":
            return BOOL;
          case "Duration":
            return DURATION;
          case "Time":
            return TIME;
          case "Color":
            return { kind: "color" };
          case "Token":
            return { kind: "token" };
          case "Entity":
            return ENTITY;
          case "Attribute":
            return ATTRIBUTE;
          case "Area":
            return AREA;
          case "Device":
            return DEVICE;
          default:
            error(
              "E030",
              t.span,
              `\`${t.name}\` is not a type; types are Number String Bool Duration Time Color Token Entity Attribute Area Device List<…> Enum<…>`,
            );
            return ANY;
        }
    }
  };

  // ───────── components: signatures first, so order of declaration does not matter ─────────

  for (const decl of components) {
    if (BUILTINS.has(decl.name)) {
      error(
        "E002",
        decl.span,
        `\`${decl.name}\` is a built-in; a component cannot take its name, wrap it instead`,
      );
      continue;
    }
    if (infos.has(decl.name)) {
      error("E002", decl.span, `component \`${decl.name}\` is declared twice`);
      continue;
    }
    const params: ComponentInfo["params"] = {};
    for (const param of decl.params) {
      if (params[param.name])
        error("E004", param.span, `parameter \`${param.name}\` given twice on \`${decl.name}\``);
      if (
        GROUP_NAMES.includes(param.name) ||
        param.name === "entities" ||
        param.name === "areas" ||
        param.name === "devices" ||
        param.name === "area" ||
        param.name === "device" ||
        param.name === "now" ||
        FUNCTIONS[param.name]
      ) {
        error("E030", param.span, `parameter \`${param.name}\` shadows a built-in name`);
      }
      params[param.name] = { type: typeFrom(param.type), required: param.default === undefined };
    }
    // A bundled or shared component is there for every page; only this file's own go unused.
    infos.set(decl.name, {
      decl,
      params,
      hasSlot: hasSlot(decl.root),
      used: decl.origin !== undefined,
    });
  }

  // ───────── expressions ─────────

  interface Ctx {
    scope: Scope;
    runtime: Runtime;
    /** Inside a component body: what the component is, for E034 and the server rule. */
    component?: string;
    /** A sensor's `value`: it reads its inputs and nothing else of the house (E070). */
    inputsOnly?: boolean;
  }

  const onlyInputs = (span: Span, what: string) =>
    error("E070", span, `a sensor's value reads only its inputs; ${what}`);

  type Typed = { type: Type; code: CExpr };

  const bad = (code: CExpr = ["lit", null]): Typed => ({ type: ANY, code });

  const expectType = (actual: Type, expected: Type, span: Span, what: string): boolean => {
    if (assignable(actual, expected)) return true;
    const hint =
      expected.kind === "string" && actual.kind === "number" ? "; wrap it in `format()`" : "";
    error(
      "E030",
      span,
      `type mismatch: ${what} expects ${show(expected)}, got ${show(actual)}${hint}`,
    );
    return false;
  };

  const enumFor = (expected: Type | undefined): Type | undefined => {
    if (!expected) return undefined;
    if (expected.kind === "enum") return expected;
    if (expected.kind === "union") return expected.of.find((t) => t.kind === "enum");
    return undefined;
  };

  function resolveEntity(ref: EntityRef, ctx: Ctx): Typed {
    const entity = entityIds.get(ref.id);
    if (!entity) {
      error(
        "E010",
        ref.span,
        `unknown entity \`${ref.id}\`${didYouMean(ref.id, entityIds.keys())}`,
      );
      return bad();
    }
    if (ctx.inputsOnly) {
      onlyInputs(ref.span, `declare \`${ref.id}\` as one: \`input ${ref.object} = ${ref.id}\``);
      return bad();
    }
    entities.add(ref.id);
    if (ref.attr) return { type: ATTRIBUTE, code: ["attr", ref.id, ref.attr] };
    return { type: entityOf(entity.domain), code: ["entity", ref.id] };
  }

  function themeRef(path: string[], span: Span, ctx: Ctx): Typed {
    const type = themePathType(path);
    if (!type) {
      if (isGroupPrefix(path))
        return { type: { kind: "theme", path }, code: ["theme", path.join(".")] };
      const group = path.slice(0, -1).join(".");
      error(
        "E022",
        span,
        isGroupPrefix(path.slice(0, -1))
          ? `theme group \`${group}\` has no key \`${path[path.length - 1]}\``
          : `\`${path.join(".")}\` is not a theme value`,
      );
      return bad();
    }
    const joined = path.join(".");
    // A reference inside a bundled or shared component is theirs, not the page's: it must
    // still be covered, but the page does not carry it.
    const origin = ctx.component ? infos.get(ctx.component)?.decl.origin : undefined;
    if (origin === "bundled") bundledRefs.add(joined);
    else if (origin === "shared") sharedRefs.add(joined);
    else if (!themeRefs.has(joined)) themeRefs.set(joined, span);
    return { type, code: ["theme", joined] };
  }

  /** Types an expression, checking it against `expected` when one is known. */
  function expr(e: Expr, ctx: Ctx, expected?: Type): Typed {
    const result = infer(e, ctx, expected);
    if (expected && e.kind !== "member") expectType(result.type, expected, e.span, "this");
    return result;
  }

  function infer(e: Expr, ctx: Ctx, expected?: Type): Typed {
    switch (e.kind) {
      case "number":
        return { type: NUMBER, code: ["lit", e.value] };
      case "duration":
        return { type: DURATION, code: ["lit", e.ms] };
      case "time":
        return { type: TIME, code: ["lit", e.minutes] };
      case "string":
        return { type: STRING, code: ["lit", e.value] };
      case "bool":
        return { type: BOOL, code: ["lit", e.value] };
      case "null":
        return { type: NULL, code: ["lit", null] };
      case "entity":
        return resolveEntity(e, ctx);
      case "member": {
        // Against a value only known at run time (an entity of unknown domain), any member goes.
        if (expected?.kind === "any") return { type: ANY, code: ["member", e.name] };
        const target = enumFor(expected);
        if (target?.kind !== "enum") {
          error(
            "E041",
            e.span,
            `enum member .${e.name} has no expected type here; give it one, such as a state with a type: state range: Enum<Hour | Day | Week> = .${e.name}`,
          );
          return bad(["member", e.name]);
        }
        if (!target.members.includes(e.name)) {
          error(
            "E030",
            e.span,
            `.${e.name} is not one of ${target.members.map((m) => `.${m}`).join(" ")}`,
          );
        }
        return { type: target, code: ["member", e.name] };
      }
      case "ident":
        return ident(e, ctx, expected);
      case "list": {
        const of = expected?.kind === "list" ? expected.of : undefined;
        const items = e.items.map((item) => expr(item, ctx, of));
        const type =
          of ?? items.reduce<Type>((acc, item) => join(acc, item.type), items[0]?.type ?? ANY);
        return { type: list(type), code: ["list", ...items.map((i) => i.code)] };
      }
      case "access":
        return access(e, ctx);
      case "index": {
        const object = expr(e.object, ctx);
        const index = expr(e.index, ctx, NUMBER);
        const type = object.type.kind === "list" ? object.type.of : ANY;
        if (object.type.kind !== "list" && object.type.kind !== "any") {
          error("E030", e.span, `only a list can be indexed; this is ${show(object.type)}`);
        }
        return { type, code: ["index", object.code, index.code] };
      }
      case "call":
        return call(e, ctx);
      case "unary": {
        if (e.op === "!") {
          const operand = expr(e.operand, ctx, BOOL);
          return { type: BOOL, code: ["un", "!", operand.code] };
        }
        const operand = expr(e.operand, ctx);
        if (!assignable(operand.type, union(NUMBER, DURATION)))
          expectType(operand.type, NUMBER, e.span, "`-`");
        return {
          type: operand.type.kind === "duration" ? DURATION : NUMBER,
          code: ["un", "-", operand.code],
        };
      }
      case "binary":
        return binary(e, ctx, expected);
      case "ternary": {
        const test = expr(e.test, ctx, BOOL);
        const then = expr(e.then, ctx, expected);
        const else_ = expr(e.else, ctx, expected ?? then.type);
        return {
          type: expected ?? join(then.type, else_.type),
          code: ["if", test.code, then.code, else_.code],
        };
      }
    }
  }

  /** `header: AreaHeader`: a component named as a value, for a slot that will instantiate it. */
  function componentRef(e: Extract<Expr, { kind: "ident" }>, slot: Type): Typed {
    const info = infos.get(e.name);
    if (!info) {
      error(
        "E035",
        e.span,
        BUILTINS.has(e.name)
          ? `\`${e.name}\` is a built-in, not a component; a header is a component you declare`
          : `\`${e.name}\` is not a component${didYouMean(e.name, [...infos.keys()])}`,
      );
      return bad(["lit", e.name]);
    }
    info.used = true;
    const type: Type = {
      kind: "component",
      name: e.name,
      params: Object.fromEntries(Object.entries(info.params).map(([k, p]) => [k, p.type])),
      required: Object.entries(info.params)
        .filter(([, p]) => p.required)
        .map(([k]) => k),
    };
    const wanted = slot.kind === "union" ? slot.of.find((t) => t.kind === "component") : slot;
    if (wanted?.kind === "component" && !fitsSlot(type, wanted)) {
      const given = Object.entries(wanted.params)
        .map(([k, t]) => `${k}: ${show(t)}`)
        .join(", ");
      error(
        "E036",
        e.span,
        `\`${e.name}\` cannot draw this header: its parameters must be among ${given}, each of that type or with a default`,
      );
      return bad(["lit", e.name]);
    }
    return { type, code: ["lit", e.name] };
  }

  function ident(e: Extract<Expr, { kind: "ident" }>, ctx: Ctx, expected?: Type): Typed {
    const bound = ctx.scope.get(e.name);
    if (
      !bound &&
      expected &&
      (expected.kind === "component" ||
        (expected.kind === "union" && expected.of.some((t) => t.kind === "component"))) &&
      /^[A-Z]/.test(e.name)
    ) {
      return componentRef(e, expected);
    }
    if (bound) {
      // A lambda's own parameter is bound by the expression, so the server has it too; a
      // sensor's inputs are bound on the server by the sensor.
      if (ctx.runtime === "server" && bound.kind !== "lambda" && bound.kind !== "input") {
        error(
          "E050",
          e.span,
          `server handler reads \`${e.name}\`, ${bound.kind === "state" ? "local state that" : `a ${bound.kind === "param" ? "parameter" : "variable"} that`} only exists in the browser`,
        );
      }
      return { type: bound.type, code: ["var", e.name] };
    }
    if (
      ctx.inputsOnly &&
      ["entities", "areas", "devices", "area", "device", "now"].includes(e.name)
    ) {
      onlyInputs(
        e.span,
        e.name === "now"
          ? "it is computed when an input changes, not as time passes, so `now` would go stale"
          : `\`${e.name}\` is the house; give it the entities as inputs`,
      );
      return bad();
    }
    switch (e.name) {
      case "entities":
        return { type: list(ENTITY), code: ["global", "entities"] };
      case "areas":
        return { type: list(AREA), code: ["global", "areas"] };
      case "devices":
        return { type: list(DEVICE), code: ["global", "devices"] };
      case "area":
        return { type: { kind: "lookup", what: "area" }, code: ["lit", null] };
      case "device":
        return { type: { kind: "lookup", what: "device" }, code: ["lit", null] };
      case "screen":
        if (ctx.runtime === "server")
          error(
            "E050",
            e.span,
            automation
              ? "an automation runs on the server, where there is no `screen`"
              : "server handler reads `screen`, which only exists in the browser",
          );
        return { type: SCREEN, code: ["global", "screen"] };
      case "now":
        return { type: NOW, code: ["global", "now"] };
      case "theme":
        return { type: { kind: "theme", path: [] }, code: ["theme", ""] };
      default:
        break;
    }
    if (GROUP_NAMES.includes(e.name)) {
      if (ctx.runtime === "server")
        error(
          "E050",
          e.span,
          automation
            ? `an automation runs on the server, where there is no theme to read \`${e.name}\` from`
            : `server handler reads \`${e.name}\`, a theme value that only exists in the browser`,
        );
      return themeRef([e.name], e.span, ctx);
    }
    if (FUNCTIONS[e.name]) return { type: { kind: "function", name: e.name }, code: ["lit", null] };
    if (infos.has(e.name) || BUILTINS.has(e.name)) {
      error(
        "E005",
        e.span,
        `\`${e.name}\` is a ${infos.has(e.name) ? "component" : "built-in"}, not a value; a component is only named on a \`header\``,
      );
      return bad();
    }
    const candidates = [
      "areas",
      "devices",
      "screen",
      "now",
      ...GROUP_NAMES,
      ...Object.keys(FUNCTIONS),
    ];
    error("E005", e.span, `unknown name \`${e.name}\`${didYouMean(e.name, candidates)}`);
    return bad();
  }

  function access(e: Extract<Expr, { kind: "access" }>, ctx: Ctx): Typed {
    const object = expr(e.object, ctx);
    const { name } = e;
    const type = object.type;
    const field = (fields: Record<string, Type>, what: string): Typed => {
      const t = fields[name];
      if (!t) {
        error(
          "E003",
          e.nameSpan,
          `\`${name}\` is not a field of ${what}; its fields are ${Object.keys(fields).join(", ")}`,
        );
        return bad();
      }
      return { type: t, code: ["get", object.code, name] };
    };
    switch (type.kind) {
      case "entity": {
        const f = ENTITY_FIELDS[name];
        if (!f) {
          error(
            "E003",
            e.nameSpan,
            `\`${name}\` is not a field of an entity; its fields are ${Object.keys(ENTITY_FIELDS).join(", ")}`,
          );
          return bad();
        }
        return { type: f(type.domain), code: ["get", object.code, name] };
      }
      case "attribute":
        return field(ATTRIBUTE_FIELDS, "an attribute");
      case "area":
        return field(AREA_FIELDS, "an area");
      case "device":
        return field(DEVICE_FIELDS, "a device");
      case "now":
        return field(NOW_FIELDS, "`now`");
      case "record":
      case "any":
        return { type: ANY, code: ["get", object.code, name] };
      case "lookup": {
        const known = type.what === "area" ? areaIds : deviceIds;
        if (!known.has(name)) {
          error("E010", e.nameSpan, `unknown ${type.what} \`${name}\`${didYouMean(name, known)}`);
          return bad();
        }
        if (type.what === "device") devices.add(name);
        return { type: type.what === "area" ? AREA : DEVICE, code: ["lookup", type.what, name] };
      }
      case "theme": {
        if (ctx.runtime === "server")
          error(
            "E050",
            e.span,
            automation
              ? "an automation runs on the server, where there is no theme value to read"
              : "server handler reads a theme value, which only exists in the browser",
          );
        return themeRef([...type.path, name], e.span, ctx);
      }
      default:
        error("E003", e.nameSpan, `\`${name}\` is not a field of ${show(type)}`);
        return bad();
    }
  }

  function call(e: Extract<Expr, { kind: "call" }>, ctx: Ctx): Typed {
    if (e.callee.kind !== "ident" || !FUNCTIONS[e.callee.name]) {
      if (e.callee.kind === "ident" && !ctx.scope.get(e.callee.name)) {
        error(
          "E005",
          e.callee.span,
          `unknown function \`${e.callee.name}\`${didYouMean(e.callee.name, Object.keys(FUNCTIONS))}`,
        );
      } else {
        error("E030", e.span, "only a library function can be called; there are no user functions");
      }
      return bad();
    }
    const name = e.callee.name;
    const spec = FUNCTIONS[name] as (typeof FUNCTIONS)[string];
    if (ctx.inputsOnly && READS_NOW.has(name)) {
      onlyInputs(
        e.callee.span,
        `\`${name}\` reads the clock, and a sensor is computed when an input changes, not as time passes`,
      );
    }
    const bindings = new Map<string, Type>();
    const args: (CExpr | CFn)[] = [];
    const required = spec.params.filter((p) => !p.optional).length;
    if (e.args.length < required || (!spec.rest && e.args.length > spec.params.length)) {
      error(
        "E030",
        e.span,
        `\`${name}\` takes ${spec.rest ? `at least ${required}` : required === spec.params.length ? required : `${required} to ${spec.params.length}`} argument${required === 1 && !spec.rest ? "" : "s"}`,
      );
    }
    e.args.forEach((arg, i) => {
      const param = spec.params[i] ?? (spec.rest ? { type: spec.rest } : undefined);
      if (!param) return;
      if (param.lambda) {
        if (arg.kind !== "lambda") {
          error("E030", arg.span, `\`${name}\` wants a lambda here, such as (e) => e.value == .On`);
          return;
        }
        const paramTypes = param.lambda.map((t) => substitute(t, bindings));
        const bound: Record<string, Binding> = {};
        arg.params.forEach((p, k) => {
          bound[p.name] = { type: paramTypes[k] ?? ANY, kind: "lambda" };
        });
        if (Array.isArray(arg.body)) {
          error("E030", arg.span, "a lambda passed to a function is an expression, not statements");
          return;
        }
        const body = expr(
          arg.body,
          { ...ctx, scope: ctx.scope.child(bound) },
          substitute(param.type, bindings),
        );
        args.push(["fn", arg.params.map((p) => p.name), body.code]);
        return;
      }
      if (arg.kind === "lambda") {
        error("E030", arg.span, `\`${name}\` does not take a lambda here`);
        return;
      }
      const typed = expr(arg, ctx, hasVar(param.type) ? undefined : param.type);
      if (hasVar(param.type)) bind(param.type, typed.type, bindings);
      args.push(typed.code);
    });
    return { type: substitute(spec.returns, bindings), code: ["call", name, ...args] };
  }

  /** Binds a signature's generics from an argument's type: `List<T>` against `List<Entity>`. */
  function bind(pattern: Type, actual: Type, bindings: Map<string, Type>): void {
    if (pattern.kind === "var") {
      if (!bindings.has(pattern.name) && actual.kind !== "any") bindings.set(pattern.name, actual);
    } else if (pattern.kind === "list" && actual.kind === "list")
      bind(pattern.of, actual.of, bindings);
  }

  function binary(e: Extract<Expr, { kind: "binary" }>, ctx: Ctx, expected?: Type): Typed {
    const { op } = e;
    const code = (l: Typed, r: Typed, type: Type): Typed => ({
      type,
      code: ["bin", op, l.code, r.code],
    });
    switch (op) {
      case "&&":
      case "||":
        return code(expr(e.left, ctx, BOOL), expr(e.right, ctx, BOOL), BOOL);
      case "??": {
        const left = expr(e.left, ctx, expected);
        const right = expr(
          e.right,
          ctx,
          expected ?? (left.type.kind === "any" ? undefined : left.type),
        );
        return code(left, right, expected ?? join(left.type, right.type));
      }
      case "==":
      case "!=": {
        // The side that is not an enum member goes first, so the member learns its enum.
        const [first, second] = e.left.kind === "member" ? [e.right, e.left] : [e.left, e.right];
        const a = expr(first, ctx);
        const b = infer(second, ctx, a.type);
        if (second.kind !== "member") {
          if (
            (a.type.kind === "enum" && b.type.kind === "string") ||
            (a.type.kind === "string" && b.type.kind === "enum")
          ) {
            const members = (
              a.type.kind === "enum" ? a.type : (b.type as { members: readonly string[] })
            ).members;
            error(
              "E040",
              e.span,
              `comparing enum ${members.join(" | ")} to a String; use .${members[0]}`,
            );
          } else if (!comparable(a.type) || !comparable(b.type)) {
            error("E030", e.span, `${show(a.type)} and ${show(b.type)} cannot be compared`);
          } else {
            // `weather.home#rain == "x"` compares the attribute itself, never its value.
            const [ref, plain, refExpr] = isReference(a.type)
              ? [a.type, b.type, first]
              : [b.type, a.type, second];
            if (isReference(ref) && isPlainValue(plain)) {
              const written =
                refExpr.kind === "entity"
                  ? `${refExpr.id}${refExpr.attr ? `#${refExpr.attr}` : ""}`
                  : undefined;
              error(
                "E030",
                e.span,
                `${ref.kind === "attribute" ? "an attribute" : "an entity"} is not its value, so this is never equal; compare ${written ? `\`${written}.value\`` : "its `.value`"}`,
              );
            }
          }
        }
        const [l, r] = e.left.kind === "member" ? [b, a] : [a, b];
        return code(l, r, BOOL);
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const l = expr(e.left, ctx);
        const r = expr(e.right, ctx, ordered(l.type) && l.type.kind !== "any" ? l.type : undefined);
        if (!ordered(l.type) || !ordered(r.type)) {
          error(
            "E030",
            e.span,
            `\`${op}\` compares Numbers, Durations, Times or Strings; got ${show(l.type)} and ${show(r.type)}`,
          );
        }
        return code(l, r, BOOL);
      }
      case "+": {
        const l = expr(e.left, ctx);
        const r = expr(e.right, ctx);
        if (l.type.kind === "string" || r.type.kind === "string") return code(l, r, STRING);
        if (l.type.kind === "duration" && r.type.kind === "duration") return code(l, r, DURATION);
        if (l.type.kind === "any" || r.type.kind === "any") return code(l, r, ANY);
        expectType(l.type, NUMBER, e.left.span, "`+`");
        expectType(r.type, NUMBER, e.right.span, "`+`");
        return code(l, r, NUMBER);
      }
      default: {
        const l = expr(e.left, ctx);
        const r = expr(e.right, ctx);
        if (l.type.kind === "duration" && r.type.kind === "duration" && op === "-")
          return code(l, r, DURATION);
        if (
          (l.type.kind === "duration") !== (r.type.kind === "duration") &&
          l.type.kind !== "any" &&
          r.type.kind !== "any"
        ) {
          error(
            "E030",
            e.span,
            "arithmetic between a Duration and a Number is an error; both sides must be the same",
          );
        } else {
          if (l.type.kind !== "duration") expectType(l.type, NUMBER, e.left.span, `\`${op}\``);
          if (r.type.kind !== "duration") expectType(r.type, NUMBER, e.right.span, `\`${op}\``);
        }
        return code(l, r, NUMBER);
      }
    }
  }

  // ───────── statements ─────────

  function statements(list_: Statement[], ctx: Ctx, where: "server" | "browser"): CStmt[] {
    const out: CStmt[] = [];
    for (const s of list_) {
      const compiled = statement(s, ctx, where);
      if (compiled) out.push(compiled);
    }
    return out;
  }

  function runStatement(
    s: Extract<Statement, { kind: "run" }>,
    ctx: Ctx,
    where: "server" | "browser",
  ): CStmt | undefined {
    if (where === "browser") {
      error(
        "E050",
        s.span,
        "`run` reaches an integration, which only an automation or an `on` handler can do",
      );
      return undefined;
    }
    const known = registry.integrations;
    const instance = known?.find((i) => runName(i.id) === runName(s.integration));
    if (known && !instance) {
      const names = known.map((i) => runName(i.id));
      error(
        "E010",
        s.integrationSpan,
        `unknown integration \`${s.integration}\`${didYouMean(s.integration, names)}`,
      );
      return undefined;
    }
    const actions = instance?.actions;
    const action = actions?.find((a) => a.name === s.action);
    if (actions && !action) {
      error(
        "E060",
        s.span,
        actions.length
          ? `${s.integration} has no action \`${s.action}\`; it has ${actions.map((a) => a.name).join(", ")}`
          : `${s.integration} has no actions`,
      );
      return undefined;
    }
    const { params, open, required } = actionParams(action?.schema);
    const args: Record<string, CExpr> = {};
    for (const arg of s.args) {
      const type = params[arg.name] ?? (open ? ANY : undefined);
      if (!type) {
        const names = Object.keys(params);
        error(
          "E060",
          arg.span,
          `\`${s.action}\` takes no \`${arg.name}\`${names.length ? `; it takes ${names.join(", ")}` : ""}`,
        );
        continue;
      }
      args[arg.name] = expr(arg.value, ctx, type).code;
    }
    for (const name of required) {
      if (!(name in args)) error("E060", s.span, `\`${s.action}\` needs \`${name}\``);
    }
    return ["run", instance?.id ?? s.integration, s.action, args];
  }

  function statement(s: Statement, ctx: Ctx, where: "server" | "browser"): CStmt | undefined {
    switch (s.kind) {
      case "call": {
        const entity = entityIds.get(s.entity.id);
        if (!entity) {
          error(
            "E010",
            s.entity.span,
            `unknown entity \`${s.entity.id}\`${didYouMean(s.entity.id, entityIds.keys())}`,
          );
          return undefined;
        }
        entities.add(entity.id);
        const commands = COMMANDS[entity.domain];
        const argTypes = commands[s.command];
        if (!argTypes) {
          const names = Object.keys(commands);
          error(
            "E060",
            s.span,
            names.length
              ? `a ${entity.domain} has no command \`${s.command}\`; it takes ${names.join(", ")}`
              : `a ${entity.domain} takes no commands`,
          );
          return undefined;
        }
        const args: Record<string, CExpr> = {};
        for (const arg of s.args) {
          const type = argTypes[arg.name];
          if (!type) {
            error(
              "E060",
              arg.span,
              `command \`${s.command}\` takes no argument \`${arg.name}\` for a ${entity.domain}${Object.keys(argTypes).length ? `; it takes ${Object.keys(argTypes).join(", ")}` : ""}`,
            );
            continue;
          }
          args[arg.name] = expr(arg.value, ctx, type).code;
        }
        for (const name of REQUIRED_ARGS[`${entity.domain}.${s.command}`] ?? []) {
          if (!(name in args)) error("E060", s.span, `command \`${s.command}\` needs \`${name}\``);
        }
        return ["call", entity.id, s.command, args];
      }
      case "run":
        return runStatement(s, ctx, where);
      case "set": {
        if (where === "server") {
          error(
            "E050",
            s.span,
            automation
              ? "an automation has no state to `set`; it runs on the server"
              : "server handler sets local state, which only exists in the browser",
          );
          return undefined;
        }
        const bound = ctx.scope.get(s.name);
        if (!bound) {
          error("E034", s.span, `\`set\` targets \`${s.name}\`, which is not declared state`);
          return undefined;
        }
        if (bound.kind !== "state") {
          error(
            "E034",
            s.span,
            `\`set\` targets \`${s.name}\`, which is a ${bound.kind === "param" ? "parameter" : "variable"}, not state`,
          );
          return undefined;
        }
        return ["set", s.name, expr(s.value, ctx, bound.type).code];
      }
      case "if": {
        const test = expr(s.test, ctx, BOOL);
        return [
          "if",
          test.code,
          statements(s.then, ctx, where),
          s.else ? statements(s.else, ctx, where) : undefined,
        ];
      }
      case "after": {
        if (where === "browser") {
          error("E061", s.span, "`after` is only allowed in server handlers");
          return undefined;
        }
        return ["after", s.ms, statements(s.body, ctx, where)];
      }
    }
  }

  // ───────── nodes ─────────

  function lambdaProp(lambda: Lambda, type: Type, ctx: Ctx): CHandler {
    const params = type.kind === "event" ? type.params : [];
    const bound: Record<string, Binding> = {};
    lambda.params.forEach((p, i) => {
      bound[p.name] = { type: params[i] ?? ANY, kind: "lambda" };
    });
    if (lambda.params.length > params.length) {
      error(
        "E030",
        lambda.span,
        `this event has ${params.length} argument${params.length === 1 ? "" : "s"}, the lambda names ${lambda.params.length}`,
      );
    }
    const inner = { ...ctx, scope: ctx.scope.child(bound), runtime: "browser" as const };
    if (Array.isArray(lambda.body))
      return {
        params: lambda.params.map((p) => p.name),
        body: statements(lambda.body, inner, "browser"),
      };
    error("E030", lambda.span, "an event handler is statements: set, call, if");
    return { params: lambda.params.map((p) => p.name), body: [] };
  }

  function node(n: Node, ctx: Ctx): CNode {
    const builtin = BUILTINS.get(n.type);
    const component = infos.get(n.type);
    const at: [number, number] = [n.nameSpan.line, n.nameSpan.col];
    if (!builtin && !component) {
      error(
        "E002",
        n.nameSpan,
        n.type === "Room"
          ? "`Room` is now `Area`, its area given as `of`: `Area { of: area.hall }`"
          : `unknown built-in or component \`${n.type}\`${didYouMean(n.type, [...BUILTINS.keys(), ...infos.keys()])}`,
      );
      for (const child of n.children) if (child.kind !== "children") childNode(child, ctx);
      return { t: "node", type: n.type, props: {}, children: [], at };
    }
    const specs: Record<string, PropSpec> = builtin
      ? propsOf(builtin)
      : {
          ...COMMON_PROPS,
          ...Object.fromEntries(
            Object.entries((component as ComponentInfo).params).map(([k, p]) => [
              k,
              { type: p.type, required: p.required },
            ]),
          ),
        };
    if (component) component.used = true;

    const props: CNode["props"] = {};
    const seen = new Map<string, Prop>();
    const bindings = new Map<string, Type>();
    const typedProps: { prop: Prop; spec: PropSpec }[] = [];
    for (const prop of n.props) {
      const spec = specs[prop.name];
      if (!spec && n.type === "Area" && prop.name === "area" && builtin) {
        error("E003", prop.span, "`Area` takes its area as `of` now: `Area { of: area.hall }`");
        continue;
      }
      if (!spec) {
        error(
          "E003",
          prop.span,
          `property \`${prop.name}\` is not defined on \`${n.type}\`; its properties are ${Object.keys(specs).join(", ")}${didYouMean(prop.name, Object.keys(specs))}`,
        );
        continue;
      }
      if (seen.has(prop.name)) {
        error("E004", prop.span, `property \`${prop.name}\` given twice on this \`${n.type}\``);
        continue;
      }
      seen.set(prop.name, prop);
      typedProps.push({ prop, spec });
    }
    // A generic (`Segmented`'s T) is bound by a sibling that is exactly T, so those go first.
    typedProps.sort(
      (a, b) => Number(a.spec.type.kind !== "var") - Number(b.spec.type.kind !== "var"),
    );
    let ofDomain: Domain | undefined;
    for (const { prop, spec } of typedProps) {
      const type = substitute(spec.type, bindings);
      if (prop.value.kind === "lambda") {
        if (type.kind !== "event") {
          error(
            "E030",
            prop.span,
            `\`${prop.name}\` is not an event; a lambda only goes on onPress, onToggle and onChange`,
          );
          continue;
        }
        props[prop.name] = { h: lambdaProp(prop.value, type, ctx) };
        continue;
      }
      if (type.kind === "event") {
        error(
          "E030",
          prop.span,
          `\`${prop.name}\` is an event; give it a lambda such as () => call light.hall.turn_on`,
        );
        continue;
      }
      const typed = expr(prop.value, ctx, hasVar(type) ? undefined : type);
      if (hasVar(type)) bind(type, typed.type, bindings);
      if (
        spec.icon &&
        prop.value.kind === "string" &&
        registry.icons &&
        !registry.icons.includes(prop.value.value)
      ) {
        error(
          "E013",
          prop.value.span,
          `unknown icon \`${prop.value.value}\`; the gallery lists the icon names${didYouMean(prop.value.value, registry.icons)}`,
        );
      }
      if (prop.name === "of" && typed.type.kind === "entity") ofDomain = typed.type.domain;
      props[prop.name] = { e: typed.code };
    }
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.required && !seen.has(name)) {
        error(
          "E033",
          n.nameSpan,
          `required ${builtin ? "property" : "parameter"} \`${name}\` missing on \`${n.type}\``,
        );
      }
    }
    if (builtin?.ofDomains && ofDomain && !builtin.ofDomains.includes(ofDomain)) {
      const of = seen.get("of") as Prop;
      const id = of.value.kind === "entity" ? of.value.id : "it";
      error(
        "E012",
        of.span,
        `\`${n.type}\` needs a ${builtin.ofDomains.join(" or ")} entity; \`${id}\` is a ${ofDomain}`,
      );
    }
    // A list of controls (a ButtonGroup's) is checked item by item, where the items are named.
    const ofList = seen.get("of");
    if (builtin?.ofDomains && ofList?.value.kind === "list") {
      for (const item of ofList.value.items) {
        if (
          item.kind !== "entity" ||
          item.attr ||
          (builtin.ofDomains as readonly string[]).includes(item.domain)
        )
          continue;
        error(
          "E012",
          item.span,
          `\`${n.type}\` needs a ${builtin.ofDomains.join(" or ")} entity; \`${item.domain}.${item.object}\` is a ${item.domain}`,
        );
      }
    }
    if (builtin?.retired)
      diagnostics.warn("W104", n.nameSpan, `\`${n.type}\` is retired: ${builtin.retired}`);
    if (prop_is_literal_true(seen.get("when")))
      diagnostics.warn("W100", (seen.get("when") as Prop).span, "`when: true` has no effect");
    if (n.type === "Grid") gridColumns(n, seen.get("columns"));
    if (n.type === "Map") mapPlace(n, seen);

    const children: CChild[] = [];
    if (n.children.length > 0) {
      const allowed = builtin ? builtin.children : (component as ComponentInfo).hasSlot;
      if (!allowed) {
        error("E031", n.children[0]?.span ?? n.span, `\`${n.type}\` takes no children`);
      } else {
        for (const child of n.children) {
          const compiled = childNode(child, ctx);
          if (compiled) children.push(compiled);
        }
      }
    }
    return { t: "node", type: n.type, props, children, at };
  }

  const prop_is_literal_true = (p: Prop | undefined) =>
    p?.value.kind === "bool" && p.value.value === true;

  /**
   * A Grid has 1 to `GRID_COLUMNS_MAX` columns. Written as a number, it is checked here; a
   * computed one (`screen == .Phone ? 1 : 3`) is clamped when drawn. Left out, the Grid has
   * one column per child, so its children must be countable: nodes, not a `for` or the
   * caller's `children`.
   */
  function gridColumns(n: Node, columns: Prop | undefined): void {
    if (!columns) {
      const uncounted = n.children.find((child) => child.kind !== "node");
      if (uncounted) {
        const what = uncounted.kind === "for" ? "a `for`" : "`children`";
        error(
          "E037",
          uncounted.span,
          `a \`Grid\` without \`columns\` has one per child, so its children cannot be ${what}; give it \`columns\` (1 to ${GRID_COLUMNS_MAX})`,
        );
      }
      return;
    }
    const literal = literalNumber(columns.value);
    if (literal !== undefined && (literal < 1 || literal > GRID_COLUMNS_MAX || literal % 1 !== 0)) {
      error(
        "E037",
        columns.value.span,
        `a \`Grid\` has 1 to ${GRID_COLUMNS_MAX} columns, not ${literal}`,
      );
    }
  }

  /**
   * A Map is of an entity or at a place: `latitude` with `longitude`, both or neither. A zoom
   * written as a number is one the tiles have, 0 to `MAP_ZOOM_MAX`; a computed one is clamped
   * when drawn.
   */
  function mapPlace(n: Node, seen: Map<string, Prop>): void {
    const latitude = seen.get("latitude");
    const longitude = seen.get("longitude");
    const half = latitude && !longitude ? "latitude" : longitude && !latitude ? "longitude" : "";
    if (half) {
      const other = half === "latitude" ? "longitude" : "latitude";
      error(
        "E038",
        (seen.get(half) as Prop).span,
        `a \`Map\` given \`${half}\` needs \`${other}\` too`,
      );
    } else if (!latitude && !seen.has("of")) {
      error(
        "E038",
        n.nameSpan,
        "a `Map` needs a place: `of` an entity with a location, or `latitude` and `longitude`",
      );
    }
    const zoom = seen.get("zoom");
    const literal = zoom && literalNumber(zoom.value);
    if (
      zoom &&
      literal !== undefined &&
      (literal < 0 || literal > MAP_ZOOM_MAX || literal % 1 !== 0)
    ) {
      error("E038", zoom.value.span, `a \`Map\`'s zoom is 0 to ${MAP_ZOOM_MAX}, not ${literal}`);
    }
  }

  function childNode(child: Child, ctx: Ctx): CChild | undefined {
    switch (child.kind) {
      case "node":
        return node(child, ctx);
      case "children":
        if (!ctx.component) {
          error(
            "E031",
            child.span,
            "`children` only goes inside a component, where the caller's nodes render",
          );
          return undefined;
        }
        return { t: "children" };
      case "for": {
        const listed = expr(child.list, ctx);
        let of: Type = ANY;
        let isList = true;
        if (listed.type.kind === "list") of = listed.type.of;
        else if (listed.type.kind !== "any") {
          isList = false;
          error("E030", child.list.span, `\`for\` needs a list; this is ${show(listed.type)}`);
        }
        const inner = {
          ...ctx,
          scope: ctx.scope.child({ [child.variable]: { type: of, kind: "for" } }),
        };
        const where = child.where ? expr(child.where, inner, BOOL) : undefined;
        const children: CChild[] = [];
        const keyed = child.children.every(
          (c) => c.kind !== "node" || c.props.some((p) => p.name === "key"),
        );
        if (
          isList &&
          !keyed &&
          of.kind !== "entity" &&
          of.kind !== "area" &&
          of.kind !== "device"
        ) {
          diagnostics.warn(
            "W102",
            child.span,
            "`for` over a list without a `key`; items will be keyed by index",
          );
        }
        for (const c of child.children) {
          const compiled = childNode(c, inner);
          if (compiled) children.push(compiled);
        }
        return {
          t: "for",
          var: child.variable,
          list: listed.code,
          where: where?.code,
          children,
          at: [child.span.line, child.span.col],
        };
      }
    }
  }

  // ───────── state ─────────

  function stateDecls(
    decls: StateDecl[],
    scope: Scope,
    ctx: Omit<Ctx, "scope">,
  ): { bound: Record<string, Binding>; compiled: { name: string; init: CExpr }[] } {
    const bound: Record<string, Binding> = {};
    const compiled: { name: string; init: CExpr }[] = [];
    for (const decl of decls) {
      if (bound[decl.name] || scope.get(decl.name)) {
        error("E004", decl.span, `\`${decl.name}\` is already declared`);
        continue;
      }
      const declared = decl.type ? typeFrom(decl.type) : undefined;
      // Initialisers see what came before them, not the state they declare.
      const init = expr(decl.init, { ...ctx, scope: scope.child(bound) }, declared);
      bound[decl.name] = { type: declared ?? init.type, kind: "state" };
      compiled.push({ name: decl.name, init: init.code });
    }
    return { bound, compiled };
  }

  // ───────── components ─────────

  const compiled: Record<string, CComponent> = {};
  const checking = new Set<string>();
  const stack: string[] = [];

  function compileComponent(info: ComponentInfo): void {
    if (compiled[info.decl.name] || checking.has(info.decl.name)) return;
    checking.add(info.decl.name);
    stack.push(info.decl.name);
    const params: Record<string, Binding> = {};
    const defaults: CComponent["params"] = [];
    for (const param of info.decl.params) {
      const type = (info.params[param.name] as { type: Type }).type;
      params[param.name] = { type, kind: "param" };
      const defaultCode = param.default
        ? expr(
            param.default,
            { scope: Scope.empty(), runtime: "browser", component: info.decl.name },
            type,
          ).code
        : undefined;
      defaults.push({ name: param.name, default: defaultCode });
    }
    const scope = Scope.empty().child(params);
    const ctx: Ctx = { scope, runtime: "browser", component: info.decl.name };
    const state = stateDecls(info.decl.state, scope, ctx);
    const body: Ctx = { ...ctx, scope: scope.child(state.bound) };
    const root = node(info.decl.root, body);
    compiled[info.decl.name] = {
      name: info.decl.name,
      params: defaults,
      state: state.compiled,
      root,
    };
    stack.pop();
    checking.delete(info.decl.name);
  }

  // Recursion shows up as a node naming a component that is being checked: find it by walking
  // the component graph, which is cheaper to explain than to detect mid-walk.
  const uses = (decl: ComponentDecl): string[] => {
    const names = new Set<string>();
    const walk = (children: Child[]) => {
      for (const c of children) {
        if (c.kind === "node") {
          if (infos.has(c.type)) names.add(c.type);
          walk(c.children);
        } else if (c.kind === "for") walk(c.children);
      }
    };
    walk([decl.root]);
    return [...names];
  };
  const recursive = new Set<string>();
  for (const info of infos.values()) {
    const path = [info.decl.name];
    const visit = (name: string): boolean => {
      const next = infos.get(name);
      if (!next) return false;
      for (const used of uses(next.decl)) {
        if (used === info.decl.name) {
          const via = path.length > 1 ? ` through \`${path[1]}\`` : "";
          error("E032", info.decl.span, `component \`${info.decl.name}\` uses itself${via}`);
          recursive.add(info.decl.name);
          return true;
        }
        if (path.includes(used)) continue;
        path.push(used);
        const found = visit(used);
        path.pop();
        if (found) return true;
      }
      return false;
    };
    visit(info.decl.name);
  }
  for (const info of infos.values()) {
    if (!recursive.has(info.decl.name)) compileComponent(info);
  }

  // ───────── the page ─────────

  const pageScope = Scope.empty();
  const pageCtx: Ctx = { scope: pageScope, runtime: "browser" };
  const state = stateDecls(page.state, pageScope, pageCtx);
  const bodyCtx: Ctx = { ...pageCtx, scope: pageScope.child(state.bound) };
  const root = node(page.root, bodyCtx);

  const serverHandlers: CServerHandler[] = [];
  for (const handler of page.handlers) {
    const compiledHandler = serverHandler(handler, bodyCtx);
    if (compiledHandler) serverHandlers.push(compiledHandler);
  }

  for (const info of infos.values()) {
    if (!info.used)
      diagnostics.warn("W101", info.decl.span, `component \`${info.decl.name}\` is never used`);
  }

  // ───────── a sensor ─────────

  function checkSensor(decl: SensorDecl): CSensor | undefined {
    const house: Ctx = { scope: Scope.empty(), runtime: "server" };
    const bound: Record<string, Binding> = {};
    const inputs: CSensor["inputs"] = [];
    for (const input of decl.inputs) {
      if (bound[input.name]) {
        error("E004", input.span, `input \`${input.name}\` is declared twice`);
        continue;
      }
      const typed = infer(input.value, house);
      const entityOrList =
        typed.type.kind === "entity" ||
        typed.type.kind === "any" ||
        (typed.type.kind === "list" &&
          (typed.type.of.kind === "entity" || typed.type.of.kind === "any"));
      if (!entityOrList) {
        error(
          "E030",
          input.value.span,
          `an input is an entity or a list of entities, got ${show(typed.type)}`,
        );
      }
      bound[input.name] = { type: typed.type, kind: "input" };
      inputs.push({ name: input.name, value: typed.code });
    }

    const KNOWN = ["name", "type", "value", "unit", "class"];
    const seen = new Map<string, Prop>();
    for (const prop of decl.props) {
      if (!KNOWN.includes(prop.name)) {
        error(
          "E003",
          prop.span,
          `property \`${prop.name}\` is not defined on a sensor; its properties are ${KNOWN.join(", ")}${didYouMean(prop.name, KNOWN)}`,
        );
      } else if (seen.has(prop.name)) {
        error("E004", prop.span, `property \`${prop.name}\` given twice on this sensor`);
      } else seen.set(prop.name, prop);
    }
    for (const name of ["name", "type", "value"]) {
      if (!seen.has(name))
        error(
          "E033",
          decl.span,
          `required property \`${name}\` missing on sensor \`${decl.name}\``,
        );
    }
    const literal = (prop: Prop | undefined, what: string): string | undefined => {
      if (!prop) return undefined;
      if (prop.value.kind === "string") return prop.value.value;
      error(
        "E030",
        prop.span,
        `a sensor's ${what} is written as a string, such as "${what === "name" ? "Kitchen door" : "°C"}"`,
      );
      return undefined;
    };
    const name = literal(seen.get("name"), "name");
    const typeProp = seen.get("type");
    let type: CSensorType | undefined;
    if (typeProp) {
      const v = typeProp.value;
      if (v.kind === "ident" && v.name in SENSOR_TYPES) type = v.name as CSensorType;
      else error("E030", typeProp.span, "a sensor's `type` is String, Number or Bool");
    }
    const unitProp = seen.get("unit");
    const unit = literal(unitProp, "unit");
    if (unitProp && type && type !== "Number") {
      error("E030", unitProp.span, `a ${type} sensor has no \`unit\`; only a Number does`);
    }
    const classProp = seen.get("class");
    let cls: string | undefined;
    if (classProp && type) {
      const members =
        type === "Number" ? SENSOR_CLASS_MEMBERS : type === "Bool" ? BINARY_CLASS_MEMBERS : [];
      const v = classProp.value;
      if (!members.length) {
        error("E030", classProp.span, "a String sensor has no `class`; a Number or a Bool does");
      } else if (v.kind !== "member" || !members.includes(v.name)) {
        error(
          "E030",
          classProp.span,
          `a ${type} sensor's \`class\` is one of ${members.map((m) => `.${m}`).join(" ")}`,
        );
      } else cls = v.name.toLowerCase();
    }
    const valueProp = seen.get("value");
    let value: CExpr | undefined;
    if (valueProp?.value.kind === "lambda") {
      error("E030", valueProp.span, "a sensor's `value` is an expression, not a handler");
    } else if (valueProp) {
      const ctx: Ctx = { scope: Scope.empty().child(bound), runtime: "server", inputsOnly: true };
      value = expr(valueProp.value, ctx, type ? SENSOR_TYPES[type] : undefined).code;
    }
    if (name === undefined || !type || !value || !valueProp) return undefined;
    return {
      name,
      type,
      ...(unit !== undefined ? { unit } : {}),
      ...(cls !== undefined ? { class: cls } : {}),
      inputs,
      value,
      line: valueProp.span.line,
    };
  }

  const sensor = sensorDecl ? checkSensor(sensorDecl) : undefined;

  return {
    components: compiled,
    state: state.compiled,
    root,
    serverHandlers,
    sensor,
    themeRefs,
    sharedRefs,
    bundledRefs,
    entities,
    devices,
    name: page.name,
  };

  function serverHandler(handler: Handler, ctx: Ctx): CServerHandler | undefined {
    const server: Ctx = { ...ctx, runtime: "server" };
    let trigger: CTrigger;
    const t = handler.trigger;
    switch (t.kind) {
      case "every":
        if (t.ms < 60_000) {
          error("E030", t.span, "`every` runs at most once a minute; the smallest interval is 1m");
          return undefined;
        }
        trigger = { kind: "every", ms: t.ms };
        break;
      case "at":
        trigger = { kind: "at", minutes: t.minutes };
        break;
      case "changed": {
        const entity = entityIds.get(t.entity.id);
        if (!entity) {
          error(
            "E010",
            t.entity.span,
            `unknown entity \`${t.entity.id}\`${didYouMean(t.entity.id, entityIds.keys())}`,
          );
          return undefined;
        }
        entities.add(entity.id);
        const valueType = t.attr ? ANY : DOMAIN_VALUE[entity.domain];
        const to = t.to ? expr(t.to, server, valueType).code : undefined;
        const from = t.from ? expr(t.from, server, valueType).code : undefined;
        if (entity.domain === "sensor" && !t.attr && !t.to && !t.from) {
          diagnostics.warn(
            "W103",
            t.span,
            `handler fires on every change of \`${entity.id}\`, which may report every few seconds`,
          );
        }
        trigger = { kind: "changed", entity: entity.id, attr: t.attr, to, from };
        break;
      }
    }
    const body = statements(handler.body, server, "server");
    return { trigger, body, line: handler.span.line };
  }
}

function hasSlot(root: Node): boolean {
  const walk = (children: Child[]): boolean =>
    children.some((c) => c.kind === "children" || walk(c.children));
  return walk([root]);
}

/** The arguments a `call` may name, for the command executor. */
export const COMMAND_ARGS = COMMANDS;
