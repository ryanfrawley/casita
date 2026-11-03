// casa: the page language. Pure TypeScript with no Bun or Node imports, so the compiler
// and evaluator run in the browser (the editor's preview) as well as on the server. The
// store and the runtime, which need the database and the scheduler, are in server.ts.

export type {
  Area,
  Command,
  Device,
  Entity,
  EntityState,
  StateRecord,
} from "../types.ts";
/** What a sensor or binary sensor can be; the web's entity form offers them. */
export { BINARY_SENSOR_CLASSES, SENSOR_CLASSES } from "../types.ts";
export type * from "./ast.ts";
export {
  BUILTIN_NAMES,
  BUILTINS,
  COMMON_PROPS,
  GRID_COLUMNS_MAX,
  HEADER_SLOTS,
  propsOf,
} from "./builtins.ts";
export { actionParams, COMMAND_ARGS, type Registry, runName } from "./check.ts";
export { type CompileInput, type CompileResult, compile, mergeComponents } from "./compile.ts";
export * from "./compiled.ts";
export type { Diagnostic, Level, Span } from "./diagnostics.ts";
export { Diagnostics } from "./diagnostics.ts";
export {
  attributeFields,
  clock,
  deviceIcon,
  type Env,
  equal,
  evaluate,
  evaluateWithDeps,
  stateValue,
  tracking,
  withVars,
} from "./eval.ts";
export { formatSource } from "./format.ts";
export { FUNCTION_NAMES, FUNCTIONS } from "./functions.ts";
export { BUNDLED_COMPONENT_NAMES, bundledComponents, HEADERS_SOURCE } from "./headers.ts";
export { DOMAIN_NAMES, lex, RESERVED, type Token, type TokenKind } from "./lexer.ts";
export { parse } from "./parser.ts";
export { overridden, pretending, pretendOne } from "./pretend.ts";
export { type Actions, run } from "./run.ts";
export {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_NAMES,
  builtinThemes,
  compileTheme,
  coverage,
  cssVar,
  FACES,
  GROUP_NAMES,
  isBuiltinTheme,
  isDark,
  lookup,
  OCTOBER_SOURCE,
  type Resolved,
  SHAPES,
  type Theme,
  themeCss,
  themeId,
  themePaths,
  themePathType,
  VOCABULARY,
} from "./theme.ts";
export { DOMAIN_VALUE, SCREEN, show, type Type } from "./types.ts";
export * from "./values.ts";
