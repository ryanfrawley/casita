// The source pane: CodeMirror with Casa's colours, completions and the compiler's marks.

import { autocompletion, type CompletionContext, closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Diagnostic, linter, lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import {
  closeHoverTooltips,
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  hasHoverTooltips,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { cspNonce } from "../theme.ts";
import type { HoverInfo } from "./hover.ts";
import { type Completion, type Mark, type Stream, startState, token } from "./language.ts";

const casaLanguage = StreamLanguage.define({
  name: "casa",
  startState,
  token: (stream, state) => token(stream as unknown as Stream, state),
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"'] },
  },
});

const casaHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--terracotta-ink)", fontWeight: "600" },
  { tag: tags.typeName, color: "var(--sky)", fontWeight: "600" },
  { tag: tags.propertyName, color: "var(--ink)" },
  { tag: tags.variableName, color: "var(--ink)" },
  { tag: tags.string, color: "var(--sage)" },
  { tag: tags.number, color: "var(--ember)" },
  { tag: tags.atom, color: "var(--ember)" },
  { tag: tags.color, color: "var(--ember)" },
  { tag: tags.comment, color: "var(--ink-muted)", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--ink-muted)" },
  { tag: tags.invalid, color: "var(--danger)", textDecoration: "underline" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    font: "400 13px / 20px var(--font-mono)",
    color: "var(--ink)",
    backgroundColor: "var(--surface-raised)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-sunken)",
    color: "var(--ink-muted)",
    borderRight: "1px solid var(--line)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--lamp-soft)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
  ".cm-gutter-lint": { width: "14px" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "0 0 0 2px" },
  ".cm-lint-marker": { width: "10px", height: "10px", marginTop: "5px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--lamp-soft) 35%, transparent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink)",
    boxShadow: "var(--shadow-lift)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--lamp-soft)",
    color: "var(--ink)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--lamp)",
  },
  // A reference the house has: hoverable for its card, ⌘-clickable to open it.
  ".app-casa-ref": {
    textDecoration: "underline dotted var(--ink-muted)",
    textUnderlineOffset: "3px",
    borderRadius: "2px",
  },
  ".app-casa-ref:hover": {
    backgroundColor: "var(--lamp-soft)",
    textDecoration: "underline solid var(--ink)",
  },
  // CodeMirror wraps the card in its own `.cm-tooltip`, so the card is styled by its class alone.
  ".app-casa-hover": {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "var(--space-3)",
    font: "400 13px / 18px var(--font-sans)",
    maxWidth: "320px",
  },
  ".app-casa-hover-title": { fontWeight: "500", marginBottom: "2px" },
  ".app-casa-hover-id": { font: "400 12px / 16px var(--font-mono)", color: "var(--ink-muted)" },
  ".app-casa-hover-line": { color: "var(--ink-muted)" },
  ".app-casa-hover-missing": { color: "var(--danger)" },
  ".app-casa-hover-open": {
    alignSelf: "flex-start",
    marginTop: "var(--space-2)",
    padding: "0",
    border: "none",
    background: "none",
    font: "inherit",
    color: "var(--terracotta-ink)",
    cursor: "pointer",
  },
});

/** A hovered reference's card: the text it covers and what the house says of it. */
export interface Hover {
  from: number;
  to: number;
  info: HoverInfo;
}

/** A span of the text that names something the house has, so it can be hovered and opened. */
export interface Link {
  from: number;
  to: number;
}

/** Asks the link decorations to be found again: the house changed, so what is a link may have. */
const refreshLinks = StateEffect.define<null>();

const linkMark = Decoration.mark({ class: "app-casa-ref" });

/** Marks every link in view, from the latest `links` callback. */
function linkDecorations(links: () => CodeEditorProps["links"]) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.find(view);
      }
      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshLinks)),
        );
        if (update.docChanged || update.viewportChanged || refreshed) {
          this.decorations = this.find(update.view);
        }
      }
      find(view: EditorView): DecorationSet {
        const find = links();
        if (!find) return Decoration.none;
        const text = view.state.doc.toString();
        const ranges = view.visibleRanges.flatMap(({ from, to }) =>
          find(text, from, to).map((link) => linkMark.range(link.from, link.to)),
        );
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  marks: readonly Mark[];
  /** What to offer at the cursor; given the word being typed and its offset. */
  complete: (word: string, offset: number) => Completion[];
  /** What the house says of the reference at an offset, for the tooltip. */
  hover?: (offset: number) => Hover | null;
  /** The links in a span of the text, underlined as such. A new callback finds them again. */
  links?: (text: string, from: number, to: number) => readonly Link[];
  /** Opens a hovered thing's details: the tooltip's link, or a ⌘-click (Ctrl elsewhere). */
  onOpen?: (info: HoverInfo) => void;
  /** A request to move the cursor: the editor's Alt-click on the preview. */
  goTo?: { offset: number; at: number } | null;
  readOnly?: boolean;
  className?: string;
}

const openLabel = () =>
  /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "")
    ? "Open · ⌘-click"
    : "Open · Ctrl-click";

/** The tooltip's DOM: the name, the id, a line or two, and a link to open it when it is found. */
function hoverCard(info: HoverInfo, onOpen?: () => void): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "app-casa-hover";
  const title = dom.appendChild(document.createElement("div"));
  title.className = "app-casa-hover-title";
  title.textContent = info.title;
  if (info.found) {
    const id = dom.appendChild(document.createElement("div"));
    id.className = "app-casa-hover-id";
    id.textContent = `${info.kind} ${info.id}`;
  }
  for (const text of info.lines) {
    const line = dom.appendChild(document.createElement("div"));
    line.className = info.found ? "app-casa-hover-line" : "app-casa-hover-missing";
    line.textContent = text;
  }
  if (info.found && onOpen) {
    const open = dom.appendChild(document.createElement("button"));
    open.type = "button";
    open.className = "app-casa-hover-open";
    open.textContent = openLabel();
    open.addEventListener("click", onOpen);
  }
  return dom;
}

export function CodeEditor({
  value,
  onChange,
  marks,
  complete,
  hover,
  links,
  onOpen,
  goTo,
  readOnly,
  className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const latest = useRef({ onChange, complete, hover, links, onOpen });
  latest.current = { onChange, complete, hover, links, onOpen };
  const readOnlyPart = useRef(new Compartment());

  // Mounted once: the document is seeded here, and later values arrive through `value` below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mounted once
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        // A gutter's place is its order here: problems left of the numbers, so nothing empty
        // sits between a number and its line. Casa has no folding, so there is no fold gutter.
        lintGutter(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        casaLanguage,
        syntaxHighlighting(casaHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({
          override: [
            (context: CompletionContext) => {
              const word = context.matchBefore(/[a-zA-Z_.][a-zA-Z0-9_.]*/);
              if (!word && !context.explicit) return null;
              const options = latest.current.complete(word?.text ?? "", context.pos);
              if (!options.length) return null;
              return {
                from: word?.from ?? context.pos,
                options: options.map((option) => ({
                  label: option.label,
                  type: option.type,
                  detail: option.detail,
                  apply: option.apply,
                  boost: option.boost,
                })),
                validFor: /^[a-zA-Z_.][a-zA-Z0-9_.]*$/,
              };
            },
          ],
        }),
        hoverTooltip(
          (_view, pos) => {
            const card = latest.current.hover?.(pos);
            if (!card) return null;
            return {
              pos: card.from,
              end: card.to,
              above: true,
              create: () => ({
                dom: hoverCard(card.info, () => latest.current.onOpen?.(card.info)),
              }),
            };
          },
          { hoverTime: 250 },
        ),
        linkDecorations(() => latest.current.links),
        EditorView.domEventHandlers({
          click: (event, editor) => {
            if (!(event.metaKey || event.ctrlKey) || !latest.current.onOpen) return false;
            const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            const card = pos === null ? null : latest.current.hover?.(pos);
            if (!card?.info.found) return false;
            event.preventDefault();
            latest.current.onOpen(card.info);
            return true;
          },
        }),
        linter(() => []),
        keymap.of([...defaultKeymap, ...historyKeymap, ...lintKeymap, indentWithTab]),
        editorTheme,
        EditorView.cspNonce.of(cspNonce()),
        EditorView.lineWrapping,
        readOnlyPart.current.of(EditorState.readOnly.of(readOnly === true)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    // Escape closes a hovered reference's card. The card follows the pointer, not focus, so the
    // key is taken from the window; it is left alone when nothing is showing.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !hasHoverTooltips(editor.state)) return;
      event.preventDefault();
      editor.dispatch({ effects: closeHoverTooltips });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      editor.destroy();
      view.current = undefined;
    };
  }, []);

  // A value set from outside (a revert, a load, a format) replaces the text; typing never comes
  // back this way. The cursor stays on its line, as near its column as the new line allows.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    const head = editor.state.selection.main.head;
    const was = editor.state.doc.lineAt(head);
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    const doc = editor.state.doc;
    const line = doc.line(Math.min(was.number, doc.lines));
    editor.dispatch({ selection: { anchor: line.from + Math.min(head - was.from, line.length) } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: readOnlyPart.current.reconfigure(EditorState.readOnly.of(readOnly === true)),
    });
  }, [readOnly]);

  // A new `links` callback (the house changed) is not read here, only what it finds is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when `links` changes
  useEffect(() => {
    view.current?.dispatch({ effects: refreshLinks.of(null) });
  }, [links]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const length = editor.state.doc.length;
    const diagnostics: Diagnostic[] = marks
      .filter((mark) => mark.from <= length)
      .map((mark) => ({
        from: mark.from,
        to: Math.min(mark.to, length),
        severity: mark.severity,
        message: mark.message,
      }));
    editor.dispatch(setDiagnostics(editor.state, diagnostics));
  }, [marks]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !goTo) return;
    const offset = Math.min(goTo.offset, editor.state.doc.length);
    editor.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
    editor.focus();
  }, [goTo]);

  return <div ref={host} className={className} />;
}
