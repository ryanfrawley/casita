// Casa in the editor: how the source is coloured, what is offered on completion, and how the
// compiler's diagnostics land on the text. The tokenizer here is CodeMirror's stream kind,
// written against the same lexical rules as the compiler's lexer.

import type { Diagnostic as CasaDiagnostic, Registry } from "@casita/core/casa";
import {
  BUILTIN_NAMES,
  BUILTINS,
  COMMON_PROPS,
  DOMAIN_NAMES,
  FUNCTION_NAMES,
  GROUP_NAMES,
  RESERVED,
  runName,
  VOCABULARY,
} from "@casita/core/casa";

export type TokenStyle =
  | "keyword"
  | "typeName"
  | "propertyName"
  | "variableName"
  | "string"
  | "number"
  | "atom"
  | "color"
  | "comment"
  | "operator"
  | "punctuation"
  | "invalid";

export interface StreamState {
  inComment: boolean;
  /** `{` depth of a `theme` body, where `#rrggbb` is a colour and not an attribute. */
  theme: number;
  depth: number;
}

/** What a CodeMirror stream offers the tokenizer; narrowed to what is used, for tests. */
export interface Stream {
  match(pattern: RegExp | string, consume?: boolean): RegExpMatchArray | string | boolean | null;
  eat(pattern: RegExp | string): string | boolean | null | undefined;
  eatWhile(pattern: RegExp): boolean;
  next(): string | undefined;
  peek(): string | undefined;
  skipToEnd(): void;
  eatSpace(): boolean;
  sol(): boolean;
  current(): string;
  /** Characters before the current token on this line. */
  string: string;
  start: number;
}

const DECLARATIONS = new Set(["theme", "component", "page", "automation", "sensor"]);
const STATEMENTS = new Set([
  "call",
  "set",
  "if",
  "else",
  "after",
  "on",
  "every",
  "at",
  "for",
  "in",
  "where",
  "state",
  "input",
  "extends",
  "changed",
  "to",
  "from",
  "children",
]);
const DOMAINS = new Set<string>(DOMAIN_NAMES);

export const startState = (): StreamState => ({ inComment: false, theme: 0, depth: 0 });

/** One token from the stream. Null means whitespace. */
export function token(stream: Stream, state: StreamState): TokenStyle | null {
  if (state.inComment) {
    if (stream.match(/^.*?\*\//)) state.inComment = false;
    else stream.skipToEnd();
    return "comment";
  }
  if (stream.eatSpace()) return null;
  if (stream.match("//")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match("/*")) {
    state.inComment = true;
    if (stream.match(/^.*?\*\//)) state.inComment = false;
    else stream.skipToEnd();
    return "comment";
  }
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
  if (stream.match(/^\d{2}:\d{2}(?![\d:])/)) return "number";
  if (stream.match(/^\d+(?:\.\d+)?(?:ms|s|m|h|d|%)?(?![a-zA-Z0-9_])/)) return "number";
  if (stream.match(/^\.[A-Z][a-zA-Z0-9]*/)) return "atom";
  if (stream.match(/^[A-Z][a-zA-Z0-9]*/)) return "typeName";
  if (stream.match(/^#[0-9a-fA-F]{3,8}(?![a-zA-Z0-9_])/)) {
    const glued = /[a-z0-9_]$/.test(stream.string.slice(0, stream.start));
    return glued && state.theme === 0 ? "punctuation" : "color";
  }
  const atLineStart = stream.sol();
  if (stream.match(/^[a-z_][a-zA-Z0-9_]*/)) {
    const word = stream.current();
    const rest = stream.string.slice(stream.start + word.length);
    if (DECLARATIONS.has(word) && atLineStart) {
      if (word === "theme") state.theme = state.depth + 1;
      return "keyword";
    }
    if (/^\s*:(?!=)/.test(rest) && !DOMAINS.has(word)) return "propertyName";
    if (DOMAINS.has(word) && /^\./.test(rest)) return "variableName";
    if (word === "true" || word === "false" || word === "null") return "atom";
    if (STATEMENTS.has(word) || word === "screen") return "keyword";
    // `run` is a word only before an integration; elsewhere it may name a state.
    if (word === "run" && /^\s+[a-z_]/.test(rest)) return "keyword";
    if (GROUP_NAMES.includes(word) || word === "theme") return "variableName";
    return "variableName";
  }
  const c = stream.next();
  if (c === "{") {
    state.depth++;
    return "punctuation";
  }
  if (c === "}") {
    state.depth--;
    if (state.theme && state.depth < state.theme) state.theme = 0;
    return "punctuation";
  }
  if (c && "()[],.;:#".includes(c)) return "punctuation";
  if (c && "=<>!&|?+-*/%".includes(c)) {
    stream.eatWhile(/[=<>!&|?+\-*/%]/);
    return "operator";
  }
  return "invalid";
}

// ───────── completion ─────────

export interface Completion {
  label: string;
  type: "keyword" | "type" | "property" | "variable" | "function" | "constant" | "enum";
  detail?: string;
  /** What is inserted; the label when left out. */
  apply?: string;
  /**
   * Where the option sits among equally good matches, -99 to 99; the editor sorts by match
   * first, so a boost only lifts an option above the names that match as well as it does.
   */
  boost?: number;
}

const typeNames = [
  "Number",
  "String",
  "Bool",
  "Duration",
  "Time",
  "Color",
  "Token",
  "Entity",
  "Attribute",
  "Area",
  "Device",
  "List<",
  "Enum<",
];

/** The names a page may use, from the house and the language. */
export function completions(registry: Registry, componentNames: string[] = []): Completion[] {
  const out: Completion[] = [];
  for (const name of BUILTIN_NAMES) out.push({ label: name, type: "type", apply: `${name} { ` });
  for (const name of componentNames)
    out.push({ label: name, type: "type", detail: "component", apply: `${name} { ` });
  for (const word of RESERVED) {
    if (!DOMAINS.has(word)) out.push({ label: word, type: "keyword" });
  }
  for (const name of FUNCTION_NAMES) out.push({ label: name, type: "function", apply: `${name}(` });
  for (const name of ["areas", "devices", "entities", "now"])
    out.push({ label: name, type: "variable" });
  for (const name of typeNames) out.push({ label: name, type: "type" });
  for (const entity of registry.entities) {
    out.push({ label: entity.id, type: "constant", detail: entity.name });
  }
  for (const area of registry.areas)
    out.push({ label: `area.${area.id}`, type: "constant", detail: area.name });
  for (const device of registry.devices)
    out.push({ label: `device.${device.id}`, type: "constant", detail: device.name });
  out.push({ label: "run", type: "keyword" });
  for (const integration of registry.integrations ?? []) {
    for (const action of integration.actions ?? []) {
      out.push({
        label: `run ${runName(integration.id)}.${action.name}`,
        type: "function",
        detail: "action",
        apply: `run ${runName(integration.id)}.${action.name} { `,
      });
    }
  }
  for (const [group, spec] of Object.entries(VOCABULARY)) {
    for (const key of Object.keys(spec.keys))
      out.push({ label: `${group}.${key}`, type: "variable", detail: "theme" });
  }
  return out;
}

/**
 * The properties of the built-in whose body the cursor is in, found by the nearest `Name {`.
 * They are boosted so the list opens on them: the node's own attributes first, then the ones
 * every node has, then everything else a page may name.
 */
export function propertiesAt(
  source: string,
  offset: number,
  componentParams: Record<string, string[]> = {},
): Completion[] {
  const before = source.slice(0, offset);
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const head = /([A-Z][a-zA-Z0-9]*)\s*$/.exec(before.slice(0, i));
      if (!head) return [];
      const name = head[1] as string;
      const builtin = BUILTINS.get(name);
      const own = builtin ? Object.keys(builtin.props) : (componentParams[name] ?? []);
      const property = (prop: string, boost: number): Completion => ({
        label: prop,
        type: "property",
        apply: `${prop}: `,
        boost,
      });
      return [
        ...own.map((prop) => property(prop, 99)),
        ...Object.keys(COMMON_PROPS).map((prop) => property(prop, 98)),
      ];
    }
  }
  return [];
}

/** Theme paths that start the way the word before the cursor does: `palette.` → every colour. */
export function themePathsAt(word: string, paths: readonly string[]): Completion[] {
  if (!word.includes(".")) return [];
  const prefix = word.slice(0, word.lastIndexOf(".") + 1);
  return paths
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ label: path, type: "variable" as const, detail: "theme" }));
}

// ───────── references ─────────

/** A thing of the house named in the source: `light.hall`, `device.thermostat`, `area.living`. */
export interface Reference {
  kind: "entity" | "device" | "area";
  /** The entity id, or the device's or area's. */
  id: string;
  from: number;
  to: number;
}

const REFERENCE = /([a-z_][a-zA-Z0-9_]*)\.([a-zA-Z0-9_]+)/g;

/**
 * The references on one line, by the lexer's rules: a domain, `area` or `device`, a dot and an
 * id, not the tail of a longer path. A comment ends the line; a string is passed over.
 */
function* referencesOnLine(line: string, lineStart: number): Generator<Reference> {
  REFERENCE.lastIndex = 0;
  for (let m = REFERENCE.exec(line); m; m = REFERENCE.exec(line)) {
    const [whole, head, tail] = m as unknown as [string, string, string];
    const from = m.index;
    const before = line.slice(0, from);
    if (before.includes("//")) return;
    // `title.color` inside `section.title.color` is not one; `light.hall.value` still is.
    if (/[a-zA-Z0-9_.#]$/.test(before)) continue;
    if ((before.split('"').length - 1) % 2 === 1) continue;
    const kind = head === "area" || head === "device" ? head : DOMAINS.has(head) ? "entity" : null;
    if (!kind) continue;
    yield {
      kind,
      id: kind === "entity" ? whole : tail,
      from: lineStart + from,
      to: lineStart + from + whole.length,
    };
  }
}

/** The reference under an offset, from its first character to just past its last. */
export function referenceAt(source: string, offset: number): Reference | null {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  if (offset < lineStart || offset > lineStart + line.length) return null;
  for (const ref of referencesOnLine(line, lineStart)) {
    if (offset < ref.from) break;
    if (offset <= ref.to) return ref;
  }
  return null;
}

/** Every reference on the lines between two offsets, in order; the whole text by default. */
export function referencesIn(source: string, from = 0, to = source.length): Reference[] {
  const found: Reference[] = [];
  let lineStart = source.lastIndexOf("\n", from - 1) + 1;
  while (lineStart <= to) {
    const lineEnd = source.indexOf("\n", lineStart);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    found.push(...referencesOnLine(line, lineStart));
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return found;
}

// ───────── diagnostics ─────────

export interface Mark {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
  code: string;
}

/** Diagnostics as marks on the text, each at least one character wide and inside the source. */
export function marks(diagnostics: readonly CasaDiagnostic[], length: number): Mark[] {
  return diagnostics.map((d) => {
    const from = Math.max(0, Math.min(d.span.start, length));
    const to = Math.max(from + (from < length ? 1 : 0), Math.min(d.span.end, length));
    return { from, to, severity: d.level, message: `${d.code}: ${d.message}`, code: d.code };
  });
}

/** The offset of a line and column (1-based), clamped to the text. */
export function offsetOf(source: string, line: number, col: number): number {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  const end = source.indexOf("\n", offset);
  const lineEnd = end === -1 ? source.length : end;
  return Math.min(offset + Math.max(0, col - 1), lineEnd);
}

/** A trigger's words, for the list of handlers the preview cannot run. */
export function describeTrigger(trigger: {
  kind: string;
  entity?: string;
  attr?: string;
  ms?: number;
  minutes?: number;
  to?: unknown;
  from?: unknown;
}): string {
  switch (trigger.kind) {
    case "every": {
      const ms = trigger.ms ?? 0;
      const unit =
        ms % 3_600_000 === 0
          ? `${ms / 3_600_000}h`
          : ms % 60_000 === 0
            ? `${ms / 60_000}m`
            : `${ms / 1000}s`;
      return `every ${unit}`;
    }
    case "at": {
      const m = trigger.minutes ?? 0;
      return `at ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    }
    default: {
      const what = trigger.attr ? `${trigger.entity}#${trigger.attr}` : trigger.entity;
      const to = trigger.to ? " to …" : "";
      const from = trigger.from ? " from …" : "";
      return `on ${what} changed${to}${from}`;
    }
  }
}
