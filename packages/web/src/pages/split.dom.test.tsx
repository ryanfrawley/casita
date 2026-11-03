import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@casita/ui/test-dom";
import { useSplit } from "./split.tsx";

const dom = setupDom();

// The share is remembered by the browser; the DOM harness puts up no `localStorage`.
const scope = globalThis as unknown as Record<string, unknown>;
const KEY = "casita.editor-split";
const remembered = new Map<string, string>();
let savedStorage: unknown;
beforeAll(() => {
  savedStorage = scope.localStorage;
  scope.localStorage = {
    getItem: (key: string) => remembered.get(key) ?? null,
    setItem: (key: string, value: string) => remembered.set(key, value),
    removeItem: (key: string) => remembered.delete(key),
  };
});
afterAll(() => {
  scope.localStorage = savedStorage;
});
beforeEach(() => remembered.clear());

/** The two panes as an editor lays them out, with the handle between. */
function Panes() {
  const { ref, style, handle } = useSplit();
  return (
    <div className="panes" ref={ref} style={style}>
      <div>source</div>
      {handle}
      <div>preview</div>
    </div>
  );
}

async function mount() {
  const el = await dom.render(<Panes />);
  const handle = el.querySelector("[role=separator]") as HTMLElement;
  return { el, handle, now: () => Number(handle.getAttribute("aria-valuenow")) };
}

const doubleClick = (el: Element) =>
  dom.act(() => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });

describe("useSplit", () => {
  test("the handle is a focusable vertical separator between 15 and 85, at 45 to start", async () => {
    const { handle, now } = await mount();
    expect(handle).not.toBeNull();
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("15");
    expect(handle.getAttribute("aria-valuemax")).toBe("85");
    expect(handle.tabIndex).toBe(0);
    expect(now()).toBe(45);
  });

  test("the panes carry the source's share as a CSS variable", async () => {
    const { el } = await mount();
    const panes = el.querySelector(".panes") as HTMLElement;
    expect(panes.style.getPropertyValue("--app-casa-source")).toBe("45.00%");
  });

  test("the arrow keys move the line two points at a time", async () => {
    const { handle, now } = await mount();
    await dom.key("ArrowRight", handle);
    expect(now()).toBe(47);
    await dom.key("ArrowRight", handle);
    expect(now()).toBe(49);
    await dom.key("ArrowLeft", handle);
    expect(now()).toBe(47);
  });

  test("Home and End put the line at its bounds", async () => {
    const { handle, now } = await mount();
    await dom.key("Home", handle);
    expect(now()).toBe(15);
    // Already at the bound, ArrowLeft goes no further.
    await dom.key("ArrowLeft", handle);
    expect(now()).toBe(15);
    await dom.key("End", handle);
    expect(now()).toBe(85);
    await dom.key("ArrowRight", handle);
    expect(now()).toBe(85);
  });

  test("other keys leave the line where it is", async () => {
    const { handle, now } = await mount();
    await dom.key("ArrowUp", handle);
    await dom.key("a", handle);
    expect(now()).toBe(45);
    expect(remembered.has(KEY)).toBe(false);
  });

  test("a double-click puts the line back at 45", async () => {
    const { handle, now } = await mount();
    await dom.key("End", handle);
    expect(now()).toBe(85);
    await doubleClick(handle);
    expect(now()).toBe(45);
    expect(Number(remembered.get(KEY))).toBe(0.45);
  });

  test("a moved line is remembered and read back by the next editor", async () => {
    const first = await mount();
    await dom.key("ArrowRight", first.handle);
    await dom.key("ArrowRight", first.handle);
    expect(Number(remembered.get(KEY))).toBeCloseTo(0.49);

    const second = await mount();
    expect(second.now()).toBe(49);
  });

  test("a remembered share out of bounds is brought back within them", async () => {
    remembered.set(KEY, "0.99");
    expect((await mount()).now()).toBe(85);
  });

  test("a remembered value that is not a number is ignored", async () => {
    remembered.set(KEY, "wide");
    expect((await mount()).now()).toBe(45);
  });

  test("a browser whose storage throws still moves the line", async () => {
    const working = scope.localStorage;
    scope.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    try {
      const { handle, now } = await mount();
      expect(now()).toBe(45);
      await dom.key("ArrowRight", handle);
      expect(now()).toBe(47);
    } finally {
      scope.localStorage = working;
    }
  });
});
