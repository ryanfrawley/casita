// casa/lexer.ts
// Source text to tokens. Newlines are tokens, since a newline ends a property or statement,
// except inside `(` and `[`, where an expression may run on.

import { at, type Diagnostics, type Span } from "./diagnostics.ts";

export type TokenKind =
  | "ident"
  | "type"
  | "number"
  | "duration"
  | "time"
  | "string"
  | "color"
  /** `.Name`: an enum member. */
  | "member"
  | "punct"
  | "newline"
  /** Only with `trivia`: a line or block comment, its text as written. */
  | "comment"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** The source text, or for a punct the operator itself. */
  text: string;
  /** A number's value (a `%` already divided by 100), a duration in ms, a time in minutes. */
  value?: number;
  /** A string's decoded contents. */
  str?: string;
  span: Span;
  /** Whitespace separated this token from the one before it. */
  spaced: boolean;
}

export const DOMAIN_NAMES = [
  "light",
  "sensor",
  "binary_sensor",
  "switch",
  "climate",
  "cover",
  "lock",
  "button",
  "weather",
] as const;

export const RESERVED = new Set([
  "theme",
  "extends",
  "palette",
  "surface",
  "text",
  "space",
  "font",
  "breakpoints",
  "component",
  "state",
  "page",
  "for",
  "in",
  "where",
  "when",
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
  "true",
  "false",
  "null",
  "screen",
  ...DOMAIN_NAMES,
]);

const PUNCT = [
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ":",
  ",",
  ".",
  "#",
  "?",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  ";",
  "|",
];

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const isIdentStart = (c: string) => /[a-z_]/.test(c);
const isUpper = (c: string) => /[A-Z]/.test(c);
const isWord = (c: string) => /[a-zA-Z0-9_]/.test(c);
const isDigit = (c: string) => /[0-9]/.test(c);
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);

export interface LexOptions {
  /**
   * Keep what the parser has no use for, as the formatter needs: comments become tokens, and
   * every line break is a newline, inside brackets and on blank lines too.
   */
  trivia?: boolean;
}

export function lex(source: string, diagnostics: Diagnostics, options: LexOptions = {}): Token[] {
  const trivia = options.trivia === true;
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  /** Open brackets; a newline inside `(` or `[` is whitespace. */
  const brackets: string[] = [];
  let spaced = true;

  const span = (start: number, startLine: number, startCol: number): Span => ({
    start,
    end: pos,
    line: startLine,
    col: startCol,
  });
  const push = (token: Omit<Token, "spaced">) => {
    tokens.push({ ...token, spaced });
    spaced = false;
  };

  while (pos < source.length) {
    const c = source[pos] as string;
    const start = pos;
    const startLine = line;
    const startCol = pos - lineStart + 1;

    if (c === "\n") {
      pos++;
      line++;
      lineStart = pos;
      const top = brackets[brackets.length - 1];
      if (trivia || (top !== "(" && top !== "[" && tokens[tokens.length - 1]?.kind !== "newline")) {
        push({ kind: "newline", text: "\n", span: span(start, startLine, startCol) });
      }
      spaced = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pos++;
      spaced = true;
      continue;
    }
    if (c === "/" && source[pos + 1] === "/") {
      while (pos < source.length && source[pos] !== "\n") pos++;
      if (trivia) {
        const text = source.slice(start, pos).trimEnd();
        push({ kind: "comment", text, span: span(start, startLine, startCol) });
      }
      spaced = true;
      continue;
    }
    if (c === "/" && source[pos + 1] === "*") {
      const close = source.indexOf("*/", pos + 2);
      const end = close === -1 ? source.length : close + 2;
      if (close === -1) {
        diagnostics.error("E001", span(start, startLine, startCol), "syntax: comment never closes");
      }
      for (let i = pos; i < end; i++) {
        if (source[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
      }
      pos = end;
      if (trivia) {
        const text = source.slice(start, end);
        push({ kind: "comment", text, span: span(start, startLine, startCol) });
      }
      spaced = true;
      continue;
    }

    // An id may start with a digit (`sensor.3d_printer`, `device.3f2a`): after `<domain>.`,
    // `area.` or `device.`, a run of word characters is the id.
    const previous = tokens[tokens.length - 1];
    const beforeDot = tokens[tokens.length - 2];
    if (
      isDigit(c) &&
      previous?.kind === "punct" &&
      previous.text === "." &&
      previous.span.end === pos &&
      beforeDot?.kind === "ident" &&
      ((DOMAIN_NAMES as readonly string[]).includes(beforeDot.text) ||
        beforeDot.text === "area" ||
        beforeDot.text === "device") &&
      beforeDot.span.end === previous.span.start
    ) {
      while (pos < source.length && isWord(source[pos] as string)) pos++;
      push({
        kind: "ident",
        text: source.slice(start, pos),
        span: span(start, startLine, startCol),
      });
      continue;
    }

    if (isIdentStart(c)) {
      while (pos < source.length && isWord(source[pos] as string)) pos++;
      push({
        kind: "ident",
        text: source.slice(start, pos),
        span: span(start, startLine, startCol),
      });
      continue;
    }
    if (isUpper(c)) {
      while (pos < source.length && isWord(source[pos] as string)) pos++;
      push({
        kind: "type",
        text: source.slice(start, pos),
        span: span(start, startLine, startCol),
      });
      continue;
    }
    if (c === "." && isUpper(source[pos + 1] ?? "")) {
      pos++;
      while (pos < source.length && isWord(source[pos] as string)) pos++;
      push({
        kind: "member",
        text: source.slice(start + 1, pos),
        span: span(start, startLine, startCol),
      });
      continue;
    }

    if (isDigit(c)) {
      // HH:MM, only when nothing but a space or a brace can follow.
      const time = /^(\d{2}):(\d{2})(?![\d:])/.exec(source.slice(pos, pos + 6));
      if (time) {
        pos += 5;
        const h = Number(time[1]);
        const m = Number(time[2]);
        const s = span(start, startLine, startCol);
        if (h > 23 || m > 59)
          diagnostics.error("E001", s, `syntax: ${time[0]} is not a time of day`);
        push({ kind: "time", text: time[0], value: h * 60 + m, span: s });
        continue;
      }
      while (pos < source.length && isDigit(source[pos] as string)) pos++;
      if (source[pos] === "." && isDigit(source[pos + 1] ?? "")) {
        pos++;
        while (pos < source.length && isDigit(source[pos] as string)) pos++;
      }
      const number = Number(source.slice(start, pos));
      const suffix = /^(ms|s|m|h|d|%)(?![a-zA-Z0-9_])/.exec(source.slice(pos, pos + 3));
      if (suffix) {
        pos += (suffix[1] as string).length;
        const s = span(start, startLine, startCol);
        if (suffix[1] === "%") {
          push({ kind: "number", text: source.slice(start, pos), value: number / 100, span: s });
        } else {
          const unit = DURATION_UNITS[suffix[1] as string] as number;
          push({ kind: "duration", text: source.slice(start, pos), value: number * unit, span: s });
        }
        continue;
      }
      if (isWord(source[pos] ?? "")) {
        while (pos < source.length && isWord(source[pos] as string)) pos++;
        diagnostics.error(
          "E001",
          span(start, startLine, startCol),
          `syntax: \`${source.slice(start, pos)}\` is not a number; units are ms s m h d and %`,
        );
      }
      push({
        kind: "number",
        text: source.slice(start, pos),
        value: number,
        span: span(start, startLine, startCol),
      });
      continue;
    }

    if (c === '"') {
      pos++;
      let str = "";
      let closed = false;
      while (pos < source.length) {
        const ch = source[pos] as string;
        if (ch === '"') {
          pos++;
          closed = true;
          break;
        }
        if (ch === "\n") break;
        if (ch === "\\") {
          const next = source[pos + 1];
          if (next === "n") str += "\n";
          else if (next === '"') str += '"';
          else if (next === "\\") str += "\\";
          else {
            diagnostics.error(
              "E001",
              { start: pos, end: pos + 2, line, col: pos - lineStart + 1 },
              `syntax: unknown escape \\${next ?? ""}; strings know \\" \\\\ and \\n`,
            );
          }
          pos += 2;
          continue;
        }
        str += ch;
        pos++;
      }
      const s = span(start, startLine, startCol);
      if (!closed) diagnostics.error("E001", s, "syntax: string never closes");
      push({ kind: "string", text: source.slice(start, pos), str, span: s });
      continue;
    }

    // `#` glued to an identifier is an attribute; anywhere else it starts a colour.
    if (c === "#") {
      const previous = tokens[tokens.length - 1];
      const glued = previous?.kind === "ident" && previous.span.end === pos;
      if (!glued) {
        let end = pos + 1;
        while (end < source.length && isHex(source[end] as string)) end++;
        const digits = end - pos - 1;
        if (digits === 3 || digits === 6 || digits === 8) {
          pos = end;
          push({
            kind: "color",
            text: source.slice(start, pos),
            span: span(start, startLine, startCol),
          });
          continue;
        }
        if (digits > 0 || !isIdentStart(source[pos + 1] ?? "")) {
          pos = end;
          diagnostics.error(
            "E001",
            span(start, startLine, startCol),
            "syntax: a colour is #rgb, #rrggbb or #rrggbbaa",
          );
          continue;
        }
      }
    }

    const punct = PUNCT.find((p) => source.startsWith(p, pos));
    if (punct) {
      pos += punct.length;
      if (punct === "(" || punct === "[" || punct === "{") brackets.push(punct);
      else if (punct === ")" || punct === "]" || punct === "}") brackets.pop();
      push({ kind: "punct", text: punct, span: span(start, startLine, startCol) });
      continue;
    }

    pos++;
    const s = span(start, startLine, startCol);
    diagnostics.error("E001", s, `syntax: unexpected character \`${c}\` at ${at(s)}`);
  }

  const end: Span = { start: pos, end: pos, line, col: pos - lineStart + 1 };
  if (tokens[tokens.length - 1]?.kind !== "newline") {
    push({ kind: "newline", text: "\n", span: end });
  }
  push({ kind: "eof", text: "", span: end });
  return tokens;
}
