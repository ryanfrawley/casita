import { afterAll, beforeAll, expect, test } from "bun:test";
import { setupDom } from "@casita/ui/test-dom";
import { EditorView } from "@codemirror/view";
import { useState } from "react";
import { CodeEditor, type CodeEditorProps, type Link } from "./editor.tsx";

const dom = setupDom();

// CodeMirror watches its content with a MutationObserver, which `setupDom` does not put up. It is
// lent from happy-dom's window for this file, and taken down after it like the rest.
const scope = globalThis as unknown as Record<string, unknown>;
let savedObserver: PropertyDescriptor | undefined;
beforeAll(() => {
  savedObserver = Object.getOwnPropertyDescriptor(scope, "MutationObserver");
  const window = dom.document.defaultView as unknown as Record<string, unknown>;
  scope.MutationObserver = window.MutationObserver;
});
afterAll(() => {
  if (savedObserver) Object.defineProperty(scope, "MutationObserver", savedObserver);
  else delete scope.MutationObserver;
});

type Links = CodeEditorProps["links"];

const SOURCE = `page P {
  Row { of: light.hall }
  Row { of: switch.porch }
}`;

/** The span of the first `word` in the source, as a link would cover it. */
const span = (word: string): Link => {
  const from = SOURCE.indexOf(word);
  return { from, to: from + word.length };
};

/** The first of each `word` in the text it is given: what a house that has those things finds. */
const naming =
  (...words: string[]): NonNullable<Links> =>
  (text) =>
    words.flatMap((word) => {
      const from = text.indexOf(word);
      return from < 0 ? [] : [{ from, to: from + word.length }];
    });

/** An editor whose text and `links` can be swapped from a test: a load, or the house changing. */
async function mount(initial?: Links) {
  let setLinks: (links: Links) => void = () => {};
  let setValue: (value: string) => void = () => {};
  function Harness() {
    const [links, set] = useState<{ links: Links }>({ links: initial });
    const [value, setText] = useState(SOURCE);
    setLinks = (next) => set({ links: next });
    setValue = setText;
    return (
      <CodeEditor
        value={value}
        onChange={() => {}}
        marks={[]}
        complete={() => []}
        links={links.links}
      />
    );
  }
  const el = await dom.render(<Harness />);
  return {
    el,
    /** The text of every span the editor marks as a link, in order. */
    marked: () => [...el.querySelectorAll(".app-casa-ref")].map((ref) => ref.textContent),
    relink: (links: Links) => dom.act(() => setLinks(links)),
    retext: (value: string) => dom.act(() => setValue(value)),
  };
}

// ───────── tests ─────────

test("the spans `links` returns are marked, and the text around them is not", async () => {
  const { el, marked } = await mount(() => [span("light.hall"), span("switch.porch")]);
  expect(el.querySelector(".cm-content")?.textContent).toContain("Row { of: light.hall }");
  expect(marked()).toEqual(["light.hall", "switch.porch"]);
  // Only the reference is wrapped: the line it sits on is not.
  for (const ref of el.querySelectorAll(".app-casa-ref")) {
    expect(ref.closest(".cm-line")?.textContent).not.toBe(ref.textContent);
  }
});

test("`links` is asked for the editor's text and the span it shows", async () => {
  const calls: [string, number, number][] = [];
  await mount((text, from, to) => {
    calls.push([text, from, to]);
    return [];
  });
  expect(calls.length).toBeGreaterThan(0);
  const [text, from, to] = calls[0] ?? ["", -1, -1];
  expect(text).toBe(SOURCE);
  expect(from).toBe(0);
  expect(to).toBe(SOURCE.length);
});

test("with no `links` nothing is marked", async () => {
  const { el, marked } = await mount();
  expect(el.querySelector(".cm-content")?.textContent).toContain("switch.porch");
  expect(marked()).toEqual([]);
});

test("a new `links` callback marks again: what it finds is added, and what it drops is cleared", async () => {
  const { marked, relink } = await mount(() => [span("light.hall")]);
  expect(marked()).toEqual(["light.hall"]);

  await relink(() => [span("switch.porch")]);
  expect(marked()).toEqual(["switch.porch"]);

  await relink(() => []);
  expect(marked()).toEqual([]);

  await relink(undefined);
  expect(marked()).toEqual([]);

  await relink(() => [span("light.hall"), span("switch.porch")]);
  expect(marked()).toEqual(["light.hall", "switch.porch"]);
});

test("a change to the text finds the links again, with the same callback", async () => {
  const { marked, retext } = await mount(naming("light.hall", "cover.garage"));
  expect(marked()).toEqual(["light.hall"]);

  // As long as what it replaces, so the view's span stays put and only the text has changed.
  await retext(SOURCE.replace("switch.porch", "cover.garage"));
  expect(marked()).toEqual(["light.hall", "cover.garage"]);

  await retext("page P {}");
  expect(marked()).toEqual([]);
});

/** The editor's view, and where its cursor is as a line number and a column, both from 1. */
const viewOf = (el: HTMLElement) => {
  const view = EditorView.findFromDOM(el.querySelector(".cm-editor") as HTMLElement);
  if (!view) throw new Error("no editor");
  return view;
};
const cursor = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return [line.number, head - line.from + 1];
};

test("a text set from outside keeps the cursor on its line and column", async () => {
  const { el, retext } = await mount();
  const view = viewOf(el);
  // On line 3, just before `switch.porch`.
  await dom.act(() => view.dispatch({ selection: { anchor: SOURCE.indexOf("switch.porch") } }));
  expect(cursor(view)).toEqual([3, 13]);

  // A format: the lines move about within themselves, but line 3 is still line 3.
  await retext(SOURCE.replace("  Row { of: light.hall }", "Row {of:light.hall}"));
  expect(cursor(view)).toEqual([3, 13]);
});

test("a text set from outside puts the cursor at the end of a line now too short for it", async () => {
  const { el, retext } = await mount();
  const view = viewOf(el);
  await dom.act(() => view.dispatch({ selection: { anchor: SOURCE.indexOf("switch.porch") } }));

  await retext("page P {\n  Row { of: light.hall }\n  Row\n}");
  expect(cursor(view)).toEqual([3, 6]);
});

test("a text set from outside with fewer lines puts the cursor on its last line", async () => {
  const { el, retext } = await mount();
  const view = viewOf(el);
  await dom.act(() => view.dispatch({ selection: { anchor: SOURCE.length } }));
  expect(cursor(view)).toEqual([4, 2]);

  await retext("page P {}");
  expect(cursor(view)).toEqual([1, 2]);
});
