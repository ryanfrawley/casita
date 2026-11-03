// casa/run.ts
// Runs a handler's statements: in the browser on an event, on the server on a trigger. What
// `call`, `run`, `set` and `after` do is the caller's, since only it has a socket or a scheduler.

import type { Command } from "../types.ts";
import type { CStmt } from "./compiled.ts";
import { type Env, evaluate, withVars } from "./eval.ts";
import { isAbsent, isArea, isDevice, isEntity, type Value } from "./values.ts";

export interface Actions {
  call(entityId: string, command: Command): Promise<unknown> | unknown;
  /** An integration's action; only the server has one, and only a server handler is given `run`. */
  run?(integrationId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
  set(name: string, value: Value): void;
  after(ms: number, fn: () => Promise<void>): void;
}

/** A `call`'s command: the domain from the id, the action, and the arguments as given. */
export function commandOf(entityId: string, action: string, args: Record<string, Value>): Command {
  const domain = entityId.split(".")[0] ?? "";
  const command: Record<string, unknown> = { domain, action };
  for (const [name, value] of Object.entries(args)) {
    if (isAbsent(value)) continue;
    // An enum member stands for the state's own word: `.Heat` is `heat`.
    command[name] = name === "mode" && typeof value === "string" ? value.toLowerCase() : value;
  }
  return command as Command;
}

/** An action's parameters as JSON: absent ones left out, a device, area or entity as its id. */
export function paramsOf(args: Record<string, Value>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const plain = (value: Value): unknown =>
    isEntity(value) || isDevice(value) || isArea(value)
      ? value.id
      : Array.isArray(value)
        ? value.map(plain)
        : value;
  for (const [name, value] of Object.entries(args)) {
    if (!isAbsent(value)) params[name] = plain(value);
  }
  return params;
}

export async function run(body: CStmt[], env: Env, actions: Actions): Promise<void> {
  for (const statement of body) {
    switch (statement[0]) {
      case "call": {
        const args: Record<string, Value> = {};
        for (const [name, expr] of Object.entries(statement[3])) args[name] = evaluate(expr, env);
        await actions.call(statement[1], commandOf(statement[1], statement[2], args));
        break;
      }
      case "run": {
        if (!actions.run) throw new Error("`run` only runs on the server");
        const args: Record<string, Value> = {};
        for (const [name, expr] of Object.entries(statement[3])) args[name] = evaluate(expr, env);
        await actions.run(statement[1], statement[2], paramsOf(args));
        break;
      }
      case "set": {
        const value = evaluate(statement[2], env);
        actions.set(statement[1], value);
        // Later statements in the same handler see the new value.
        env = withVars(env, { [statement[1]]: value });
        break;
      }
      case "if": {
        const test = evaluate(statement[1], env);
        if (test === true) await run(statement[2], env, actions);
        else if (statement[3]) await run(statement[3], env, actions);
        break;
      }
      case "after": {
        const body = statement[2];
        const snapshot = env;
        actions.after(statement[1], () => run(body, snapshot, actions));
        break;
      }
    }
  }
}
