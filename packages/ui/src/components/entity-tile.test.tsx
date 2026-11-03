import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { EntityTile, type EntityTileProps } from "./entity-tile.tsx";

const noop = () => {};
const tile = (props: Partial<EntityTileProps> = {}) =>
  renderToStaticMarkup(
    <EntityTile
      name="Kitchen lamp"
      entityId="light.kitchen"
      domain="light"
      state="off"
      area="Kitchen"
      onToggle={noop}
      {...props}
    />,
  );
const spinner = renderToStaticMarkup(
  <Icon name="loader-circle" size={18} spin className="ca-tile-spinner" />,
);

describe("EntityTile", () => {
  test("a controllable tile is one button: icon, name, state word, area, entity id as tooltip", () => {
    expect(tile()).toBe(
      '<button type="button" class="ca-tile ca-tile-off" aria-pressed="false" title="light.kitchen">' +
        `<div class="ca-tile-top"><span class="ca-tile-icon">${renderToStaticMarkup(<Icon name="light" size={22} />)}</span></div>` +
        '<div class="ca-tile-name">Kitchen lamp</div>' +
        '<div class="ca-tile-state">Off</div>' +
        '<div class="ca-tile-caption">Kitchen</div></button>',
    );
  });

  test("on is the only state that is pressed", () => {
    expect(tile({ state: "on" })).toContain('aria-pressed="true"');
    expect(tile({ state: "off" })).toContain('aria-pressed="false"');
    expect(tile({ state: "pending" })).toContain('aria-pressed="false"');
  });

  test("each state has its word and class", () => {
    for (const [state, word] of [
      ["on", "On"],
      ["off", "Off"],
      ["pending", "Turning on…"],
    ] as const) {
      const html = tile({ state });
      expect(html).toContain(`class="ca-tile ca-tile-${state}"`);
      expect(html).toContain(`<div class="ca-tile-state">${word}</div>`);
    }
  });

  test("pending shows the spinner and is never styled on", () => {
    const html = tile({ state: "pending", brightness: 0.6 });
    expect(html).toContain(spinner);
    expect(html).not.toContain("ca-tile-on");
    // The brightness bar belongs to the confirmed on state only.
    expect(html).not.toContain("ca-tile-level");
    expect(tile({ state: "on" })).not.toContain(spinner);
    expect(tile({ state: "off" })).not.toContain(spinner);
  });

  test("unavailable is not a button and cannot be clicked", () => {
    const html = tile({ state: "unavailable" });
    expect(html.startsWith('<div class="ca-tile ca-tile-unavailable ca-tile-readonly"')).toBe(true);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('<div class="ca-tile-state">Unavailable</div>');
  });

  test("with no onToggle it is not a button", () => {
    const html = tile({ state: "on", onToggle: undefined });
    expect(html).not.toContain("<button");
    expect(html).toContain('class="ca-tile ca-tile-on ca-tile-readonly"');
    expect(html).toContain('title="light.kitchen"');
  });

  test('level="read" is not a button and says "View only" instead of the area', () => {
    const html = tile({ state: "on", level: "read" });
    expect(html).not.toContain("<button");
    expect(html).toContain("ca-tile-readonly");
    expect(html).toContain('<div class="ca-tile-caption">View only</div>');
    expect(html).not.toContain("Kitchen</div>");
    // Still shows the confirmed state.
    expect(html).toContain('<div class="ca-tile-state">On</div>');
  });

  test('level="control" with onToggle is a button', () => {
    expect(tile({ level: "control" })).toContain("<button");
  });

  test("no area and control level means no caption", () => {
    expect(tile({ area: undefined })).not.toContain("ca-tile-caption");
  });

  test("the brightness bar shows only when on, at the rounded percentage", () => {
    expect(tile({ state: "on", brightness: 0.604 })).toContain(
      '<div class="ca-tile-level"><span style="width:60%"></span></div>',
    );
    expect(tile({ state: "on", brightness: 0 })).toContain('style="width:0%"');
    expect(tile({ state: "off", brightness: 0.6 })).not.toContain("ca-tile-level");
    expect(tile({ state: "unavailable", brightness: 0.6 })).not.toContain("ca-tile-level");
    expect(tile({ state: "on" })).not.toContain("ca-tile-level");
  });

  test("summary overrides the state word", () => {
    expect(tile({ state: "on", summary: "On · 60%" })).toContain(
      '<div class="ca-tile-state">On · 60%</div>',
    );
    expect(tile({ state: "pending", summary: "Locking…" })).toContain(
      '<div class="ca-tile-state">Locking…</div>',
    );
  });

  test("the domain picks the icon", () => {
    expect(tile({ domain: "lock" })).toContain(
      renderToStaticMarkup(<Icon name="lock" size={22} />),
    );
  });

  test("className is added", () => {
    expect(tile({ className: "x" })).toContain('class="ca-tile ca-tile-off x"');
    expect(tile({ className: "x", onToggle: undefined })).toContain(
      'class="ca-tile ca-tile-off ca-tile-readonly x"',
    );
  });
});
