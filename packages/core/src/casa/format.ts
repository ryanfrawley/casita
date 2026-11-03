// casa/format.ts
// Source to source in the house style: two spaces of indent per open bracket, one space around
// an operator and after a comma, two between the properties and nodes sharing a line, at most
// one blank line. The line breaks are the writer's; comments stay where they were. A file that
// does not parse is left alone, and so is any result that would not parse to the same tree.

import { Diagnostics } from "./diagnostics.ts";
import { lex, type Token } from "./lexer.ts";
import { parse } from "./parser.ts";

const INDENT = "  ";
const OPENERS = new Set(["{", "(", "["]);
const CLOSERS = new Set(["}", ")", "]"]);
const OPERATORS = new Set([
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "?",
  "|",
]);
/**
 * Words that begin or join a declaration or statement; after one, the line goes on with it.
 * Every other word ends a value, reserved or not: `weather` and `font` are fields after a dot.
 */
const KEYWORDS = new Set([
  "theme",
  "extends",
  "component",
  "state",
  "page",
  "automation",
  "sensor",
  "for",
  "in",
  "where",
  "on",
  "changed",
  "to",
  "every",
  "at",
  "call",
  "set",
  "if",
  "else",
  "after",
]);

interface Frame {
  open: string;
  /** Unanswered `?`s at this depth: the `:` that answers one is spaced as an operator. */
  ternary: number;
}

/** What the line walk knows about the token before the one being placed. */
interface Before {
  /** It is the `<` of `List<…>` or `Enum<…>`. */
  generic: boolean;
  /** It is a minus that signs what follows (`-1`), not one that subtracts. */
  sign: boolean;
  /** It ends a value: a word after `.` or `#` does, whatever the word (`sensor.x#at`). */
  value: boolean;
}

/** A line as laid out, and whether its code opens or closes a bracket at its ends. */
interface Line {
  text: string;
  /** Its last token, comments aside, opens a bracket. */
  opens: boolean;
  /** Its first token closes one. */
  closes: boolean;
}

const isPunct = (token: Token | undefined, text: string) =>
  token?.kind === "punct" && token.text === text;

const textOf = (token: Token) => (token.kind === "member" ? `.${token.text}` : token.text);

/** The token ends a value: what follows it on the line is an operator or something new. */
function endsValue(token: Token | undefined): boolean {
  if (!token) return false;
  switch (token.kind) {
    case "type":
    case "number":
    case "duration":
    case "time":
    case "string":
    case "color":
    case "member":
      return true;
    case "ident":
      return !KEYWORDS.has(token.text);
    case "punct":
      return CLOSERS.has(token.text);
    default:
      return false;
  }
}

/**
 * The source in the house style, or the source as given when it does not parse or when the
 * formatted text would not parse to the same tree.
 */
export function formatSource(source: string): string {
  const before = new Diagnostics();
  const tree = parse(source, before);
  if (before.failed) return source;
  const formatted = layout(lex(source, new Diagnostics(), { trivia: true }));
  if (formatted === source || source.trim() === "") return source;
  const after = new Diagnostics();
  const again = parse(formatted, after);
  if (after.failed || shape(again) !== shape(tree)) return source;
  return formatted;
}

/** A tree without its positions, to compare two parses of the same program. */
const shape = (tree: unknown): string =>
  JSON.stringify(tree, (key, value) =>
    key === "span" || key.endsWith("Span") ? undefined : value,
  );

function layout(tokens: Token[]): string {
  // Lines of tokens, as the writer broke them.
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "eof") break;
    if (token.kind === "newline") lines.push([]);
    else (lines[lines.length - 1] as Token[]).push(token);
  }

  const stack: Frame[] = [{ open: "", ternary: 0 }];
  /** Open `List<` and `Enum<`, whose `>` is glued. */
  let generics = 0;
  /** The last token that was not a comment, across lines: a minus starting a line is signed by it. */
  let last: Token | undefined;
  let lastValue = false;
  const out: Line[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      out.push({ text: "", opens: false, closes: false });
      continue;
    }
    let leading = 0;
    while (leading < line.length && CLOSERS.has(textOf(line[leading] as Token))) leading++;
    let text = INDENT.repeat(Math.max(0, stack.length - 1 - leading));
    let prev: Token | undefined;
    let before: Before = { generic: false, sign: false, value: lastValue };
    let opensLine = false;
    for (let i = 0; i < line.length; i++) {
      const token = line[i] as Token;
      const top = stack[stack.length - 1] as Frame;
      const opens =
        isPunct(token, "<") &&
        last?.kind === "type" &&
        (last.text === "List" || last.text === "Enum");
      const closes = isPunct(token, ">") && generics > 0;
      if (prev) text += gap(prev, token, line[i + 1], top, before, opens || closes);
      text += textOf(token);

      if (token.kind === "punct") {
        if (OPENERS.has(token.text)) stack.push({ open: token.text, ternary: 0 });
        else if (CLOSERS.has(token.text) && stack.length > 1) stack.pop();
        else if (token.text === "?") top.ternary++;
        else if (token.text === ":" && top.ternary > 0) top.ternary--;
      }
      if (opens) generics++;
      if (closes) generics--;
      if (token.kind !== "comment") {
        const field = token.kind === "ident" && (isPunct(last, ".") || isPunct(last, "#"));
        const value = field || endsValue(token);
        before = { generic: opens, sign: isPunct(token, "-") && !lastValue, value };
        opensLine = token.kind === "punct" && OPENERS.has(token.text);
        last = token;
        lastValue = value;
      }
      prev = token;
    }
    out.push({ text: text.trimEnd(), opens: opensLine, closes: leading > 0 });
  }
  return tidy(out);
}

/** What goes between two tokens on one line. */
function gap(
  prev: Token,
  token: Token,
  next: Token | undefined,
  top: Frame,
  before: Before,
  angle: boolean,
): string {
  if (token.kind === "comment") return "  ";
  // After a value, glued or not changes the meaning: `f(x)` is a call, `f (x)` a value then a
  // group; `a[0]` an index, `a [0]` a list. `sensor.x#at` is an attribute wherever it is.
  if (isPunct(token, "#") || (before.value && (isPunct(token, "(") || isPunct(token, "[")))) {
    return token.spaced ? " " : "";
  }
  if (isPunct(token, ".") || isPunct(prev, ".") || isPunct(prev, "#")) return "";
  if (isPunct(prev, "(") || isPunct(prev, "[")) return "";
  if (isPunct(token, ")") || isPunct(token, "]")) return "";
  if (isPunct(token, ",") || isPunct(token, ";")) return "";
  if (isPunct(prev, ",") || isPunct(prev, ";")) return " ";
  if (angle || before.generic) return "";
  if (isPunct(token, ":")) return top.ternary > 0 ? " " : "";
  if (isPunct(prev, ":")) return " ";
  if (isPunct(prev, "{") || isPunct(token, "{") || isPunct(token, "}")) return " ";
  if (isPunct(prev, "!") || before.sign) return "";
  if (token.kind === "punct" && OPERATORS.has(token.text)) return " ";
  if (prev.kind === "punct" && OPERATORS.has(prev.text)) return " ";
  // A property, node or loop that starts after a value on the same line: two spaces, so the
  // line reads as a list of things.
  if (top.open === "{" && before.value) {
    const property = token.kind === "ident" && isPunct(next, ":") && top.ternary === 0;
    const node = token.kind === "type" && isPunct(next, "{");
    const loop = token.kind === "ident" && (token.text === "for" || token.text === "children");
    if (property || node || loop) return "  ";
  }
  return token.spaced ? " " : "";
}

/** At most one blank line; none at the ends of the file or just inside a bracket. */
function tidy(lines: Line[]): string {
  const kept: Line[] = [];
  for (const line of lines) {
    const last = kept[kept.length - 1];
    if (line.text === "") {
      if (last === undefined || last.text === "" || last.opens) continue;
      kept.push(line);
      continue;
    }
    if (last?.text === "" && line.closes) kept.pop();
    kept.push(line);
  }
  while (kept[kept.length - 1]?.text === "") kept.pop();
  return `${kept.map((line) => line.text).join("\n")}\n`;
}
