// A DOM for the tests that need events and focus. Everything else renders to markup.
//
// `bun test` runs every file in one process, so the globals are put up for one test file
// and taken down after it: the server's tests must never see a `window`.

import { afterAll, beforeAll } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

/** react-dom's client modules; not its server renderer, which needs no DOM. */
const REACT_DOM_CLIENT =
  /[\\/]react-dom[\\/](index|client|cjs[\\/]react-dom\.(development|production\.min))\.js$/;

type Scope = Record<string, unknown>;
const scope = globalThis as unknown as Scope;

export interface Dom {
  /** Renders into a fresh container and waits for effects. */
  render(node: ReactNode): Promise<HTMLElement>;
  /** Runs `fn` and waits for React to settle. */
  act(fn: () => void | Promise<void>): Promise<void>;
  click(el: Element | null | undefined): Promise<void>;
  /** A keydown on `el`, or on whatever has focus. */
  key(key: string, el?: Element | null, init?: KeyboardEventInit): Promise<void>;
  /** Types into an input the way a person would, so React sees the change. */
  type(el: Element | null | undefined, text: string): Promise<void>;
  readonly document: Document;
}

/** Call at the top of a test file; the returned handle works inside its tests. */
export function setupDom(): Dom {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let window: Window;
  let roots: { unmount(): void }[] = [];
  let reactAct: (fn: () => void | Promise<void>) => Promise<void>;
  let createRoot: (el: Element) => { render(node: ReactNode): void; unmount(): void };

  beforeAll(async () => {
    window = new Window({ url: "http://localhost/" });
    const source = window as unknown as Scope;
    for (const name of [...GLOBALS, "IS_REACT_ACT_ENVIRONMENT"]) {
      saved.set(name, Object.getOwnPropertyDescriptor(scope, name));
      const value = name === "IS_REACT_ACT_ENVIRONMENT" ? true : source[name];
      Object.defineProperty(scope, name, { value, configurable: true, writable: true });
    }
    // Imported only now: react-dom decides whether it has a DOM when it first loads. A component
    // that imports `react-dom` (for createPortal) has already loaded it with the test file, before
    // there was a DOM, and that copy never sees `input` events and throws on a keydown in a text
    // input. So the client renderer is dropped from the module cache and loaded again here.
    for (const key of Object.keys(require.cache)) {
      if (REACT_DOM_CLIENT.test(key)) delete require.cache[key];
    }
    ({ createRoot } = require("react-dom/client") as typeof import("react-dom/client"));
    reactAct = (await import("react")).act as typeof reactAct;
  });

  afterAll(async () => {
    await reactAct(() => {
      for (const root of roots) root.unmount();
    });
    roots = [];
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(scope, name, descriptor);
      else delete scope[name];
    }
    await window.happyDOM.close();
  });

  const act: Dom["act"] = (fn) => reactAct(fn);
  return {
    act,
    get document() {
      return window.document as unknown as Document;
    },
    async render(node) {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(() => root.render(node));
      return container;
    },
    async click(el) {
      if (!el) throw new Error("Nothing to click");
      await act(() => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        (el as HTMLElement).click();
      });
    },
    async key(key, el, init) {
      const target = el ?? document.activeElement ?? document.body;
      await act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
      });
    },
    async type(el, text) {
      if (!el) throw new Error("Nothing to type into");
      const input = el as HTMLInputElement;
      await act(() => {
        // React tracks the value it last set; going through the prototype's setter is what
        // makes it see this as the person's change.
        const proto = Object.getPrototypeOf(input);
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  };
}
