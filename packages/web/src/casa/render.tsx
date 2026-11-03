// Mounts a compiled page as a React tree. Each node evaluates its properties against the
// house; a property re-evaluates only when something it read changed, and a node re-renders
// only when a value did. `for` keeps children by key, so a reorder is a move, not a remount.

import {
  BUILTINS,
  type CChild,
  type CComponent,
  type CExpr,
  type CHandler,
  type CNode,
  type CompiledPage,
  type CRepeat,
  equal,
  evaluate,
  evaluateWithDeps,
  isArea,
  isDevice,
  isEntity,
  isRecord,
  run,
  tracking,
  type Value,
} from "@casita/core/casa";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Thing } from "../detail.tsx";
import type { Store } from "../store.ts";
import { BUILTIN_VIEWS, type BuiltinProps, GridContext } from "./builtins.tsx";
import type { CasaStore } from "./host.ts";

export type Vars = ReadonlyMap<string, Value>;

export interface CasaContextValue {
  casa: CasaStore;
  store: Store;
  page: CompiledPage;
  /** Opens an entity's details sheet. */
  onOpen: (entityId: string) => void;
  /** Opens the sheet of an entity, a device or an area: what a card is `of`. */
  onOpenThing: (thing: Thing) => void;
  /** Says what a browser handler's command did when it failed. */
  onFailure: (message: string) => void;
  /** The editor's Alt-click: jump to a node's source line. */
  onLocate?: (at: [number, number]) => void;
}

export const CasaContext = createContext<CasaContextValue | null>(null);

export function useCasa(): CasaContextValue {
  const value = useContext(CasaContext);
  if (!value) throw new Error("No Casa page above this node");
  return value;
}

const EMPTY_VARS: Vars = new Map();

/** Whether two values read the same, so a node is not re-rendered for an equal result. */
export function same(a: Value, b: Value): boolean {
  if (equal(a, b)) return true;
  if (isRecord(a) && isRecord(b)) return JSON.stringify(a.fields) === JSON.stringify(b.fields);
  return false;
}

/** A property's value, re-evaluated only when something it read changed. */
export function useExpr(expr: CExpr | undefined, vars: Vars): Value {
  const { casa } = useCasa();
  const ref = useRef<{ expr: CExpr; vars: Vars; value: Value; deps: Set<string>; stamp: number }>();
  const snapshot = useCallback((): Value => {
    if (!expr) return null;
    const current = ref.current;
    if (
      current &&
      current.expr === expr &&
      current.vars === vars &&
      !casa.changedSince(current.deps, current.stamp)
    ) {
      return current.value;
    }
    const stamp = casa.version;
    const { value, deps } = evaluateWithDeps(expr, { host: casa.host(), vars });
    const kept = current && same(current.value, value) ? current.value : value;
    ref.current = { expr, vars, value: kept, deps, stamp };
    return kept;
  }, [casa, expr, vars]);
  return useSyncExternalStore(casa.subscribe, snapshot, snapshot);
}

/**
 * What a `for` would repeat over, after its `where`: the list a Card asks about to learn
 * whether it holds exactly one row. Re-evaluated only when something it read changed, like
 * a property; `undefined` when there is no loop to ask about.
 */
export function useRepeatItems(repeat: CRepeat | undefined, vars: Vars): Value[] | undefined {
  const { casa } = useCasa();
  const ref = useRef<{
    repeat: CRepeat;
    vars: Vars;
    items: Value[];
    deps: Set<string>;
    stamp: number;
  }>();
  const snapshot = useCallback((): Value[] | undefined => {
    if (!repeat) return undefined;
    const current = ref.current;
    if (
      current &&
      current.repeat === repeat &&
      current.vars === vars &&
      !casa.changedSince(current.deps, current.stamp)
    ) {
      return current.items;
    }
    const stamp = casa.version;
    const deps = new Set<string>();
    const host = tracking(casa.host(), deps);
    const list = evaluate(repeat.list, { host, vars });
    const items = (Array.isArray(list) ? list : []).filter(
      (item) =>
        !repeat.where ||
        evaluate(repeat.where, { host, vars: new Map([...vars, [repeat.var, item]]) }) === true,
    );
    const kept =
      current &&
      current.items.length === items.length &&
      items.every((item, i) => same(current.items[i] as Value, item))
        ? current.items
        : items;
    ref.current = { repeat, vars, items: kept, deps, stamp };
    return kept;
  }, [casa, repeat, vars]);
  return useSyncExternalStore(casa.subscribe, snapshot, snapshot);
}

/** Keeps the previous object when the next one reads the same, so memos downstream hold. */
function useStable<T extends Record<string, Value>>(next: T): T {
  const ref = useRef(next);
  const previous = ref.current;
  const keys = Object.keys(next);
  const unchanged =
    keys.length === Object.keys(previous).length &&
    keys.every((key) => key in previous && same(previous[key] as Value, next[key] as Value));
  if (!unchanged) ref.current = next;
  return ref.current;
}

/** The key a loop item renders under: its id when it has one, else its place. */
const keyOf = (item: Value, index: number): string =>
  isEntity(item) || isArea(item) || isDevice(item) ? item.id : String(index);

// ───────── nodes ─────────

interface Instance {
  /** The component or page this node belongs to, whose state `set` targets. */
  setState: (name: string, value: Value) => void;
  slot?: ReactNode;
}

const InstanceContext = createContext<Instance>({ setState: () => {} });

export function ChildView({ child, vars }: { child: CChild; vars: Vars }) {
  switch (child.t) {
    case "node":
      return <NodeView node={child} vars={vars} />;
    case "for":
      return <ForView node={child} vars={vars} />;
    case "children":
      return <Slot />;
  }
}

/** Where a component's caller's children render. */
function Slot() {
  return <>{useContext(InstanceContext).slot}</>;
}

export function NodeView({ node, vars }: { node: CNode; vars: Vars }) {
  const { page, store, casa, onFailure } = useCasa();
  const instance = useContext(InstanceContext);
  const columns = useContext(GridContext);
  const names = useMemo(() => Object.keys(node.props), [node]);
  // One hook per property; the list is fixed for a node, so the order is stable.
  const values: Record<string, Value> = {};
  for (const name of names) {
    const prop = node.props[name];
    // biome-ignore lint/correctness/useHookAtTopLevel: the list of names is constant per node
    const value = useExpr(prop && "e" in prop ? prop.e : undefined, vars);
    if (prop && "e" in prop) values[name] = value;
  }
  const props = useStable(values);
  const handlers = useMemo(() => {
    const out: Record<string, (...args: Value[]) => Promise<void>> = {};
    for (const name of names) {
      const prop = node.props[name];
      if (!prop || !("h" in prop)) continue;
      const handler = prop.h;
      // Settles when the handler has run, its commands answered: a button is busy that long.
      out[name] = (...args) => fire(handler, args, vars, instance, store, casa, onFailure);
    }
    return out;
  }, [names, node, vars, instance, store, casa, onFailure]);

  if ("when" in node.props && props.when !== true) return null;

  const component = page.components[node.type];
  const builtin = component ? undefined : BUILTINS.get(node.type);
  let view: ReactNode;
  if (component) {
    view = (
      <ComponentInstance definition={component} args={props}>
        {node.children.length ? <Children node={node} vars={vars} /> : undefined}
      </ComponentInstance>
    );
  } else {
    const View = BUILTIN_VIEWS[node.type];
    if (!View) {
      return <div className="app-casa-error">Unknown node {node.type}</div>;
    }
    const builtinProps: BuiltinProps = {
      node,
      props,
      on: handlers,
      vars,
      children: node.children.length ? <Children node={node} vars={vars} /> : undefined,
    };
    view = <View {...builtinProps} />;
  }
  if (columns === null) return view;
  // Inside a Grid, the node written there is the cell, a component's use as much as a
  // built-in. It takes its `span` of the columns (an Area's `columns` is the same), and what
  // is wider than the grid takes the whole row.
  const asked = props.span ?? (node.type === "Area" ? props.columns : undefined);
  const span = Math.max(1, Math.round(typeof asked === "number" ? asked : 1));
  // Its `align` says how it sits in the cell; a node with an `align` of its own (a Stack's is
  // its children's, a component may take one) fills the cell, as every node does when it
  // says nothing.
  const own = builtin ? builtin.props.align : component?.params.some((p) => p.name === "align");
  const align = own ? undefined : CELL_ALIGN[String(props.align)];
  // Its `valign` is where it sits on the cell's height, which is the row's: a button beside a
  // two-line heading sits halfway down it.
  const valign = CELL_VALIGN[String(props.valign)];
  return (
    <GridContext.Provider value={null}>
      <div
        className={`app-casa-cell${align ? ` app-casa-cell-${align}` : ""}${valign ? ` app-casa-cell-${valign}` : ""}`}
        style={{ gridColumn: span >= columns ? "1 / -1" : `span ${span}` }}
      >
        {view}
      </div>
    </GridContext.Provider>
  );
}

const CELL_ALIGN: Record<string, string> = { Start: "start", Center: "center", End: "end" };
const CELL_VALIGN: Record<string, string> = { Top: "top", Center: "middle", Bottom: "bottom" };

function Children({ node, vars }: { node: CNode | CRepeat; vars: Vars }) {
  return (
    <>
      {node.children.map((child, i) => (
        // Children are a fixed list in source order; their place is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
        <ChildView key={i} child={child} vars={vars} />
      ))}
    </>
  );
}

function ForView({ node, vars }: { node: CRepeat; vars: Vars }) {
  const list = useExpr(node.list, vars);
  const items = Array.isArray(list) ? list : [];
  return (
    <>
      {items.map((item, index) => (
        <ForItem key={keyOf(item, index)} node={node} vars={vars} item={item} />
      ))}
    </>
  );
}

function ForItem({ node, vars, item }: { node: CRepeat; vars: Vars; item: Value }) {
  const itemVars = useMemo(() => new Map([...vars, [node.var, item]]), [vars, node.var, item]);
  const kept = useExpr(node.where, itemVars);
  if (node.where && kept !== true) return null;
  return <Children node={node} vars={itemVars} />;
}

// ───────── components and pages ─────────

function useInstanceState(
  definitions: { name: string; init: CExpr }[],
  initialVars: Vars,
): [Vars, (name: string, value: Value) => void] {
  const { casa } = useCasa();
  // The initialiser runs once, when the instance mounts; it is not a binding.
  const [state, setState] = useState<Vars>(() => {
    const cells = new Map<string, Value>();
    const host = casa.host();
    for (const cell of definitions) {
      cells.set(
        cell.name,
        evaluate(cell.init, { host, vars: new Map([...initialVars, ...cells]) }),
      );
    }
    return cells;
  });
  const set = useCallback((name: string, value: Value) => {
    setState((current) => {
      if (current.has(name) && same(current.get(name) as Value, value)) return current;
      return new Map([...current, [name, value]]);
    });
  }, []);
  return [state, set];
}

function ComponentInstance({
  definition,
  args,
  children,
}: {
  definition: CComponent;
  args: Record<string, Value>;
  children?: ReactNode;
}) {
  const { casa } = useCasa();
  const params = useMemo(() => {
    const host = casa.host();
    const bound = new Map<string, Value>();
    for (const param of definition.params) {
      const given = args[param.name];
      bound.set(
        param.name,
        given !== undefined
          ? given
          : param.default
            ? evaluate(param.default, { host, vars: EMPTY_VARS })
            : null,
      );
    }
    return bound;
  }, [casa, definition, args]);
  const [state, setState] = useInstanceState(definition.state, params);
  const vars = useMemo(() => new Map([...params, ...state]), [params, state]);
  const instance = useMemo<Instance>(() => ({ setState, slot: children }), [setState, children]);
  return (
    <InstanceContext.Provider value={instance}>
      <NodeView node={definition.root} vars={vars} />
    </InstanceContext.Provider>
  );
}

/**
 * A heading drawn by a component: the one a `header:` names, else the bundled default of
 * that name, which the compiler puts in every page. Nothing, when the page has neither.
 */
export function HeaderView({ name, args }: { name: string; args: Record<string, Value> }) {
  const { page } = useCasa();
  const stable = useStable(args);
  const definition = page.components[name];
  if (!definition) return null;
  return <ComponentInstance definition={definition} args={stable} />;
}

/** The page itself: its state, then its root. */
export function PageView({ page }: { page: CompiledPage }) {
  const [state, setState] = useInstanceState(page.state, EMPTY_VARS);
  const instance = useMemo<Instance>(() => ({ setState }), [setState]);
  return (
    <InstanceContext.Provider value={instance}>
      <NodeView node={page.root} vars={state} />
    </InstanceContext.Provider>
  );
}

// ───────── events ─────────

async function fire(
  handler: CHandler,
  args: Value[],
  vars: Vars,
  instance: Instance,
  store: Store,
  casa: CasaStore,
  onFailure: (message: string) => void,
): Promise<void> {
  const bound = new Map(vars);
  handler.params.forEach((name, i) => {
    bound.set(name, args[i] ?? null);
  });
  await run(
    handler.body,
    { host: casa.host(), vars: bound },
    {
      call: async (entityId, command) => {
        const outcome = await store.command(entityId, command, "Working…");
        if (!outcome.ok) onFailure(outcome.message);
      },
      set: instance.setState,
      after: () => {},
    },
  );
}
