// The Casa editor: the page's source on the left, the live page on the right. The compiler
// runs in the browser on every keystroke, so diagnostics are inline with no round trip; the
// server compiles again on save, with every stored page in view.

import { CasitaError } from "@casita/client";
import {
  type CompileResult,
  compile,
  type Diagnostic,
  formatSource,
  HEADERS_SOURCE,
  type Registry,
  type Theme,
  UNAVAILABLE,
  type Value,
} from "@casita/core/casa";
import {
  Badge,
  Button,
  EmptyState,
  ICON_NAMES,
  SegmentedControl,
  Sheet,
  Skeleton,
  TextField,
  Timestamp,
} from "@casita/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor, type Hover, type Link } from "../casa/editor.tsx";
import { describeReference, type HoverInfo } from "../casa/hover.ts";
import {
  completions,
  describeTrigger,
  marks,
  offsetOf,
  propertiesAt,
  referenceAt,
  referencesIn,
  themePathsAt,
} from "../casa/language.ts";
import { CasaPage } from "../casa/page.tsx";
import { useCasaStore, useHouse, useIsAdmin, useStore, useThemes, useToast } from "../context.tsx";
import { useThingSheets } from "../detail.tsx";
import { useNavigate } from "../shell.tsx";
import type { House } from "../store.ts";
import { ownStyle, type ThemeInfo } from "../theme.ts";
import { usePinnedWidth, useSplit, useWidth } from "./split.tsx";

export const CHECK_DEBOUNCE_MS = 300;
/** The preview's widths: Fit follows the preview pane as it is resized; the rest are fixed. */
const WIDTHS = { Fit: 0, Phone: 420, Tablet: 900, Desktop: 1200 } as const;
type Width = keyof typeof WIDTHS;

/** The house as the compiler needs it, from what the app already holds. */
export const registryOf = (house: House): Registry => ({
  entities: house.entities.map((e) => ({
    id: String(e.id),
    domain: e.domain as "light",
    name: String(e.name),
  })),
  areas: house.areas.map((a) => ({ id: String(a.id), name: String(a.name) })),
  devices: house.devices.map((d) => ({ id: String(d.id), name: String(d.name) })),
  icons: ICON_NAMES,
  // None listed is none loaded yet (or not an admin's to see): the server checks on save.
  integrations: house.integrations.length
    ? house.integrations.map((i) => ({
        id: String(i.integrationId),
        // Only a running instance's actions are known; one that isn't running still resolves.
        actions:
          i.status === "running" && Array.isArray(i.actions)
            ? (i.actions as { name: string; schema?: unknown }[])
            : undefined,
      }))
    : undefined,
});

/** The server's themes as the compiler takes them, for the coverage check. */
const themesOf = (themes: readonly ThemeInfo[]): Theme[] =>
  themes.map((t) => ({
    id: t.id,
    name: t.name,
    extends: t.extends,
    values: t.values ?? {},
    css: t.css,
  }));

/** A pretend value as typed: a number, `.On`, `unavailable`, or words. Empty clears. */
export function parseOverride(text: string): Value | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "unavailable") return UNAVAILABLE;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^\.?[A-Z][a-zA-Z0-9]*$/.test(trimmed)) return trimmed.replace(/^\./, "");
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  return trimmed;
}

interface Source {
  source: string;
  versions: { version: number; savedAt: number; savedBy?: string }[];
}

function useSource(pageId: string) {
  const store = useStore();
  const { phase } = useHouse();
  const [loaded, setLoaded] = useState<Source | { error: string } | undefined>();
  const load = useCallback(async () => {
    try {
      setLoaded((await store.request("get_page_source", { pageId })) as Source);
    } catch (err) {
      setLoaded({ error: err instanceof CasitaError ? err.message : "Couldn't load the page" });
    }
  }, [store, pageId]);
  useEffect(() => {
    if (phase === "ready") void load();
  }, [phase, load]);
  return { loaded, reload: load };
}

/** The house's shared components, as the page's compile needs them; refetched when saved. */
function useSharedSource(): string | undefined {
  const store = useStore();
  const { phase } = useHouse();
  const [source, setSource] = useState<string | undefined>();
  useEffect(() => {
    if (phase !== "ready") return;
    let current = true;
    const load = () =>
      store.request("get_components_source", {}).then(
        (record) => {
          if (current) setSource(String((record as { source: string }).source ?? ""));
        },
        () => {
          if (current) setSource("");
        },
      );
    void load();
    const off = store.onEvent("components_changed", () => void load());
    return () => {
      current = false;
      off();
    };
  }, [store, phase]);
  return source;
}

/** The list of problems under the editor; clicking one moves the cursor there. */
export function Problems({
  diagnostics,
  source,
  onPick,
}: {
  diagnostics: Diagnostic[];
  source: string;
  onPick: (offset: number) => void;
}) {
  if (!diagnostics.length) return <p className="app-muted app-casa-problems-none">No problems.</p>;
  return (
    <ul className="app-casa-problems">
      {diagnostics.map((d) => (
        <li key={`${d.code}-${d.span.start}-${d.span.end}-${d.message}`}>
          <button type="button" onClick={() => onPick(offsetOf(source, d.span.line, d.span.col))}>
            <Badge tone={d.level === "error" ? "error" : "pending"}>{d.code}</Badge>
            <span className="app-casa-problem-at">
              {d.span.line}:{d.span.col}
            </span>
            <span>{d.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The pretend panel: an override per entity the page reads, and the screen size. */
function Pretend({
  entities,
  overrides,
  onChange,
  width,
  onWidth,
}: {
  entities: string[];
  overrides: ReadonlyMap<string, string>;
  onChange: (id: string, text: string) => void;
  width: Width;
  onWidth: (width: Width) => void;
}) {
  return (
    <div className="app-casa-pretend">
      <div className="app-casa-pretend-head">
        <h3 className="ca-text-heading">Pretend</h3>
        <SegmentedControl
          label="Screen"
          value={width}
          onChange={(value) => onWidth(value as Width)}
          options={(Object.keys(WIDTHS) as Width[]).map((w) => ({ value: w, label: w }))}
        />
      </div>
      <p className="app-muted">
        A value here replaces what the entity reports, in this preview only. Numbers, `.On`-style
        words, or `unavailable`.
      </p>
      {entities.length ? (
        <div className="app-casa-pretend-grid">
          {entities.map((id) => (
            <TextField
              key={id}
              label={id}
              mono
              value={overrides.get(id) ?? ""}
              placeholder="as reported"
              onChange={(event) => onChange(id, event.target.value)}
            />
          ))}
        </div>
      ) : (
        <p className="app-muted">The page reads no entities yet.</p>
      )}
    </div>
  );
}

/**
 * The things of the house a source names: the ones the house has, underlined as links; what the
 * editor's tooltip says of the reference under the pointer; and the sheet that opens on one.
 */
export function useReferences(house: House, text: string | undefined) {
  const { open, sheets } = useThingSheets();
  const hover = useCallback(
    (offset: number): Hover | null => {
      const ref = text === undefined ? null : referenceAt(text, offset);
      if (!ref) return null;
      return { from: ref.from, to: ref.to, info: describeReference(house, ref) };
    },
    [text, house],
  );
  // Given the editor's own text, which may be a keystroke ahead of `text`.
  const links = useCallback(
    (source: string, from: number, to: number): Link[] =>
      referencesIn(source, from, to).filter((ref) => describeReference(house, ref).found),
    [house],
  );
  const onOpen = useCallback(
    (info: HoverInfo) => {
      if (info.found) open({ kind: info.kind, id: info.id });
    },
    [open],
  );
  return { hover, links, onOpen, sheets };
}

export function PageEditor({ pageId }: { pageId: string }) {
  const store = useStore();
  const house = useHouse();
  const themes = useThemes();
  const casa = useCasaStore();
  const toast = useToast();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const { loaded, reload } = useSource(pageId);
  const [text, setText] = useState<string | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  // The preview keeps the last page that compiled while the text is between two that do.
  const [shown, setShown] = useState<CompileResult["page"]>();
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string>>(new Map());
  const [width, setWidth] = useState<Width>("Fit");
  const split = useSplit();
  const [previewPane, paneWidth] = useWidth<HTMLDivElement>();
  const [goTo, setGoTo] = useState<{ offset: number; at: number } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"problems" | "pretend" | "handlers">("problems");
  const dirty = loaded && "source" in loaded && text !== undefined && text !== loaded.source;

  // The source arrives once; after that the editor's text is what matters.
  useEffect(() => {
    if (loaded && "source" in loaded && text === undefined) setText(loaded.source);
  }, [loaded, text]);

  const registry = useMemo(() => registryOf(house), [house]);
  const compiled = useMemo(() => themesOf(themes), [themes]);
  const sharedSource = useSharedSource();

  // Compile on a debounce as the admin types.
  useEffect(() => {
    if (text === undefined) return;
    const timer = setTimeout(() => {
      const next = compile({
        source: text,
        registry,
        themes: compiled,
        requirePage: true,
        sharedSource,
      });
      setResult(next);
      if (next.page) setShown(next.page);
      setServerDiagnostics([]);
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, registry, compiled, sharedSource]);

  // The preview's width and pretend values live in the shared store; they are cleared on leaving.
  // `screen` is read from the preview's own width, not the window's, so a page laid out for
  // a phone or a tablet shows as it would there.
  const previewWidth = WIDTHS[width] || paneWidth;
  usePinnedWidth(casa, previewWidth);
  useEffect(() => {
    const parsed = new Map<string, Value>();
    for (const [id, value] of overrides) {
      const v = parseOverride(value);
      if (v !== undefined) parsed.set(id, v);
    }
    casa.setOverrides(parsed);
    return () => casa.setOverrides(new Map());
  }, [casa, overrides]);

  const diagnostics = useMemo(
    () => [...(result?.diagnostics ?? []), ...serverDiagnostics],
    [result, serverDiagnostics],
  );
  const marked = useMemo(() => marks(diagnostics, text?.length ?? 0), [diagnostics, text]);
  const componentNames = useMemo(() => Object.keys(result?.page?.components ?? {}), [result]);
  const componentParams = useMemo(
    () =>
      Object.fromEntries(
        Object.values(result?.page?.components ?? {}).map((c) => [
          c.name,
          c.params.map((p) => p.name),
        ]),
      ),
    [result],
  );
  const themePaths = useMemo(
    () => [...new Set(compiled.flatMap((t) => Object.keys(t.values)))].sort(),
    [compiled],
  );
  const complete = useCallback(
    (word: string, offset: number) => {
      const fromTheme = themePathsAt(word, themePaths);
      if (fromTheme.length) return fromTheme;
      const props = text ? propertiesAt(text, offset, componentParams) : [];
      const all = completions(registry, componentNames);
      const needle = word.toLowerCase();
      return [...props, ...all].filter((c) => !needle || c.label.toLowerCase().startsWith(needle));
    },
    [text, registry, componentNames, componentParams, themePaths],
  );
  const references = useReferences(house, text);

  const locate = useCallback(
    (at: [number, number]) => {
      if (text === undefined) return;
      setGoTo({ offset: offsetOf(text, at[0], at[1]), at: Date.now() });
    },
    [text],
  );

  const { format, formatted } = useFormat(text, setText, result);

  const save = async (raw: string) => {
    const source = formatted(raw);
    setSaving(true);
    try {
      // The server sees every stored page, so its check covers what the browser's cannot.
      const checked = (await store.request("check_page", { pageId, source })) as {
        diagnostics: Diagnostic[];
      };
      const refused = checked.diagnostics.filter((d) => d.level === "error");
      if (refused.length) {
        setServerDiagnostics(refused);
        setTab("problems");
        toast({ tone: "error", title: "Not saved", message: refused[0]?.message ?? "" });
        return;
      }
      const saved = (await store.request("save_page", { pageId, source })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      setServerDiagnostics(saved.diagnostics.filter((d) => d.level === "error"));
      if (saved.ok) {
        toast({ tone: "ok", message: "Page saved; everyone sees it now" });
        await reload();
        setText(source);
      } else {
        toast({
          tone: "error",
          title: "Not saved",
          message: `${saved.diagnostics.length} problem${saved.diagnostics.length === 1 ? "" : "s"}; see the list below the source`,
        });
        setTab("problems");
      }
    } catch (err) {
      toast({
        tone: "error",
        title: "Couldn't save",
        message: err instanceof CasitaError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const revert = async (version: number) => {
    setVersionsOpen(false);
    setSaving(true);
    try {
      const reverted = (await store.request("revert_page", { pageId, version })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      if (reverted.ok) {
        toast({ tone: "ok", message: `Reverted to version ${version}` });
        setText(undefined);
        await reload();
      } else {
        setServerDiagnostics(reverted.diagnostics);
        toast({
          tone: "error",
          title: "That version no longer compiles",
          message: "The house has changed since; fix it in the editor instead.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (!admin) {
    return (
      <div className="app-page">
        <EmptyState icon="shield" title="Only an admin can edit a page" />
      </div>
    );
  }
  if (!loaded || text === undefined) {
    if (loaded && "error" in loaded) {
      return (
        <div className="app-page">
          <EmptyState
            icon="triangle-alert"
            title="Couldn't load the page"
            description={loaded.error}
          />
        </div>
      );
    }
    return (
      <div className="app-page">
        <Skeleton shape="block" width="100%" height={400} />
      </div>
    );
  }
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const handlers = result?.serverHandlers ?? [];

  return (
    <div className="app-casa-editor">
      <div className="app-casa-editor-bar">
        <div className="app-casa-editor-title">
          <h1 className="ca-text-title">Edit {loaded && "source" in loaded ? pageId : ""}</h1>
          {dirty ? <Badge tone="pending">Unsaved</Badge> : <Badge tone="neutral">Saved</Badge>}
          {errors ? (
            <Badge tone="error">
              {errors} error{errors === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="app-casa-editor-actions">
          <Button variant="quiet" size="sm" onClick={() => navigate("/")}>
            Close
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setVersionsOpen(true)}>
            Versions
          </Button>
          <Button variant="quiet" size="sm" disabled={saving} onClick={format}>
            Format
          </Button>
          <Button
            size="sm"
            disabled={saving || errors > 0 || !dirty}
            onClick={() => void save(text)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div className="app-casa-editor-panes" ref={split.ref} style={split.style}>
        <div className="app-casa-editor-source">
          <CodeEditor
            value={text}
            onChange={setText}
            marks={marked}
            complete={complete}
            hover={references.hover}
            links={references.links}
            onOpen={references.onOpen}
            goTo={goTo}
            className="app-casa-code"
          />
          {references.sheets}
          <div className="app-casa-editor-drawer">
            <SegmentedControl
              label="Drawer"
              value={tab}
              onChange={(value) => setTab(value as typeof tab)}
              options={[
                {
                  value: "problems",
                  label: diagnostics.length ? `Problems (${diagnostics.length})` : "Problems",
                },
                { value: "pretend", label: "Pretend" },
                {
                  value: "handlers",
                  label: handlers.length ? `Handlers (${handlers.length})` : "Handlers",
                },
              ]}
            />
            {tab === "problems" ? (
              <Problems
                diagnostics={diagnostics}
                source={text}
                onPick={(offset) => setGoTo({ offset, at: Date.now() })}
              />
            ) : tab === "pretend" ? (
              <Pretend
                entities={result?.page?.entities ?? []}
                overrides={overrides}
                onChange={(id, value) =>
                  setOverrides((current) => new Map([...current, [id, value]]))
                }
                width={width}
                onWidth={setWidth}
              />
            ) : (
              <HandlerList handlers={handlers} />
            )}
          </div>
        </div>
        {split.handle}
        <div className="app-casa-editor-preview" ref={previewPane}>
          <div className="app-casa-preview-head">
            <span className="app-muted">
              Live preview on the real house: a control here really sends. Alt-click a card to find
              it in the source.
            </span>
            {previewWidth ? (
              <span className="app-muted app-casa-preview-size">
                {width === "Fit"
                  ? `${Math.round(previewWidth)} px`
                  : `${width}, ${previewWidth} px`}
              </span>
            ) : null}
          </div>
          {shown ? (
            // A fixed width wider than the pane scrolls sideways rather than squeezing the page.
            <div
              className="app-casa-preview-frame"
              style={WIDTHS[width] ? { width: WIDTHS[width] } : undefined}
            >
              <CasaPage page={shown} onLocate={locate} className="app-page app-casa-preview-page" />
            </div>
          ) : (
            <EmptyState
              size="inline"
              icon="triangle-alert"
              title="Nothing to show yet"
              description="The preview shows the page as soon as it compiles."
            />
          )}
        </div>
      </div>
      <Sheet
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        title="Versions"
        subtitle="Every save; revert is a save of that version's source"
      >
        <ul className="app-casa-versions">
          {(loaded && "versions" in loaded ? loaded.versions : []).map((v) => (
            <li key={v.version} className="app-casa-item">
              <span>
                <strong>Version {v.version}</strong>{" "}
                <Timestamp value={v.savedAt} className="app-muted" />
                {v.savedBy ? <span className="app-muted"> · {v.savedBy}</span> : null}
              </span>
              <Button size="sm" onClick={() => void revert(v.version)}>
                Revert
              </Button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}

/**
 * Formatting for a source editor. `format` tidies the text in place, or says why it cannot;
 * `formatted` is the text a save sends, put in the editor when it moved, so what is stored is
 * in the house style and the editor shows it.
 */
export function useFormat(
  text: string | undefined,
  setText: (text: string) => void,
  result: CompileResult | undefined,
) {
  const toast = useToast();
  const format = () => {
    if (text === undefined) return;
    const tidied = formatSource(text);
    if (tidied !== text) setText(tidied);
    // Formatting leaves a source that does not parse alone; say why nothing moved.
    else if (result?.diagnostics.some((d) => d.code === "E001")) {
      toast({ tone: "error", title: "Not formatted", message: "Fix the syntax errors first" });
    }
  };
  const formatted = (raw: string) => {
    const source = formatSource(raw);
    if (source !== raw) setText(source);
    return source;
  };
  return { format, formatted };
}

export function HandlerList({ handlers }: { handlers: CompileResult["serverHandlers"] }) {
  if (!handlers.length) return <p className="app-muted">No server handlers in this page.</p>;
  return (
    <ul className="app-casa-handlers">
      {handlers.map((h) => (
        <li key={`${h.line}`} className="app-casa-item">
          <code>{describeTrigger(h.trigger)}</code>
          <span className="app-muted">line {h.line}</span>
          <Badge tone="neutral">armed after save</Badge>
        </li>
      ))}
    </ul>
  );
}

// ───────── themes ─────────

export function ThemeEditor({ themeId }: { themeId: string }) {
  const split = useSplit();
  const [previewPane, paneWidth] = useWidth<HTMLDivElement>();
  usePinnedWidth(useCasaStore(), paneWidth);
  const store = useStore();
  const house = useHouse();
  const themes = useThemes();
  const toast = useToast();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const theme = themes.find((t) => t.id === themeId);
  const [text, setText] = useState<string | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [saving, setSaving] = useState(false);
  const home = useHomePage();
  const styleRef = useRef<HTMLStyleElement>();

  // A theme that is not stored yet starts from a template named after its id.
  useEffect(() => {
    if (text !== undefined || !themes.length) return;
    const name = themeId.charAt(0).toUpperCase() + themeId.slice(1);
    setText(theme?.source ?? `theme ${theme?.name ?? name} extends Night {\n  palette { }\n}\n`);
  }, [theme, themes, themeId, text]);

  const registry = useMemo(() => registryOf(house), [house]);
  const others = useMemo(() => themesOf(themes.filter((t) => t.id !== themeId)), [themes, themeId]);
  useEffect(() => {
    if (text === undefined) return;
    const timer = setTimeout(() => {
      setResult(
        compile({ source: text, registry, themes: others, otherPageRefs: home?.themeRefs ?? [] }),
      );
      setServerDiagnostics([]);
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, registry, others, home]);

  // The preview is drawn in the theme as it compiles right now; the page's own theme comes back on leaving.
  const compiledTheme = result?.themes[0];
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    const style = ownStyle("casa-theme-preview");
    styleRef.current = style;
    return () => {
      style.remove();
      if (before) root.dataset.theme = before;
      else delete root.dataset.theme;
    };
  }, []);
  useEffect(() => {
    if (!compiledTheme || !styleRef.current) return;
    styleRef.current.textContent = compiledTheme.css.replace(
      `[data-theme="${compiledTheme.id}"]`,
      '[data-theme="casa-preview"]',
    );
    document.documentElement.dataset.theme = "casa-preview";
  }, [compiledTheme]);

  const diagnostics = useMemo(
    () => [...(result?.diagnostics ?? []), ...serverDiagnostics],
    [result, serverDiagnostics],
  );
  const marked = useMemo(() => marks(diagnostics, text?.length ?? 0), [diagnostics, text]);
  const complete = useCallback(
    (word: string) => {
      const paths = [...new Set(others.flatMap((t) => Object.keys(t.values)))].sort();
      const fromTheme = themePathsAt(word, paths);
      return fromTheme.length
        ? fromTheme
        : completions(registry).filter((c) => c.type === "keyword" || c.type === "variable");
    },
    [others, registry],
  );

  const { format, formatted } = useFormat(text, setText, result);

  const save = async (raw: string) => {
    const source = formatted(raw);
    setSaving(true);
    try {
      const saved = (await store.request("save_theme", { themeId, source })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
      };
      setServerDiagnostics(saved.diagnostics.filter((d) => d.level === "error"));
      if (saved.ok) toast({ tone: "ok", message: "Theme saved" });
      else
        toast({ tone: "error", title: "Not saved", message: "See the problems under the source" });
    } catch (err) {
      toast({
        tone: "error",
        title: "Couldn't save",
        message: err instanceof CasitaError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!admin) {
    return (
      <div className="app-page">
        <EmptyState icon="shield" title="Only an admin can edit a theme" />
      </div>
    );
  }
  if (text === undefined) {
    return (
      <div className="app-page">
        <Skeleton shape="block" width="100%" height={400} />
      </div>
    );
  }
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const palette = Object.entries(compiledTheme?.values ?? {}).filter(([path]) =>
    path.startsWith("palette."),
  );

  return (
    <div className="app-casa-editor">
      <div className="app-casa-editor-bar">
        <div className="app-casa-editor-title">
          <h1 className="ca-text-title">Theme {theme?.name ?? themeId}</h1>
          {theme?.builtin ? <Badge tone="neutral">Built in · read only</Badge> : null}
          {!theme ? <Badge tone="pending">New</Badge> : null}
          {errors ? (
            <Badge tone="error">
              {errors} error{errors === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="app-casa-editor-actions">
          <Button variant="quiet" size="sm" onClick={() => navigate("/settings")}>
            Close
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={saving || theme?.builtin === true}
            onClick={format}
          >
            Format
          </Button>
          <Button
            size="sm"
            disabled={saving || errors > 0 || theme?.builtin === true}
            onClick={() => void save(text)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div className="app-casa-editor-panes" ref={split.ref} style={split.style}>
        <div className="app-casa-editor-source">
          <CodeEditor
            value={text}
            onChange={setText}
            marks={marked}
            complete={complete}
            readOnly={theme?.builtin === true}
            className="app-casa-code"
          />
          <div className="app-casa-editor-drawer">
            <ul className="app-casa-swatches" aria-label="Palette">
              {palette.map(([path, value]) => (
                <li key={path} className="app-casa-swatch" title={path}>
                  <span style={{ background: value.kind === "color" ? value.hex : undefined }} />
                  <small>{path.slice(8)}</small>
                </li>
              ))}
            </ul>
            <Problems diagnostics={diagnostics} source={text} onPick={() => {}} />
          </div>
        </div>
        {split.handle}
        <div className="app-casa-editor-preview" ref={previewPane}>
          <div className="app-casa-preview-head">
            <span className="app-muted">Home, drawn in this theme as you type.</span>
          </div>
          {home?.compiled ? (
            <CasaPage page={home.compiled} className="app-page app-casa-preview-page" />
          ) : (
            <Skeleton shape="block" width="100%" height={300} />
          )}
        </div>
      </div>
    </div>
  );
}

// ───────── shared components ─────────

/** The empty file's starting text: Casita's own headings, commented, to copy from. */
const COMPONENTS_TEMPLATE = `// The house's shared components: every page may use what is declared here.
// A component named AreaHeader, CardHeader or SectionHeader replaces Casita's own on every
// page; \`header:\` on one Area, Card or Section names another. Casita's are:

${HEADERS_SOURCE.split("\n")
  .map((line) => (line ? `// ${line}` : "//"))
  .join("\n")}
`;

export function ComponentsEditor() {
  const split = useSplit();
  const [previewPane, paneWidth] = useWidth<HTMLDivElement>();
  usePinnedWidth(useCasaStore(), paneWidth);
  const store = useStore();
  const house = useHouse();
  const themes = useThemes();
  const toast = useToast();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const { phase } = house;
  const [loaded, setLoaded] = useState<string | undefined>();
  const [text, setText] = useState<string | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  const [home, setHome] = useState<string | undefined>();
  const [preview, setPreview] = useState<CompileResult["page"]>();
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (phase !== "ready") return;
    void store.request("get_components_source", {}).then(
      (record) => setLoaded(String((record as { source: string }).source ?? "")),
      (err) =>
        toast({
          tone: "error",
          title: "Couldn't load",
          message: err instanceof CasitaError ? err.message : String(err),
        }),
    );
    void store.request("get_page_source", { pageId: "home" }).then(
      (page) => setHome((page as Source).source),
      () => {},
    );
  }, [store, phase, toast]);
  useEffect(() => {
    if (loaded !== undefined && text === undefined) setText(loaded || COMPONENTS_TEMPLATE);
  }, [loaded, text]);

  const registry = useMemo(() => registryOf(house), [house]);
  const compiled = useMemo(() => themesOf(themes), [themes]);
  // The file on its own, then Home drawn against it, as the admin types.
  useEffect(() => {
    if (text === undefined) return;
    const timer = setTimeout(() => {
      setResult(compile({ source: text, registry, themes: compiled, componentsOnly: true }));
      setServerDiagnostics([]);
      if (home !== undefined) {
        const page = compile({
          source: home,
          registry,
          themes: compiled,
          requirePage: true,
          sharedSource: text,
        });
        if (page.page) setPreview(page.page);
      }
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, registry, compiled, home]);

  const diagnostics = useMemo(
    () => [...(result?.diagnostics ?? []), ...serverDiagnostics],
    [result, serverDiagnostics],
  );
  const marked = useMemo(() => marks(diagnostics, text?.length ?? 0), [diagnostics, text]);
  const themePaths = useMemo(
    () => [...new Set(compiled.flatMap((t) => Object.keys(t.values)))].sort(),
    [compiled],
  );
  const complete = useCallback(
    (word: string, offset: number) => {
      const fromTheme = themePathsAt(word, themePaths);
      if (fromTheme.length) return fromTheme;
      const props = text ? propertiesAt(text, offset, {}) : [];
      const all = completions(registry, []);
      const needle = word.toLowerCase();
      return [...props, ...all].filter((c) => !needle || c.label.toLowerCase().startsWith(needle));
    },
    [text, registry, themePaths],
  );
  const references = useReferences(house, text);

  const { format, formatted } = useFormat(text, setText, result);

  const save = async (raw: string) => {
    const source = formatted(raw);
    setSaving(true);
    try {
      // The server sees every stored theme, so its check covers what the browser's cannot.
      const checked = (await store.request("check_components", { source })) as {
        diagnostics: Diagnostic[];
      };
      const refused = checked.diagnostics.filter((d) => d.level === "error");
      if (refused.length) {
        setServerDiagnostics(refused);
        toast({ tone: "error", title: "Not saved", message: refused[0]?.message ?? "" });
        return;
      }
      const saved = (await store.request("save_components", { source })) as {
        ok: boolean;
        diagnostics: Diagnostic[];
        page?: string;
        pageDiagnostics?: Diagnostic[];
      };
      if (saved.ok) {
        setServerDiagnostics([]);
        setLoaded(source);
        toast({ tone: "ok", message: "Shared components saved; every page uses them now" });
      } else if (saved.page) {
        // A page no longer compiles against the file: its problems, named for the page.
        setServerDiagnostics(
          (saved.pageDiagnostics ?? [])
            .filter((d) => d.level === "error")
            .map((d) => ({ ...d, message: `page ${saved.page}: ${d.message}` })),
        );
        toast({
          tone: "error",
          title: "Not saved",
          message: `The ${saved.page} page would no longer compile; see the problems under the source`,
        });
      } else {
        setServerDiagnostics(saved.diagnostics.filter((d) => d.level === "error"));
        toast({ tone: "error", title: "Not saved", message: "See the problems under the source" });
      }
    } catch (err) {
      toast({
        tone: "error",
        title: "Couldn't save",
        message: err instanceof CasitaError ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!admin) {
    return (
      <div className="app-page">
        <EmptyState icon="shield" title="Only an admin can edit the shared components" />
      </div>
    );
  }
  if (text === undefined) {
    return (
      <div className="app-page">
        <Skeleton shape="block" width="100%" height={400} />
      </div>
    );
  }
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const dirty = text !== (loaded || COMPONENTS_TEMPLATE) && text !== loaded;

  return (
    <div className="app-casa-editor">
      <div className="app-casa-editor-bar">
        <div className="app-casa-editor-title">
          <h1 className="ca-text-title">Shared components</h1>
          {dirty ? <Badge tone="pending">Unsaved</Badge> : null}
          {errors ? (
            <Badge tone="error">
              {errors} error{errors === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="app-casa-editor-actions">
          <Button variant="quiet" size="sm" onClick={() => navigate("/settings")}>
            Close
          </Button>
          <Button variant="quiet" size="sm" disabled={saving} onClick={format}>
            Format
          </Button>
          <Button size="sm" disabled={saving || errors > 0} onClick={() => void save(text)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div className="app-casa-editor-panes" ref={split.ref} style={split.style}>
        <div className="app-casa-editor-source">
          <CodeEditor
            value={text}
            onChange={setText}
            marks={marked}
            complete={complete}
            hover={references.hover}
            links={references.links}
            onOpen={references.onOpen}
            className="app-casa-code"
          />
          {references.sheets}
          <div className="app-casa-editor-drawer">
            <Problems diagnostics={diagnostics} source={text} onPick={() => {}} />
          </div>
        </div>
        {split.handle}
        <div className="app-casa-editor-preview" ref={previewPane}>
          <div className="app-casa-preview-head">
            <span className="app-muted">Home, drawn with these components as you type.</span>
          </div>
          {preview ? (
            <CasaPage page={preview} className="app-page app-casa-preview-page" />
          ) : (
            <Skeleton shape="block" width="100%" height={300} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The stored Home page, for a theme's preview. */
function useHomePage() {
  const store = useStore();
  const { phase } = useHouse();
  const [home, setHome] = useState<
    { compiled: CompileResult["page"]; themeRefs: string[] } | undefined
  >();
  useEffect(() => {
    if (phase !== "ready") return;
    void store.request("get_page", { pageId: "home" }).then(
      (page) => setHome(page as { compiled: CompileResult["page"]; themeRefs: string[] }),
      () => {},
    );
  }, [store, phase]);
  return home;
}
