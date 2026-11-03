// casa/ast.ts
// The syntax tree the parser builds. Every node carries the span it came from, so a
// diagnostic and the editor's "where is this defined" both have a line to point at.

import type { Span } from "./diagnostics.ts";

export interface File {
  themes: ThemeDecl[];
  components: ComponentDecl[];
  pages: PageDecl[];
  automations: AutomationDecl[];
  sensors: SensorDecl[];
}

// ───────── themes ─────────

export interface ThemeDecl {
  kind: "theme";
  name: string;
  extends?: string;
  groups: ThemeGroup[];
  span: Span;
}

export interface ThemeGroup {
  /** `surface.card` → ["surface", "card"]. */
  path: string[];
  entries: ThemeEntry[];
  span: Span;
}

export interface ThemeEntry {
  key: string;
  value: ThemeValue;
  span: Span;
}

export type ThemeValue =
  | { kind: "color"; hex: string; span: Span }
  | { kind: "number"; value: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  /** `palette.plaster`, or a bare word such as `hairline`. */
  | { kind: "ref"; path: string[]; span: Span };

// ───────── components and pages ─────────

export interface ComponentDecl {
  kind: "component";
  name: string;
  params: Param[];
  state: StateDecl[];
  root: Node;
  span: Span;
  /** Where it came from when not this file: Casita's own defaults, or the house's shared file. */
  origin?: "bundled" | "shared";
}

export interface Param {
  name: string;
  type: TypeExpr;
  default?: Expr;
  span: Span;
}

export interface StateDecl {
  name: string;
  type?: TypeExpr;
  init: Expr;
  span: Span;
}

export interface PageDecl {
  kind: "page";
  name: string;
  state: StateDecl[];
  root: Node;
  handlers: Handler[];
  span: Span;
}

/** Handlers with no page: every one runs on the server, under its own cancel scope. */
export interface AutomationDecl {
  kind: "automation";
  name: string;
  handlers: Handler[];
  span: Span;
}

/**
 * A derived sensor: its inputs are entities, and its `value` is an expression over them
 * alone, of the declared `type`. The server keeps it as an entity of its own.
 */
export interface SensorDecl {
  kind: "sensor";
  name: string;
  inputs: InputDecl[];
  /** `name`, `type`, `value`, and `unit` or `class` where the type allows. */
  props: Prop[];
  span: Span;
}

/** `input door = binary_sensor.kitchen_door`: an entity, or a list of them. */
export interface InputDecl {
  name: string;
  value: Expr;
  span: Span;
}

export type TypeExpr =
  | { kind: "name"; name: string; span: Span }
  | { kind: "list"; of: TypeExpr; span: Span }
  | { kind: "enum"; members: string[]; span: Span };

export interface Node {
  kind: "node";
  type: string;
  props: Prop[];
  children: Child[];
  span: Span;
  /** Where the type name stands, for "unknown built-in" and the editor's jump. */
  nameSpan: Span;
}

export interface Prop {
  name: string;
  value: Expr | Lambda;
  span: Span;
}

export type Child = Node | Repeat | Slot;

export interface Repeat {
  kind: "for";
  variable: string;
  list: Expr;
  where?: Expr;
  children: Child[];
  span: Span;
}

export interface Slot {
  kind: "children";
  span: Span;
}

// ───────── handlers ─────────

export interface Handler {
  trigger: Trigger;
  body: Statement[];
  span: Span;
}

export type Trigger =
  | { kind: "changed"; entity: EntityRef; attr?: string; to?: Expr; from?: Expr; span: Span }
  | { kind: "every"; ms: number; span: Span }
  | { kind: "at"; minutes: number; span: Span };

export type Statement =
  | { kind: "call"; entity: EntityRef; command: string; args: Arg[]; span: Span }
  /** `run zwave_js.main.led_notify { … }`: an integration's action, as written. */
  | {
      kind: "run";
      /** `zwave_js.main`: an instance id, with `_` written for its type's `-`. */
      integration: string;
      integrationSpan: Span;
      action: string;
      args: Arg[];
      span: Span;
    }
  | { kind: "set"; name: string; value: Expr; span: Span }
  | { kind: "if"; test: Expr; then: Statement[]; else?: Statement[]; span: Span }
  | { kind: "after"; ms: number; body: Statement[]; span: Span };

export interface Arg {
  name: string;
  value: Expr;
  span: Span;
}

// ───────── expressions ─────────

export interface EntityRef {
  kind: "entity";
  domain: string;
  object: string;
  /** `sensor.x#humidity` */
  attr?: string;
  id: string;
  span: Span;
}

export type Expr =
  | { kind: "number"; value: number; span: Span }
  | { kind: "duration"; ms: number; span: Span }
  | { kind: "time"; minutes: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "ident"; name: string; span: Span }
  | EntityRef
  | { kind: "member"; name: string; span: Span }
  | { kind: "list"; items: Expr[]; span: Span }
  | { kind: "access"; object: Expr; name: string; span: Span; nameSpan: Span }
  | { kind: "index"; object: Expr; index: Expr; span: Span }
  | { kind: "call"; callee: Expr; args: (Expr | Lambda)[]; span: Span }
  | { kind: "unary"; op: "!" | "-"; operand: Expr; span: Span }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: "ternary"; test: Expr; then: Expr; else: Expr; span: Span };

export type BinaryOp =
  | "??"
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

export interface Lambda {
  kind: "lambda";
  params: { name: string; span: Span }[];
  /** An expression body (`(e) => e.value`) or statements (`(v) => set shown = v`). */
  body: Expr | Statement[];
  span: Span;
}
