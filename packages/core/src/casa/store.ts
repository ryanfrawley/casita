// casa/store.ts
// Pages and themes in SQLite. A save compiles first and stores only what compiled; the
// previous source is kept as a version. The compiler is pure, so this is the one place a page
// meets the database.

import type { Database } from "bun:sqlite";
import { CoreError } from "../errors.ts";
import type { EventBus } from "../types.ts";
import type { Registry } from "./check.ts";
import { compile, selectableThemes } from "./compile.ts";
import type { CompiledPage, CServerHandler } from "./compiled.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { Diagnostics } from "./diagnostics.ts";
import { parse } from "./parser.ts";
import {
  builtinThemes,
  compileTheme,
  isBuiltinTheme,
  isDark,
  lookup,
  type Resolved,
  type Theme,
  themeId,
} from "./theme.ts";

export interface PageStoreDeps {
  db: Database;
  bus: EventBus;
  /** The house as the compiler needs it, read fresh on every compile. */
  registry: () => Registry;
  now?: () => number;
}

export interface PageSummary {
  id: string;
  name: string;
  updatedAt: number;
  updatedBy?: string;
}

export interface PageRecord extends PageSummary {
  compiled: CompiledPage;
  themeRefs: string[];
}

export interface PageVersion {
  version: number;
  savedAt: number;
  savedBy?: string;
}

export interface ThemeRecord {
  id: string;
  name: string;
  extends?: string;
  css: string;
  /** Its source; Day and Night are generated and have none. */
  source?: string;
  builtin: boolean;
  dark: boolean;
  /** What `system` picks for a light or a dark system. */
  isLightDefault: boolean;
  isDarkDefault: boolean;
  /** Where `screen` turns from Phone to Tablet to Desktop, in px. */
  breakpoints: { tablet: number; desktop: number };
  /** Every path the theme defines, so the editor can check coverage before a save. */
  values: Record<string, Resolved>;
}

export interface SaveResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  page?: PageRecord;
  serverHandlers?: CServerHandler[];
}

/** The house's shared components file. */
export interface ComponentsRecord {
  source: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface SaveComponentsResult {
  ok: boolean;
  /** The file's own problems. */
  diagnostics: Diagnostic[];
  /** When a stored page no longer compiles against the file: which, and why. */
  page?: string;
  pageDiagnostics?: Diagnostic[];
}

/** The one row of the `components` table. */
const SHARED = "shared";

interface ComponentsRow {
  id: string;
  source: string;
  theme_refs: string;
  updated_at: number;
  updated_by: string | null;
}

interface PageRow {
  id: string;
  name: string;
  source: string;
  compiled: string;
  theme_refs: string;
  updated_at: number;
  updated_by: string | null;
}

interface ThemeRow {
  id: string;
  name: string;
  source: string;
  css: string;
  extends: string | null;
}

/** What the `compiled` column holds. */
interface Stored {
  page: CompiledPage;
  serverHandlers: CServerHandler[];
}

export class PageStore {
  private readonly now: () => number;

  constructor(private readonly deps: PageStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ───────── pages ─────────

  listPages(): PageSummary[] {
    return this.deps.db
      .query<Omit<PageRow, "source" | "compiled" | "theme_refs">, []>(
        "SELECT id, name, updated_at, updated_by FROM pages ORDER BY id",
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by ?? undefined,
      }));
  }

  getPage(id: string): PageRecord | undefined {
    const row = this.deps.db.query<PageRow, [string]>("SELECT * FROM pages WHERE id = ?").get(id);
    return row ? this.record(row) : undefined;
  }

  /** The source and its versions, newest first. */
  getSource(id: string): { source: string; versions: PageVersion[] } {
    const row = this.deps.db
      .query<Pick<PageRow, "source">, [string]>("SELECT source FROM pages WHERE id = ?")
      .get(id);
    if (!row) throw new CoreError("not_found", `Unknown page ${id}`);
    return { source: row.source, versions: this.versions(id) };
  }

  /** The source of one saved version. */
  versionSource(id: string, version: number): string {
    const row = this.deps.db
      .query<{ source: string }, [string, number]>(
        "SELECT source FROM page_versions WHERE page_id = ? AND version = ?",
      )
      .get(id, version);
    if (!row) throw new CoreError("not_found", `Page ${id} has no version ${version}`);
    return row.source;
  }

  /** The server handlers of every page, for the runtime to register. */
  handlers(): { pageId: string; handlers: CServerHandler[] }[] {
    return this.deps.db
      .query<Pick<PageRow, "id" | "compiled">, []>("SELECT id, compiled FROM pages")
      .all()
      .map((row) => ({
        pageId: row.id,
        handlers: (JSON.parse(row.compiled) as Stored).serverHandlers,
      }));
  }

  /** Compiles without storing: what the editor asks for before a save. */
  check(source: string, id?: string): Diagnostic[] {
    return this.compilePage(source, id).diagnostics;
  }

  /** Compiles, and when it compiles, stores the page, its versions and the themes it declares. */
  save(id: string, source: string, by?: string): SaveResult {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      throw new CoreError("invalid", "A page id is lowercase letters, digits and underscores");
    }
    const result = this.compilePage(source, id);
    if (!result.ok || !result.page) return { ok: false, diagnostics: result.diagnostics };
    const at = this.now();
    const stored: Stored = { page: result.page, serverHandlers: result.serverHandlers };
    const { db } = this.deps;
    db.transaction(() => {
      db.query(
        `INSERT INTO pages (id, name, source, compiled, theme_refs, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source,
           compiled = excluded.compiled, theme_refs = excluded.theme_refs,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(
        id,
        result.page?.name ?? id,
        source,
        JSON.stringify(stored),
        JSON.stringify(result.themeRefs),
        at,
        by ?? null,
      );
      const last = db
        .query<{ v: number | null }, [string]>(
          "SELECT MAX(version) AS v FROM page_versions WHERE page_id = ?",
        )
        .get(id);
      db.query(
        "INSERT INTO page_versions (page_id, version, source, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)",
      ).run(id, (last?.v ?? 0) + 1, source, at, by ?? null);
      for (const theme of result.themes)
        this.storeTheme(theme, themeSource(source, theme.name), at, by);
    })();
    this.deps.bus.emit({ type: "page_changed", pageId: id });
    for (const theme of result.themes)
      this.deps.bus.emit({ type: "theme_changed", themeId: theme.id });
    const page = this.getPage(id) as PageRecord;
    return {
      ok: true,
      diagnostics: result.diagnostics,
      page,
      serverHandlers: result.serverHandlers,
    };
  }

  /** A save of that version's source, so it passes the same checks. */
  revert(id: string, version: number, by?: string): SaveResult {
    return this.save(id, this.versionSource(id, version), by);
  }

  /**
   * Recompiles every stored page from its source and stores what changed, for a start after
   * the compiler itself moved on (a new built-in, a bundled component): the source is as the
   * admin left it, so no version is saved. A page that no longer compiles is left as it was
   * and named, so the admin can open it. Returns the ids that were brought up to date.
   */
  refresh(): { refreshed: string[]; failed: { id: string; message: string }[] } {
    const refreshed: string[] = [];
    const failed: { id: string; message: string }[] = [];
    const rows = this.deps.db
      .query<Pick<PageRow, "id" | "source" | "compiled" | "theme_refs">, []>(
        "SELECT id, source, compiled, theme_refs FROM pages",
      )
      .all();
    for (const row of rows) {
      const result = this.compilePage(row.source, row.id);
      if (!result.ok || !result.page) {
        failed.push({
          id: row.id,
          message: result.diagnostics.map((d) => d.message).join("; "),
        });
        continue;
      }
      const stored: Stored = { page: result.page, serverHandlers: result.serverHandlers };
      const compiled = JSON.stringify(stored);
      const themeRefs = JSON.stringify(result.themeRefs);
      if (compiled === row.compiled && themeRefs === row.theme_refs) continue;
      this.deps.db
        .query("UPDATE pages SET compiled = ?, theme_refs = ? WHERE id = ?")
        .run(compiled, themeRefs, row.id);
      refreshed.push(row.id);
    }
    for (const id of refreshed) this.deps.bus.emit({ type: "page_changed", pageId: id });
    return { refreshed, failed };
  }

  /** Seeds `home` when there is no such page yet; true when it did. */
  ensure(id: string, generate: () => string): boolean {
    if (this.getPage(id)) return false;
    const result = this.save(id, generate(), undefined);
    if (!result.ok) {
      throw new CoreError(
        "internal",
        `The generated ${id} page does not compile: ${result.diagnostics.map((d) => d.message).join("; ")}`,
      );
    }
    return true;
  }

  // ───────── themes ─────────

  /** Every theme a viewer may pick, the built-ins first, with which `system` chooses. */
  listThemes(): ThemeRecord[] {
    const stored = this.storedThemes();
    const all = [...builtinThemes(), ...stored.map((s) => s.theme)];
    const selectable = selectableThemes(all);
    const lightDefault = selectable.find((t) => !isDark(t)) ?? selectable[0];
    const darkDefault = selectable.find((t) => isDark(t)) ?? selectable[0];
    return all.map((theme) => ({
      id: theme.id,
      name: theme.name,
      extends: theme.extends,
      css: theme.css,
      source: stored.find((s) => s.theme.id === theme.id)?.source ?? theme.source,
      builtin: isBuiltinTheme(theme),
      dark: isDark(theme),
      isLightDefault: theme.id === lightDefault?.id,
      isDarkDefault: theme.id === darkDefault?.id,
      breakpoints: {
        tablet: numberAt(theme, "breakpoints.tablet", 860),
        desktop: numberAt(theme, "breakpoints.desktop", 1100),
      },
      values: theme.values,
    }));
  }

  /** Compiles a theme's source against every page's references, and stores it when it passes. */
  saveTheme(
    id: string,
    source: string,
    by?: string,
  ): { ok: boolean; diagnostics: Diagnostic[]; theme?: ThemeRecord } {
    const diagnostics = new Diagnostics();
    const file = parse(source, diagnostics);
    const decl = file.themes[0];
    if (
      !diagnostics.failed &&
      (!decl || file.themes.length > 1 || file.pages.length || file.components.length)
    ) {
      diagnostics.error(
        "E001",
        decl?.span ?? { start: 0, end: 0, line: 1, col: 1 },
        "a theme file holds exactly one `theme`",
      );
    }
    if (!diagnostics.failed && decl && themeId(decl.name) !== id) {
      diagnostics.error(
        "E021",
        decl.span,
        `this file is theme \`${id}\`; rename it there, not here`,
      );
    }
    if (diagnostics.failed || !decl) return { ok: false, diagnostics: diagnostics.list };
    const others = this.storedThemes()
      .map((s) => s.theme)
      .filter((t) => t.id !== id);
    const result = compile({
      source,
      registry: this.deps.registry(),
      themes: others,
      otherPageRefs: this.allRefs(),
    });
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
    const theme = result.themes[0] as Theme;
    const at = this.now();
    this.storeTheme(theme, source, at, by);
    this.deps.bus.emit({ type: "theme_changed", themeId: theme.id });
    return {
      ok: true,
      diagnostics: result.diagnostics,
      theme: this.listThemes().find((t) => t.id === theme.id),
    };
  }

  // ───────── shared components ─────────

  /** The house's shared components file; empty until an admin writes one. */
  getComponents(): ComponentsRecord {
    const row = this.deps.db
      .query<ComponentsRow, [string]>("SELECT * FROM components WHERE id = ?")
      .get(SHARED);
    return {
      source: row?.source ?? "",
      updatedAt: row?.updated_at,
      updatedBy: row?.updated_by ?? undefined,
    };
  }

  /** Compiles without storing: what the editor asks for before a save. */
  checkComponents(source: string): Diagnostic[] {
    return this.compileComponents(source).diagnostics;
  }

  /**
   * Checks the shared file on its own, then every stored page against it; stores the file
   * and the recompiled pages only when all of that passes, so a shared change can never
   * leave a page that no longer compiles.
   */
  saveComponents(source: string, by?: string): SaveComponentsResult {
    const result = this.compileComponents(source);
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
    const pages = this.listPages().map((summary) => {
      const row = this.deps.db
        .query<Pick<PageRow, "source">, [string]>("SELECT source FROM pages WHERE id = ?")
        .get(summary.id) as Pick<PageRow, "source">;
      return { id: summary.id, compiled: this.compilePage(row.source, summary.id, source) };
    });
    const broken = pages.find((p) => !p.compiled.ok || !p.compiled.page);
    if (broken) {
      return {
        ok: false,
        diagnostics: result.diagnostics,
        page: broken.id,
        pageDiagnostics: broken.compiled.diagnostics,
      };
    }
    const at = this.now();
    const { db } = this.deps;
    db.transaction(() => {
      db.query(
        `INSERT INTO components (id, source, theme_refs, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET source = excluded.source,
           theme_refs = excluded.theme_refs, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(SHARED, source, JSON.stringify(result.themeRefs), at, by ?? null);
      for (const { id, compiled } of pages) {
        const stored: Stored = {
          page: compiled.page as CompiledPage,
          serverHandlers: compiled.serverHandlers,
        };
        db.query("UPDATE pages SET compiled = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(stored),
          at,
          id,
        );
      }
    })();
    this.deps.bus.emit({ type: "components_changed" });
    for (const { id } of pages) this.deps.bus.emit({ type: "page_changed", pageId: id });
    return { ok: true, diagnostics: result.diagnostics };
  }

  // ───────── internals ─────────

  private compilePage(source: string, id: string | undefined, sharedSource?: string) {
    return compile({
      source,
      registry: this.deps.registry(),
      themes: this.storedThemes().map((s) => s.theme),
      otherPageRefs: this.allRefs(id),
      requirePage: true,
      sharedSource: sharedSource ?? this.getComponents().source,
    });
  }

  private compileComponents(source: string) {
    return compile({
      source,
      registry: this.deps.registry(),
      themes: this.storedThemes().map((s) => s.theme),
      otherPageRefs: this.allRefs(),
      componentsOnly: true,
    });
  }

  /** Theme paths every page but `except`, and the shared components, reference. */
  private allRefs(except?: string): string[] {
    const shared = this.deps.db
      .query<Pick<ComponentsRow, "theme_refs">, [string]>(
        "SELECT theme_refs FROM components WHERE id = ?",
      )
      .get(SHARED);
    return this.deps.db
      .query<Pick<PageRow, "id" | "theme_refs">, []>("SELECT id, theme_refs FROM pages")
      .all()
      .filter((row) => row.id !== except)
      .flatMap((row) => JSON.parse(row.theme_refs) as string[])
      .concat(shared ? (JSON.parse(shared.theme_refs) as string[]) : []);
  }

  /** The stored themes, compiled over the built-ins in an order that resolves `extends`. */
  private storedThemes(): { theme: Theme; source: string }[] {
    const rows = this.deps.db.query<ThemeRow, []>("SELECT * FROM themes ORDER BY id").all();
    const done: { theme: Theme; source: string }[] = [];
    const pending = [...rows];
    for (let pass = 0; pending.length && pass < rows.length + 1; pass++) {
      for (const row of [...pending]) {
        const known = [...builtinThemes(), ...done.map((d) => d.theme)];
        if (row.extends && !known.some((t) => t.name === row.extends)) continue;
        const diagnostics = new Diagnostics();
        const decl = parse(row.source, diagnostics).themes[0];
        const theme =
          decl && !diagnostics.failed ? compileTheme(decl, known, diagnostics) : undefined;
        pending.splice(pending.indexOf(row), 1);
        // A stored theme that no longer compiles (its parent went away) is left out, not fatal.
        if (theme) done.push({ theme, source: row.source });
      }
    }
    return done;
  }

  private storeTheme(theme: Theme, source: string, at: number, by?: string): void {
    this.deps.db
      .query(
        `INSERT INTO themes (id, name, source, css, extends, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source,
           css = excluded.css, extends = excluded.extends, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(theme.id, theme.name, source, theme.css, theme.extends ?? null, at, by ?? null);
  }

  private versions(id: string): PageVersion[] {
    return this.deps.db
      .query<{ version: number; saved_at: number; saved_by: string | null }, [string]>(
        "SELECT version, saved_at, saved_by FROM page_versions WHERE page_id = ? ORDER BY version DESC",
      )
      .all(id)
      .map((row) => ({
        version: row.version,
        savedAt: row.saved_at,
        savedBy: row.saved_by ?? undefined,
      }));
  }

  private record(row: PageRow): PageRecord {
    return {
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ?? undefined,
      compiled: (JSON.parse(row.compiled) as Stored).page,
      themeRefs: JSON.parse(row.theme_refs) as string[],
    };
  }
}

const numberAt = (theme: Theme, path: string, fallback: number): number => {
  const value = lookup(theme, path);
  return value?.kind === "number" ? value.value : fallback;
};

/** The text of one `theme` declaration in a file, by name; the whole file when not found. */
export function themeSource(source: string, name: string): string {
  const diagnostics = new Diagnostics();
  const decl = parse(source, diagnostics).themes.find((t) => t.name === name);
  return decl ? source.slice(decl.span.start, decl.span.end) : source;
}
