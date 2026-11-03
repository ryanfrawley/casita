// casa/compiled.ts
// What the compiler emits: a compact JSON tree the browser mounts and the server runs
// handlers from. Expressions are prefix arrays, so nothing is parsed at render time. This is
// a public format: `AST_VERSION` changes only with an incompatible change.

export const AST_VERSION = 1;

export type CExpr =
  | ["lit", number | string | boolean | null]
  | ["entity", string]
  | ["attr", string, string]
  /** A parameter, local state, loop variable or lambda parameter. */
  | ["var", string]
  /** `areas`, `devices`, `screen`, `now`. */
  | ["global", string]
  | ["lookup", "area" | "device", string]
  /** A theme path, which evaluates to itself: pages carry names, not values. */
  | ["theme", string]
  /** An enum member, which evaluates to its name. */
  | ["member", string]
  | ["list", ...CExpr[]]
  | ["get", CExpr, string]
  | ["index", CExpr, CExpr]
  | ["call", string, ...(CExpr | CFn)[]]
  | ["un", "!" | "-", CExpr]
  | ["bin", string, CExpr, CExpr]
  | ["if", CExpr, CExpr, CExpr];

/** A lambda with an expression body, as `any(list, (e) => …)` takes. */
export type CFn = ["fn", string[], CExpr];

/** A lambda with statements, as an event property takes. */
export interface CHandler {
  params: string[];
  body: CStmt[];
}

export type CStmt =
  | ["call", string, string, Record<string, CExpr>]
  /** An integration's action: the instance id, the action, and its parameters. */
  | ["run", string, string, Record<string, CExpr>]
  | ["set", string, CExpr]
  | ["if", CExpr, CStmt[], CStmt[] | undefined]
  | ["after", number, CStmt[]];

export type CProp = { e: CExpr } | { h: CHandler };

export interface CNode {
  t: "node";
  type: string;
  props: Record<string, CProp>;
  children: CChild[];
  /** Source line and column of the node's name, for the editor's jump. */
  at: [number, number];
}

export interface CRepeat {
  t: "for";
  var: string;
  list: CExpr;
  where?: CExpr;
  children: CChild[];
  at: [number, number];
}

export interface CSlot {
  t: "children";
}

export type CChild = CNode | CRepeat | CSlot;

export interface CState {
  name: string;
  init: CExpr;
}

export interface CComponent {
  name: string;
  params: { name: string; default?: CExpr }[];
  state: CState[];
  root: CNode;
}

export type CTrigger =
  | { kind: "changed"; entity: string; attr?: string; to?: CExpr; from?: CExpr }
  | { kind: "every"; ms: number }
  | { kind: "at"; minutes: number };

export interface CServerHandler {
  trigger: CTrigger;
  body: CStmt[];
  /** Source line of the `on`, for the log. */
  line: number;
}

export type CSensorType = "String" | "Number" | "Bool";

/**
 * A derived sensor as the server runs it: the inputs, each an expression over the house
 * (an entity or a list of them), and the value, an expression over the inputs alone.
 */
export interface CSensor {
  name: string;
  type: CSensorType;
  /** A Number's unit, as a real sensor reports it. */
  unit?: string;
  /** A device class: a Number's (`temperature`) or a Bool's (`door`). */
  class?: string;
  inputs: { name: string; value: CExpr }[];
  value: CExpr;
  /** Source line of the `value`, for the log. */
  line: number;
}

export interface CompiledPage {
  astVersion: typeof AST_VERSION;
  name: string;
  components: Record<string, CComponent>;
  state: CState[];
  root: CNode;
  /** Every entity id the page reads, for the pretend panel and the E011 check at load. */
  entities: string[];
}
