// casa/parser.ts
// Recursive descent over the lexer's tokens into the syntax tree. The first syntax error in a
// declaration ends that declaration; parsing picks up again at the next top-level keyword, so
// one slip reports once rather than as a cascade.

import type {
  Arg,
  AutomationDecl,
  Child,
  ComponentDecl,
  EntityRef,
  Expr,
  File,
  Handler,
  InputDecl,
  Lambda,
  Node,
  PageDecl,
  Param,
  Prop,
  SensorDecl,
  StateDecl,
  Statement,
  ThemeDecl,
  ThemeEntry,
  ThemeGroup,
  ThemeValue,
  Trigger,
  TypeExpr,
} from "./ast.ts";
import { at, type Diagnostics, type Span } from "./diagnostics.ts";
import { DOMAIN_NAMES, lex, RESERVED, type Token } from "./lexer.ts";

class ParseError extends Error {
  constructor(
    readonly span: Span,
    message: string,
    readonly code = "E001",
  ) {
    super(message);
  }
}

const DOMAINS = new Set<string>(DOMAIN_NAMES);
const BINARY: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

/** What a file declares at the top level. `automation` and `sensor` are not reserved: a page may use the words. */
const DECLARATION_WORDS = new Set(["theme", "component", "page", "automation", "sensor"]);

export function parse(source: string, diagnostics: Diagnostics): File {
  const tokens = lex(source, diagnostics);
  const file: File = { themes: [], components: [], pages: [], automations: [], sensors: [] };
  let i = 0;

  // ───────── token helpers ─────────

  const peek = (offset = 0): Token => tokens[Math.min(i + offset, tokens.length - 1)] as Token;
  const next = (): Token => {
    const token = peek();
    if (token.kind !== "eof") i++;
    return token;
  };
  const describe = (token: Token) =>
    token.kind === "eof"
      ? "the end of the file"
      : token.kind === "newline"
        ? "the end of the line"
        : `\`${token.text}\``;
  const fail = (token: Token, expected: string): never => {
    throw new ParseError(
      token.span,
      `syntax: unexpected ${describe(token)} at ${at(token.span)}, expected ${expected}`,
    );
  };
  const is = (text: string, offset = 0) => {
    const token = peek(offset);
    return (token.kind === "punct" || token.kind === "ident") && token.text === text;
  };
  const isPunct = (text: string, offset = 0) => {
    const token = peek(offset);
    return token.kind === "punct" && token.text === text;
  };
  const expect = (text: string, expected = `\`${text}\``): Token =>
    is(text) ? next() : fail(peek(), expected);
  const skipNewlines = () => {
    while (peek().kind === "newline" || isPunct(";")) i++;
  };
  const ident = (what: string): Token => {
    const token = peek();
    return token.kind === "ident" ? next() : fail(token, what);
  };
  const typeName = (what: string): Token => {
    const token = peek();
    return token.kind === "type" ? next() : fail(token, what);
  };
  const spanFrom = (start: Span): Span => {
    const last = tokens[i - 1]?.span ?? start;
    const end = last.end > start.start ? last.end : start.end;
    return { start: start.start, end, line: start.line, col: start.col };
  };
  /** A name a page declares; reserved words and built-in scope names are refused. */
  const bindable = (token: Token, what: string): string => {
    if (RESERVED.has(token.text)) {
      throw new ParseError(
        token.span,
        `syntax: \`${token.text}\` is a reserved word; ${what} needs another name`,
      );
    }
    return token.text;
  };
  /** Ends a property or statement: a newline, `;`, `}` or the end of the file. */
  const endOfLine = () => {
    const token = peek();
    if (token.kind === "newline" || isPunct(";")) {
      skipNewlines();
      return;
    }
    if (token.kind === "eof" || isPunct("}")) return;
  };

  // ───────── declarations ─────────

  const parseTheme = (): ThemeDecl => {
    const start = expect("theme").span;
    const name = typeName("a theme name").text;
    let extends_: string | undefined;
    if (is("extends")) {
      next();
      extends_ = typeName("the theme to extend").text;
    }
    expect("{");
    skipNewlines();
    const groups: ThemeGroup[] = [];
    while (!isPunct("}")) {
      groups.push(parseThemeGroup());
      skipNewlines();
    }
    expect("}");
    return { kind: "theme", name, extends: extends_, groups, span: spanFrom(start) };
  };

  const parseThemeGroup = (): ThemeGroup => {
    const first = ident("a theme group such as `palette`");
    const path = [first.text];
    while (isPunct(".")) {
      next();
      path.push(ident("a group name").text);
    }
    expect("{");
    skipNewlines();
    const entries: ThemeEntry[] = [];
    while (!isPunct("}")) {
      const key = ident("a theme key");
      expect(":");
      const value = parseThemeValue();
      entries.push({ key: key.text, value, span: spanFrom(key.span) });
      if (isPunct(",")) next();
      skipNewlines();
    }
    expect("}");
    return { path, entries, span: spanFrom(first.span) };
  };

  const parseThemeValue = (): ThemeValue => {
    const token = peek();
    if (token.kind === "color") {
      next();
      return { kind: "color", hex: token.text, span: token.span };
    }
    if (token.kind === "number") {
      next();
      return { kind: "number", value: token.value as number, span: token.span };
    }
    if (token.kind === "string") {
      next();
      return { kind: "string", value: token.str ?? "", span: token.span };
    }
    if (token.kind === "ident") {
      next();
      const path = [token.text];
      while (isPunct(".")) {
        next();
        path.push(ident("a theme key").text);
      }
      return { kind: "ref", path, span: spanFrom(token.span) };
    }
    return fail(token, "a colour, a number, a string or a theme value such as `palette.lamp`");
  };

  const parseType = (): TypeExpr => {
    const name = typeName("a type");
    if (name.text === "List" && isPunct("<")) {
      next();
      const of = parseType();
      expect(">");
      return { kind: "list", of, span: spanFrom(name.span) };
    }
    if (name.text === "Enum" && isPunct("<")) {
      next();
      const members = [typeName("an enum member").text];
      while (isPunct("|")) {
        next();
        members.push(typeName("an enum member").text);
      }
      expect(">");
      return { kind: "enum", members, span: spanFrom(name.span) };
    }
    return { kind: "name", name: name.text, span: name.span };
  };

  const parseParams = (): Param[] => {
    expect("(");
    const params: Param[] = [];
    while (!isPunct(")")) {
      const name = ident("a parameter name");
      expect(":");
      const type = parseType();
      let default_: Expr | undefined;
      if (isPunct("=")) {
        next();
        default_ = parseExpr();
      }
      params.push({
        name: bindable(name, "a parameter"),
        type,
        default: default_,
        span: spanFrom(name.span),
      });
      if (!isPunct(")")) expect(",", "`,` or `)`");
    }
    expect(")");
    return params;
  };

  const parseState = (): StateDecl => {
    const start = expect("state").span;
    const name = ident("a state name");
    let type: TypeExpr | undefined;
    if (isPunct(":")) {
      next();
      type = parseType();
    }
    expect("=");
    const init = parseExpr();
    endOfLine();
    return { name: bindable(name, "local state"), type, init, span: spanFrom(start) };
  };

  const parseComponent = (): ComponentDecl => {
    const start = expect("component").span;
    const name = typeName("a component name").text;
    const params = parseParams();
    expect("{");
    skipNewlines();
    const state: StateDecl[] = [];
    while (is("state")) {
      state.push(parseState());
      skipNewlines();
    }
    const root = parseNode();
    skipNewlines();
    if (is("on") || is("every") || is("at")) {
      throw new ParseError(
        peek().span,
        "entity-triggered handlers are only allowed at page level",
        "E051",
      );
    }
    if (!isPunct("}")) fail(peek(), "`}`; a component has one root node");
    next();
    return { kind: "component", name, params, state, root, span: spanFrom(start) };
  };

  const parsePage = (): PageDecl => {
    const start = expect("page").span;
    const name = typeName("a page name").text;
    expect("{");
    skipNewlines();
    const state: StateDecl[] = [];
    while (is("state")) {
      state.push(parseState());
      skipNewlines();
    }
    const root = parseNode();
    skipNewlines();
    const handlers: Handler[] = [];
    while (!isPunct("}")) {
      if (is("on") || is("every") || is("at")) handlers.push(parseHandler());
      else if (peek().kind === "type")
        fail(peek(), "`}`; a page has one root node, then its handlers");
      else fail(peek(), "a handler (`on`, `every`, `at`) or `}`");
      skipNewlines();
    }
    expect("}");
    return { kind: "page", name, state, root, handlers, span: spanFrom(start) };
  };

  const parseAutomation = (): AutomationDecl => {
    const start = expect("automation").span;
    const name = typeName("an automation name such as `HallLight`").text;
    expect("{");
    skipNewlines();
    const handlers: Handler[] = [];
    while (!isPunct("}")) {
      if (is("on") || is("every") || is("at")) handlers.push(parseHandler());
      else if (is("state") || peek().kind === "type")
        fail(peek(), "a handler; an automation has no state or nodes, only `on`, `every` and `at`");
      else fail(peek(), "a handler (`on`, `every`, `at`) or `}`");
      skipNewlines();
    }
    expect("}");
    return { kind: "automation", name, handlers, span: spanFrom(start) };
  };

  const parseInput = (): InputDecl => {
    const start = expect("input").span;
    const name = ident("an input name");
    expect("=");
    const value = parseExpr();
    endOfLine();
    return { name: bindable(name, "an input"), value, span: spanFrom(start) };
  };

  const parseSensor = (): SensorDecl => {
    const start = expect("sensor").span;
    const name = typeName("a sensor name such as `KitchenDoor`").text;
    expect("{");
    skipNewlines();
    const inputs: InputDecl[] = [];
    const props: Prop[] = [];
    while (!isPunct("}")) {
      const token = peek();
      if (is("input")) inputs.push(parseInput());
      else if (token.kind === "ident" && isPunct(":", 1)) {
        props.push(parseProp());
        endOfLine();
      } else if (is("on") || is("every") || is("at") || is("state") || token.kind === "type") {
        fail(token, "an `input` or a property; a sensor has no handlers, state or nodes");
      } else
        fail(token, "an `input`, a property (`name`, `type`, `value`, `unit`, `class`) or `}`");
      skipNewlines();
    }
    expect("}");
    return { kind: "sensor", name, inputs, props, span: spanFrom(start) };
  };

  // ───────── nodes ─────────

  const parseNode = (): Node => {
    const name = typeName("a node such as `Card {`");
    expect("{");
    const { props, children } = parseBody();
    expect("}");
    return {
      kind: "node",
      type: name.text,
      props,
      children,
      span: spanFrom(name.span),
      nameSpan: name.span,
    };
  };

  const parseBody = (): { props: Prop[]; children: Child[] } => {
    const props: Prop[] = [];
    const children: Child[] = [];
    skipNewlines();
    while (!isPunct("}")) {
      const token = peek();
      if (token.kind === "ident" && isPunct(":", 1)) {
        props.push(parseProp());
      } else if (token.kind === "type") {
        children.push(parseNode());
      } else if (token.kind === "ident" && token.text === "for") {
        children.push(parseRepeat());
      } else if (token.kind === "ident" && token.text === "children") {
        next();
        children.push({ kind: "children", span: token.span });
      } else {
        fail(token, "a property or a node");
      }
      if (peek().kind !== "newline" && !isPunct(";") && !isPunct("}")) {
        // Two properties or nodes on one line need nothing between them, but a stray token
        // after an expression is a mistake worth naming.
        const after = peek();
        if (
          !(
            after.kind === "ident" &&
            (isPunct(":", 1) || after.text === "for" || after.text === "children")
          ) &&
          after.kind !== "type"
        ) {
          fail(after, "the end of the line, or another property or node");
        }
      }
      skipNewlines();
    }
    return { props, children };
  };

  const parseProp = (): Prop => {
    const name = ident("a property name");
    expect(":");
    const value = startsLambda() ? parseLambda() : parseExpr();
    return { name: name.text, value, span: spanFrom(name.span) };
  };

  const parseRepeat = (): Child => {
    const start = expect("for").span;
    const variable = bindable(ident("a loop variable"), "a loop variable");
    expect("in");
    const list = parseExpr();
    let where: Expr | undefined;
    if (is("where")) {
      next();
      where = parseExpr();
    }
    expect("{");
    const { props, children } = parseBody();
    if (props.length > 0) {
      const prop = props[0] as Prop;
      throw new ParseError(
        prop.span,
        `syntax: a \`for\` block holds nodes, not properties; \`${prop.name}\` belongs on a node`,
      );
    }
    expect("}");
    return { kind: "for", variable, list, where, children, span: spanFrom(start) };
  };

  // ───────── handlers and statements ─────────

  const parseHandler = (): Handler => {
    const start = peek().span;
    if (is("on")) next();
    const trigger = parseTrigger();
    expect("{");
    const body = parseStatements();
    expect("}");
    return { trigger, body, span: spanFrom(start) };
  };

  const parseTrigger = (): Trigger => {
    const start = peek();
    if (is("every")) {
      next();
      const duration = peek();
      if (duration.kind !== "duration") fail(duration, "a duration such as `5m`");
      next();
      return { kind: "every", ms: duration.value as number, span: spanFrom(start.span) };
    }
    if (is("at")) {
      next();
      const time = peek();
      if (time.kind !== "time") fail(time, "a time of day such as `07:00`");
      next();
      return { kind: "at", minutes: time.value as number, span: spanFrom(start.span) };
    }
    const entity = parseEntityRef();
    const attr = entity.attr;
    expect("changed", "`changed`");
    let to: Expr | undefined;
    let from: Expr | undefined;
    while (is("to") || is("from")) {
      const which = next().text;
      const value = parseExpr();
      if (which === "to") to = value;
      else from = value;
    }
    return {
      kind: "changed",
      entity: { ...entity, attr: undefined },
      attr,
      to,
      from,
      span: spanFrom(start.span),
    };
  };

  const parseStatements = (): Statement[] => {
    const statements: Statement[] = [];
    skipNewlines();
    while (!isPunct("}")) {
      statements.push(parseStatement());
      endOfLine();
      skipNewlines();
    }
    return statements;
  };

  /** `{ name: value, … }` after a command or action; none when there is no brace. */
  const parseArgs = (): Arg[] => {
    const args: Arg[] = [];
    if (!isPunct("{")) return args;
    next();
    skipNewlines();
    while (!isPunct("}")) {
      const name = ident("an argument name");
      expect(":");
      const value = parseExpr();
      args.push({ name: name.text, value, span: spanFrom(name.span) });
      if (isPunct(",")) next();
      skipNewlines();
    }
    expect("}");
    return args;
  };

  /** `run` is a word only where a statement starts, so a state or parameter may still be `run`. */
  const startsRun = (): boolean => is("run") && peek(1).kind === "ident";

  const parseStatement = (): Statement => {
    const token = peek();
    if (is("call")) {
      next();
      const entity = parseEntityRef();
      if (entity.attr)
        throw new ParseError(entity.span, "syntax: a command goes to an entity, not an attribute");
      expect(".");
      const command = ident("a command such as `turn_on`").text;
      const args = parseArgs();
      return { kind: "call", entity, command, args, span: spanFrom(token.span) };
    }
    if (startsRun()) {
      next();
      const type = ident("an integration such as `zwave_js.main`");
      expect(".");
      const name = peek();
      if (name.kind !== "ident" && name.kind !== "number") fail(name, "an integration's name");
      next();
      const integrationSpan = spanFrom(type.span);
      expect(".");
      const action = ident("an action such as `led_notify`").text;
      const args = parseArgs();
      return {
        kind: "run",
        integration: `${type.text}.${name.text}`,
        integrationSpan,
        action,
        args,
        span: spanFrom(token.span),
      };
    }
    if (is("set")) {
      next();
      const name = ident("a state name");
      expect("=");
      const value = parseExpr();
      return { kind: "set", name: name.text, value, span: spanFrom(token.span) };
    }
    if (is("if")) {
      next();
      const test = parseExpr();
      expect("{");
      const then = parseStatements();
      expect("}");
      let else_: Statement[] | undefined;
      // `else` may start the next line.
      let ahead = i;
      while (tokens[ahead]?.kind === "newline") ahead++;
      if (tokens[ahead]?.kind === "ident" && tokens[ahead]?.text === "else") i = ahead;
      if (is("else")) {
        next();
        if (is("if")) {
          // `else if` is an `if` alone in the else branch.
          else_ = [parseStatement()];
        } else {
          expect("{");
          else_ = parseStatements();
          expect("}");
        }
      }
      return { kind: "if", test, then, else: else_, span: spanFrom(token.span) };
    }
    if (is("after")) {
      next();
      const duration = peek();
      if (duration.kind !== "duration") fail(duration, "a duration such as `10m`");
      next();
      expect("{");
      const body = parseStatements();
      expect("}");
      return { kind: "after", ms: duration.value as number, body, span: spanFrom(token.span) };
    }
    return fail(token, "a statement (`call`, `run`, `set`, `if`, `after`)");
  };

  // ───────── expressions ─────────

  const parseEntityRef = (): EntityRef => {
    const domain = peek();
    if (domain.kind !== "ident" || !DOMAINS.has(domain.text)) {
      fail(domain, "an entity such as `light.hall`");
    }
    next();
    expect(".");
    const object = peek();
    if (object.kind !== "ident" && object.kind !== "number") fail(object, "an entity id");
    next();
    let attr: string | undefined;
    if (isPunct("#") && !peek().spaced) {
      next();
      attr = ident("an attribute name").text;
    }
    return {
      kind: "entity",
      domain: domain.text,
      object: object.text,
      attr,
      id: `${domain.text}.${object.text}`,
      span: spanFrom(domain.span),
    };
  };

  /** `(` idents `)` `=>` is a lambda; anything else in parentheses is an expression. */
  const startsLambda = (): boolean => {
    if (!isPunct("(")) return false;
    let k = 1;
    while (peek(k).kind === "ident" || isPunct(",", k)) k++;
    return isPunct(")", k) && isPunct("=>", k + 1);
  };

  const parseLambda = (): Lambda => {
    const start = expect("(").span;
    const params: Lambda["params"] = [];
    while (!isPunct(")")) {
      const name = ident("a parameter name");
      params.push({ name: bindable(name, "a lambda parameter"), span: name.span });
      if (!isPunct(")")) expect(",", "`,` or `)`");
    }
    expect(")");
    expect("=>");
    skipNewlines();
    let body: Expr | Statement[];
    if (isPunct("{")) {
      next();
      body = parseStatements();
      expect("}");
    } else if (is("set") || is("call") || startsRun() || is("if") || is("after")) {
      body = [parseStatement()];
    } else {
      body = parseExpr();
    }
    return { kind: "lambda", params, body, span: spanFrom(start) };
  };

  const parseExpr = (): Expr => parseTernary();

  const parseTernary = (): Expr => {
    const test = parseBinary(1);
    if (!isPunct("?")) return test;
    next();
    skipNewlines();
    const then = parseExpr();
    skipNewlines();
    expect(":", "`:` for the other branch");
    skipNewlines();
    const else_ = parseExpr();
    return { kind: "ternary", test, then, else: else_, span: spanFrom(test.span) };
  };

  const parseBinary = (minPrecedence: number): Expr => {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      const precedence = token.kind === "punct" ? BINARY[token.text] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      next();
      skipNewlines();
      const right = parseBinary(precedence + 1);
      left = {
        kind: "binary",
        op: token.text as Extract<Expr, { kind: "binary" }>["op"],
        left,
        right,
        span: spanFrom(left.span),
      };
    }
  };

  const parseUnary = (): Expr => {
    const token = peek();
    if (isPunct("!") || isPunct("-")) {
      next();
      const operand = parseUnary();
      return { kind: "unary", op: token.text as "!" | "-", operand, span: spanFrom(token.span) };
    }
    return parsePostfix();
  };

  const parsePostfix = (): Expr => {
    let expr = parsePrimary();
    for (;;) {
      if (isPunct(".") && peek(1).kind === "ident") {
        next();
        const name = next();
        expr = {
          kind: "access",
          object: expr,
          name: name.text,
          span: spanFrom(expr.span),
          nameSpan: name.span,
        };
      } else if (isPunct("[") && !peek().spaced) {
        next();
        const index = parseExpr();
        expect("]");
        expr = { kind: "index", object: expr, index, span: spanFrom(expr.span) };
      } else if (isPunct("(") && !peek().spaced) {
        next();
        const args: (Expr | Lambda)[] = [];
        while (!isPunct(")")) {
          args.push(startsLambda() ? parseLambda() : parseExpr());
          if (!isPunct(")")) expect(",", "`,` or `)`");
        }
        expect(")");
        expr = { kind: "call", callee: expr, args, span: spanFrom(expr.span) };
      } else {
        return expr;
      }
    }
  };

  const parsePrimary = (): Expr => {
    const token = peek();
    switch (token.kind) {
      case "number":
        next();
        return { kind: "number", value: token.value as number, span: token.span };
      case "duration":
        next();
        return { kind: "duration", ms: token.value as number, span: token.span };
      case "time":
        next();
        return { kind: "time", minutes: token.value as number, span: token.span };
      case "string":
        next();
        return { kind: "string", value: token.str ?? "", span: token.span };
      case "member":
        next();
        return { kind: "member", name: token.text, span: token.span };
      case "color":
        next();
        throw new ParseError(
          token.span,
          "a colour literal is only allowed inside `theme`; use a palette name",
          "E020",
        );
      case "ident":
        if (token.text === "true" || token.text === "false") {
          next();
          return { kind: "bool", value: token.text === "true", span: token.span };
        }
        if (token.text === "null") {
          next();
          return { kind: "null", span: token.span };
        }
        if (DOMAINS.has(token.text) && isPunct(".", 1)) return parseEntityRef();
        next();
        return { kind: "ident", name: token.text, span: token.span };
      case "type":
        // A component named as a value, as a `header` slot takes; the checker says where
        // that is allowed.
        next();
        return { kind: "ident", name: token.text, span: token.span };
      case "punct":
        if (token.text === "[") {
          next();
          const items: Expr[] = [];
          while (!isPunct("]")) {
            items.push(parseExpr());
            if (!isPunct("]")) expect(",", "`,` or `]`");
          }
          expect("]");
          return { kind: "list", items, span: spanFrom(token.span) };
        }
        if (token.text === "(") {
          next();
          const inner = parseExpr();
          expect(")");
          return { ...inner, span: spanFrom(token.span) };
        }
        break;
      default:
        break;
    }
    return fail(token, "an expression");
  };

  // ───────── top level ─────────

  /** After an error, moves to the next declaration at the top level. */
  const recover = () => {
    let depth = 0;
    for (;;) {
      const token = peek();
      if (token.kind === "eof") return;
      if (depth === 0 && token.kind === "ident" && DECLARATION_WORDS.has(token.text)) return;
      if (isPunct("{")) depth++;
      if (isPunct("}")) depth = Math.max(0, depth - 1);
      next();
    }
  };

  skipNewlines();
  while (peek().kind !== "eof") {
    const token = peek();
    try {
      if (is("theme")) file.themes.push(parseTheme());
      else if (is("component")) file.components.push(parseComponent());
      else if (is("page")) file.pages.push(parsePage());
      else if (is("automation")) file.automations.push(parseAutomation());
      else if (is("sensor")) file.sensors.push(parseSensor());
      else fail(token, "`theme`, `component`, `page`, `automation` or `sensor`");
      const after = peek();
      if (after.kind !== "newline" && after.kind !== "eof" && !isPunct(";")) {
        fail(after, "the end of the line");
      }
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      diagnostics.error(err.code, err.span, err.message);
      if (peek() === token) next();
      recover();
    }
    skipNewlines();
  }
  return file;
}
