import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { gridHeight, useGridSnap } from "./hooks.ts";
import { setupDom } from "./test-dom.ts";

const dom = setupDom();

// The harness has no ResizeObserver or MutationObserver, and happy-dom lays nothing out, so the
// observers are stand-ins that never fire and each card reports the height in its `data-h`.
type Scope = Record<string, unknown>;
const scope = globalThis as unknown as Scope;
const saved = new Map<string, PropertyDescriptor | undefined>();
let rect: PropertyDescriptor | undefined;
let proto: Scope;

class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const put = (name: string, value: unknown) => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(scope, name));
  Object.defineProperty(scope, name, { value, configurable: true, writable: true });
};

beforeAll(() => {
  put("ResizeObserver", StubObserver);
  if (typeof scope.MutationObserver === "undefined") put("MutationObserver", StubObserver);
  // Kept, since the harness takes `HTMLElement` down before this file's afterAll runs.
  proto = (scope.HTMLElement as typeof HTMLElement).prototype as unknown as Scope;
  rect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const height = Number(this.dataset.h ?? 0);
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height } as DOMRect;
  };
});

afterAll(() => {
  if (rect) Object.defineProperty(proto, "getBoundingClientRect", rect);
  else delete proto.getBoundingClientRect;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(scope, name, descriptor);
    else delete scope[name];
  }
});

function Grid({ heights }: { heights: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useGridSnap(ref, ".card");
  return (
    <div ref={ref}>
      {heights.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
        <div key={i} className="card" data-h={h} />
      ))}
    </div>
  );
}

const floors = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>(".card")].map((card) => card.style.minHeight);

describe("gridHeight", () => {
  test("rounds a height up to whole units, a gutter between them, and leaves a unit or nothing alone", () => {
    expect(gridHeight(150)).toBe(200);
    expect(gridHeight(200)).toBe(200);
    expect(gridHeight(1)).toBe(56);
    expect(gridHeight(0)).toBe(0);
  });
});

describe("useGridSnap", () => {
  test("a card between units is floored at the next unit; one on a unit, or empty, is left alone", async () => {
    const el = await dom.render(<Grid heights={[70, 56, 0]} />);
    expect(floors(el)).toEqual(["128px", "", ""]);
  });

  test("without ResizeObserver it sets nothing", async () => {
    const observer = scope.ResizeObserver;
    scope.ResizeObserver = undefined;
    try {
      const el = await dom.render(<Grid heights={[70, 100]} />);
      expect(floors(el)).toEqual(["", ""]);
    } finally {
      scope.ResizeObserver = observer;
    }
  });
});
