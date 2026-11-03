// casa/compile.ts
// The pipeline: lex and parse, resolve and check, partition, cover, emit. Pure: it never
// touches the database or the network, so it runs unchanged in the browser for the preview.

import type { AutomationDecl, ComponentDecl, PageDecl, SensorDecl } from "./ast.ts";
import { check, type Registry } from "./check.ts";
import { AST_VERSION, type CompiledPage, type CSensor, type CServerHandler } from "./compiled.ts";
import { type Diagnostic, Diagnostics, NOWHERE } from "./diagnostics.ts";
import { bundledComponents } from "./headers.ts";
import { parse } from "./parser.ts";
import {
  BUILTIN_THEME_IDS,
  builtinThemes,
  compileTheme,
  coverage,
  isBuiltinTheme,
  reportGaps,
  type Theme,
  themeId,
} from "./theme.ts";

export interface CompileInput {
  source: string;
  registry: Registry;
  /** The stored themes; `Day` and `Night` are added when missing. */
  themes?: Theme[];
  /** Theme paths every other stored page references, so a theme change cannot strand one. */
  otherPageRefs?: Iterable<string>;
  /** Fail when the file declares no page (a page save), rather than compiling its themes alone. */
  requirePage?: boolean;
  /** The house's shared components, which every page may use; a page's own shadow them. */
  sharedSource?: string;
  /**
   * The file is the shared components file: only `component` declarations, checked on their
   * own (over an empty page) and against every theme a viewer can pick.
   */
  componentsOnly?: boolean;
  /**
   * The file is an automation: one `automation` declaration and nothing else, its handlers
   * all checked as server handlers.
   */
  automationOnly?: boolean;
  /** The file is a derived sensor: one `sensor` declaration and nothing else. */
  sensorOnly?: boolean;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  page?: CompiledPage;
  serverHandlers: CServerHandler[];
  /** Theme paths this page references. */
  themeRefs: string[];
  /** Themes the file declares, compiled; stored beside the page. */
  themes: Theme[];
  /** Entity ids the page reads or commands. */
  entities: string[];
  /** Device ids it looks up as `device.<id>`. */
  devices: string[];
  /** The automation the file declares, when compiled as one. */
  automation?: { name: string };
  /** The sensor the file declares, when compiled as one. */
  sensor?: CSensor;
}

export function compile(input: CompileInput): CompileResult {
  const diagnostics = new Diagnostics();
  const file = parse(input.source, diagnostics);
  const result = (page?: CompiledPage, extra: Partial<CompileResult> = {}): CompileResult => ({
    ok: !diagnostics.failed,
    diagnostics: sorted(diagnostics.list),
    page,
    serverHandlers: [],
    themeRefs: [],
    themes: [],
    entities: [],
    devices: [],
    ...extra,
  });
  if (diagnostics.failed) return result();

  // Themes: the built-ins, then the stored ones, then this file's, each over those before it.
  const stored = [...builtinThemes()];
  for (const theme of input.themes ?? []) {
    const index = stored.findIndex((t) => t.id === theme.id);
    if (index === -1) stored.push(theme);
    else stored[index] = theme;
  }
  const declared: Theme[] = [];
  for (const decl of file.themes) {
    if (BUILTIN_THEME_IDS.includes(themeId(decl.name))) {
      diagnostics.error(
        "E021",
        decl.span,
        `\`${decl.name}\` is built in and cannot be redeclared; extend it instead`,
      );
      continue;
    }
    const theme = compileTheme(decl, [...stored, ...declared], diagnostics);
    if (!theme) continue;
    if (declared.some((t) => t.id === theme.id)) {
      diagnostics.error("E021", decl.span, `theme \`${decl.name}\` is declared twice`);
      continue;
    }
    declared.push(theme);
  }
  const all = [...stored.filter((t) => !declared.some((d) => d.id === t.id)), ...declared];
  // Coverage is over the themes a viewer can pick: the house's own when it has any, since the
  // built-ins cannot be given new names, else Day and Night themselves.
  const selectable = selectableThemes(all);

  if (input.sensorOnly) {
    for (const extra of [...file.pages, ...file.themes, ...file.components, ...file.automations]) {
      diagnostics.error(
        "E001",
        extra.span,
        `a sensor file holds one \`sensor\` declaration, not a \`${extra.kind}\``,
      );
    }
    if (file.sensors.length > 1) {
      diagnostics.error(
        "E001",
        (file.sensors[1] as SensorDecl).span,
        "one `sensor` per file; a second sensor is a second file",
      );
    }
    const sensor = file.sensors[0];
    if (!sensor) diagnostics.error("E001", NOWHERE, "the file declares no `sensor`");
    if (diagnostics.failed || !sensor) return result();
    const checked = check(
      EMPTY_PAGE(),
      mergeComponents(bundledComponents()),
      input.registry,
      diagnostics,
      "sensor",
      sensor,
    );
    if (diagnostics.failed || !checked.sensor) return result();
    return result(undefined, {
      entities: [...checked.entities].sort(),
      devices: [...checked.devices].sort(),
      sensor: checked.sensor,
    });
  }

  if (input.automationOnly) {
    for (const extra of [...file.pages, ...file.themes, ...file.components, ...file.sensors]) {
      diagnostics.error(
        "E001",
        extra.span,
        `an automation file holds one \`automation\` declaration, not a \`${extra.kind}\``,
      );
    }
    if (file.automations.length > 1) {
      diagnostics.error(
        "E001",
        (file.automations[1] as AutomationDecl).span,
        "one `automation` per file; a second automation is a second file",
      );
    }
    const automation = file.automations[0];
    if (!automation) diagnostics.error("E001", NOWHERE, "the file declares no `automation`");
    if (diagnostics.failed || !automation) return result();
    // Checked as a page with nothing on it: the handlers are the whole of it.
    const checked = check(
      { ...EMPTY_PAGE(), name: automation.name, handlers: automation.handlers },
      mergeComponents(bundledComponents()),
      input.registry,
      diagnostics,
      "automation",
    );
    if (diagnostics.failed) return result();
    return result(undefined, {
      serverHandlers: checked.serverHandlers,
      entities: [...checked.entities].sort(),
      devices: [...checked.devices].sort(),
      automation: { name: automation.name },
    });
  }

  for (const extra of file.automations) {
    diagnostics.error(
      "E001",
      extra.span,
      input.componentsOnly
        ? "an automation is saved from the Automations page, not in the shared components file"
        : "an automation is saved from the Automations page, not in a page",
    );
  }
  for (const extra of file.sensors) {
    diagnostics.error(
      "E001",
      extra.span,
      input.componentsOnly
        ? "a sensor is saved from the Automations page, not in the shared components file"
        : "a sensor is saved from the Automations page, not in a page",
    );
  }
  if (input.componentsOnly) {
    for (const extra of [...file.pages, ...file.themes]) {
      diagnostics.error(
        "E001",
        extra.span,
        `the shared components file holds only \`component\` declarations, not a \`${extra.kind}\``,
      );
    }
    if (diagnostics.failed) return result();
    // Checked over an empty page: every component's body is typed whether or not it is used.
    const shared = withAreaHeader(
      file.components.map((decl) => ({ ...decl, origin: "shared" as const })),
      diagnostics,
    );
    const checked = check(
      EMPTY_PAGE(),
      mergeComponents(bundledComponents(), shared, []),
      input.registry,
      diagnostics,
    );
    if (diagnostics.failed) return result();
    reportGaps(
      coverage(selectable, [
        ...checked.themeRefs.keys(),
        ...checked.sharedRefs,
        ...checked.bundledRefs,
        ...(input.otherPageRefs ?? []),
      ]),
      checked.themeRefs,
      diagnostics,
    );
    return result(undefined, {
      themeRefs: [...new Set([...checked.themeRefs.keys(), ...checked.sharedRefs])].sort(),
    });
  }

  if (file.pages.length > 1) {
    diagnostics.error(
      "E001",
      (file.pages[1] as { span: typeof NOWHERE }).span,
      "one `page` per file; a second page is a second file",
    );
  }
  const page = file.pages[0];
  if (!page) {
    if (input.requirePage) diagnostics.error("E001", NOWHERE, "the file declares no `page`");
    else if (file.components.length > 0) {
      diagnostics.error(
        "E001",
        (file.components[0] as { span: typeof NOWHERE }).span,
        "a component needs a `page` to be used from",
      );
    }
    if (!diagnostics.failed)
      reportGaps(coverage(selectable, input.otherPageRefs ?? []), new Map(), diagnostics);
    return result(undefined, { themes: declared });
  }

  // The components a page may use: Casita's own headings, then the house's shared file, then
  // its own, each shadowing a same-named one before it.
  const shared = sharedComponents(input.sharedSource, diagnostics);
  const checked = check(
    page,
    mergeComponents(bundledComponents(), shared, withAreaHeader(file.components, diagnostics)),
    input.registry,
    diagnostics,
  );
  if (diagnostics.failed) return result(undefined, { themes: declared });

  reportGaps(
    coverage(selectable, [
      ...checked.themeRefs.keys(),
      ...checked.sharedRefs,
      ...checked.bundledRefs,
      ...(input.otherPageRefs ?? []),
    ]),
    checked.themeRefs,
    diagnostics,
  );
  if (diagnostics.failed) return result(undefined, { themes: declared });

  const compiled: CompiledPage = {
    astVersion: AST_VERSION,
    name: checked.name,
    components: checked.components,
    state: checked.state,
    root: checked.root,
    entities: [...checked.entities].sort(),
  };
  return result(compiled, {
    serverHandlers: checked.serverHandlers,
    themeRefs: [...checked.themeRefs.keys()].sort(),
    themes: declared,
    entities: compiled.entities,
    devices: [...checked.devices].sort(),
  });
}

/** Innermost wins: a later list's component shadows an earlier one of the same name. */
export function mergeComponents(...layers: ComponentDecl[][]): ComponentDecl[] {
  const byName = new Map<string, ComponentDecl>();
  for (const layer of layers) for (const decl of layer) byName.set(decl.name, decl);
  return [...byName.values()];
}

/**
 * The shared file's components, as a page sees them. A shared file that does not parse
 * contributes nothing and is reported once, at the top: it was checked when it was saved, so
 * this only happens when a page is compiled against an edit in progress.
 */
function sharedComponents(source: string | undefined, diagnostics: Diagnostics): ComponentDecl[] {
  if (!source) return [];
  const own = new Diagnostics();
  const file = parse(source, own);
  if (own.failed) {
    diagnostics.error(
      "E001",
      NOWHERE,
      `the shared components file does not parse: ${own.list[0]?.message ?? "syntax error"}`,
    );
    return [];
  }
  return withAreaHeader(file.components.map((decl) => ({ ...decl, origin: "shared" as const })));
}

/**
 * The area heading was `RoomHeader` before `Room` became `Area`. A house's own `RoomHeader`
 * still replaces Casita's, as an `AreaHeader` beside it, unless the file has an `AreaHeader`
 * too; the file it is written in is told to rename it.
 */
function withAreaHeader(decls: ComponentDecl[], diagnostics?: Diagnostics): ComponentDecl[] {
  const old = decls.find((decl) => decl.name === "RoomHeader");
  if (!old || decls.some((decl) => decl.name === "AreaHeader")) return decls;
  diagnostics?.warn(
    "W105",
    old.span,
    "`RoomHeader` is now `AreaHeader`; rename it, as it is only drawn for an `Area` given a `name` or an `icon`",
  );
  return [...decls, { ...old, name: "AreaHeader", origin: old.origin ?? "shared" }];
}

/** A page with nothing on it, to check the shared components over. */
const EMPTY_PAGE = (): PageDecl => {
  const file = parse("page Shared { Stack { } }", new Diagnostics());
  return file.pages[0] as PageDecl;
};

/** The themes a viewer may switch between: every stored theme but the built-ins, when there are any. */
export function selectableThemes(themes: Theme[]): Theme[] {
  const own = themes.filter((t) => !isBuiltinTheme(t));
  return own.length ? own : themes;
}

const sorted = (list: Diagnostic[]): Diagnostic[] =>
  [...list].sort((a, b) => a.span.start - b.span.start || a.code.localeCompare(b.code));
