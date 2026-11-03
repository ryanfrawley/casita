// EntityTile, DeviceSection and Area: the parts of the device views that respond to a press.

import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { Area } from "./area.tsx";
import { DeviceSection } from "./device-card.tsx";
import { EntityTile } from "./entity-tile.tsx";

const dom = setupDom();

describe("EntityTile", () => {
  test("a click on the tile calls onToggle", async () => {
    let toggles = 0;
    const el = await dom.render(
      <EntityTile
        name="Lamp"
        entityId="light.lamp"
        domain="light"
        state="off"
        onToggle={() => toggles++}
      />,
    );
    await dom.click(el.querySelector("button.ca-tile"));
    await dom.click(el.querySelector("button.ca-tile"));
    expect(toggles).toBe(2);
  });

  test("a click on a read-only or unavailable tile calls nothing", async () => {
    let toggles = 0;
    const onToggle = () => toggles++;
    const el = await dom.render(
      <>
        <EntityTile
          name="a"
          entityId="a"
          domain="light"
          state="on"
          level="read"
          onToggle={onToggle}
        />
        <EntityTile name="b" entityId="b" domain="light" state="unavailable" onToggle={onToggle} />
      </>,
    );
    expect(el.querySelector("button")).toBeNull();
    for (const tile of el.querySelectorAll(".ca-tile")) await dom.click(tile);
    expect(toggles).toBe(0);
  });
});

describe("DeviceSection", () => {
  test("the toggle collapses and expands the body, saying which", async () => {
    const el = await dom.render(
      <DeviceSection title="Zone 1" summary="Watering" collapsible>
        <p className="row">row</p>
      </DeviceSection>,
    );
    const toggle = el.querySelector(".ca-dsec-toggle");
    const body = el.querySelector(".ca-dsec-body");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-controls")).toBe(body?.id ?? "");

    await dom.click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".ca-dsec-body")).toBeNull();
    expect(el.querySelector(".row")).toBeNull();
    expect(el.firstElementChild?.className).toBe("ca-dsec ca-dsec-closed");
    // The summary still says what the group is doing.
    expect(el.querySelector(".ca-dsec-summary")?.textContent).toBe("Watering");

    await dom.click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".row")).not.toBeNull();
  });

  test("defaultOpen={false} starts closed and opens on a click", async () => {
    const el = await dom.render(
      <DeviceSection title="Zone 2" collapsible defaultOpen={false}>
        <p className="row">row</p>
      </DeviceSection>,
    );
    expect(el.querySelector(".row")).toBeNull();
    await dom.click(el.querySelector(".ca-dsec-toggle"));
    expect(el.querySelector(".row")).not.toBeNull();
  });
});

describe("Area", () => {
  test("collapsing hides the grid and keeps the facts and actions", async () => {
    const el = await dom.render(
      <Area
        name="Kitchen"
        collapsible
        facts={[{ label: "Window open", tone: "alert" }]}
        actions={
          <button type="button" className="all-off">
            All off
          </button>
        }
      >
        <div className="card">card</div>
      </Area>,
    );
    const toggle = el.querySelector(".ca-area-toggle");
    expect(toggle?.getAttribute("aria-controls")).toBe(el.querySelector(".ca-area-grid")?.id ?? "");

    await dom.click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".ca-area-grid")).toBeNull();
    expect(el.querySelector(".card")).toBeNull();
    expect(el.querySelector(".ca-area-facts")?.textContent).toBe("Window open");
    expect(el.querySelector(".all-off")).not.toBeNull();
    expect(el.firstElementChild?.className).toBe("ca-area ca-area-closed");

    await dom.click(toggle);
    expect(el.querySelector(".card")).not.toBeNull();
  });

  test("with no ResizeObserver, masonry stays off and nothing throws", async () => {
    expect(typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBe("undefined");
    const el = await dom.render(
      <Area name="Hall">
        <div>card</div>
      </Area>,
    );
    expect(el.querySelector(".ca-area-grid")?.className).toBe("ca-area-grid");
  });

  test("with ResizeObserver, masonry turns on and off with the grid without throwing", async () => {
    // A browser has both observers; the harness puts up neither. Lend this test the DOM's own,
    // and take them down again before the next.
    const scope = globalThis as Record<string, unknown>;
    const window = dom.document.defaultView as unknown as Record<string, unknown>;
    const names = ["ResizeObserver", "MutationObserver"] as const;
    const saved = names.map((name) => Object.getOwnPropertyDescriptor(scope, name));
    for (const name of names) {
      Object.defineProperty(scope, name, {
        value: window[name],
        configurable: true,
        writable: true,
      });
    }
    try {
      let setCards: (n: number) => void = () => {};
      function Room() {
        const [cards, set] = useState(1);
        setCards = set;
        return (
          <Area name="Office" collapsible>
            {Array.from({ length: cards }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cards
              <div key={i} className="card">
                card
              </div>
            ))}
          </Area>
        );
      }
      const el = await dom.render(<Room />);
      expect(el.querySelector(".ca-area-grid")?.classList.contains("ca-area-masonry")).toBe(true);
      await dom.act(() => setCards(3));
      expect(el.querySelectorAll(".card")).toHaveLength(3);
      // Collapsing removes the grid and with it the observers.
      await dom.click(el.querySelector(".ca-area-toggle"));
      expect(el.querySelector(".ca-area-grid")).toBeNull();
      await dom.click(el.querySelector(".ca-area-toggle"));
      expect(el.querySelector(".ca-area-grid")?.classList.contains("ca-area-masonry")).toBe(true);
      // Collapse once more so nothing is left observing once the globals are gone.
      await dom.click(el.querySelector(".ca-area-toggle"));
    } finally {
      names.forEach((name, i) => {
        const descriptor = saved[i];
        if (descriptor) Object.defineProperty(scope, name, descriptor);
        else delete scope[name];
      });
    }
  });

  test("masonry={false} never turns masonry on", async () => {
    const el = await dom.render(
      <Area name="Garage" masonry={false}>
        <div>card</div>
      </Area>,
    );
    expect(el.querySelector(".ca-area-grid")?.className).toBe("ca-area-grid");
  });
});
