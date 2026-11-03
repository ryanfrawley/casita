import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { Thermostat, type ThermostatProps } from "./thermostat.tsx";

const thermo = (props: Partial<ThermostatProps> = {}) =>
  renderToStaticMarkup(
    <Thermostat
      name="Living room"
      current={21.24}
      target={21.5}
      mode="heat"
      action="heating"
      onTargetChange={() => {}}
      onModeChange={() => {}}
      {...props}
    />,
  );
const action = (html: string) =>
  html.match(/<span class="ca-thermo-action">(.*?)<\/span><\/header>/)?.[1];
const icon = (name: string, spin?: boolean) =>
  renderToStaticMarkup(<Icon name={name} size={16} spin={spin} />);

describe("Thermostat", () => {
  test("a section named by the thermostat: name, area, reading, entity id as tooltip", () => {
    const html = thermo({ area: "Downstairs", entityId: "climate.living", humidity: 48 });
    expect(html).toMatch(
      /^<section class="ca-thermo ca-thermo-heat" aria-label="Living room" title="climate.living">/,
    );
    expect(html).toContain('<div class="ca-thermo-name">Living room</div>');
    expect(html).toContain('<div class="ca-thermo-area">Downstairs</div>');
    expect(html).toContain(
      '<div class="ca-thermo-now"><span>21.2</span><span class="ca-thermo-unit">°C</span></div>',
    );
    expect(html).toContain('<div class="ca-thermo-caption">Inside now · 48% humidity</div>');
  });

  test("the header says what it is doing, each with its tone", () => {
    const cases: [Partial<ThermostatProps>, string, string, string, boolean?][] = [
      [{ action: "heating" }, "heat", "flame", "Heating"],
      [{ mode: "cool", action: "cooling" }, "cool", "snowflake", "Cooling"],
      [{ action: "idle" }, "idle", "check", "Idle"],
      // A device that does not say what it is doing: the mode it is set to, and no claim beyond it.
      [{ action: null }, "idle", "flame", "Heat"],
      [{ mode: "cool", action: undefined }, "idle", "snowflake", "Cool"],
      [{ mode: "auto", action: undefined }, "idle", "check", "Auto"],
      [{ mode: "off", action: "heating" }, "off", "power", "Off"],
      [{ available: false }, "off", "wifi-off", "Unavailable"],
      [{ pendingMode: "cool" }, "pending", "loader-circle", "Switching to cool…", true],
    ];
    for (const [props, tone, name, text, spin] of cases) {
      const html = thermo(props);
      expect(html).toContain(`class="ca-thermo ca-thermo-${tone}"`);
      expect(action(html)).toBe(`${icon(name, spin)}${text}`);
    }
  });

  test("a pending mode outranks unavailable and off", () => {
    expect(action(thermo({ pendingMode: "heat", mode: "off", available: false }))).toContain(
      "Switching to heat…",
    );
    // Unavailable outranks off.
    expect(action(thermo({ mode: "off", available: false }))).toContain("Unavailable");
  });

  test("an unknown pending mode is named as given", () => {
    expect(action(thermo({ pendingMode: "dry" }))).toContain("Switching to dry…");
  });

  test("off has no target, whatever the set point", () => {
    const html = thermo({ mode: "off" });
    expect(html).toContain('<span class="ca-thermo-none">No target</span>');
    expect(html).not.toContain("ca-stepper");
  });

  test("no set point while on is a dash", () => {
    const html = thermo({ target: null });
    expect(html).toContain('<span class="ca-thermo-none">—</span>');
    expect(html).not.toContain("ca-stepper");
  });

  test("controllable: a Stepper named for the thermostat, showing the target", () => {
    const html = thermo();
    expect(html).toContain('role="group" aria-label="Living room target"');
    expect(html).toMatch(/<output class="ca-stepper-value"[^>]*>21.5°<\/output>/);
  });

  test("read-only or unavailable: the target as a static value", () => {
    for (const props of [{ level: "read" as const }, { available: false }]) {
      const html = thermo({ ...props, target: 21 });
      expect(html).toContain('<span class="ca-thermo-static">21°</span>');
      expect(html).not.toContain("ca-stepper");
    }
  });

  test("a target in flight says Sending… and the stepper shows the pending value", () => {
    const html = thermo({ pendingTarget: 22 });
    expect(html).toContain('<span class="ca-thermo-label ca-thermo-sending">Target');
    expect(html).toContain(
      `<span class="ca-thermo-sendword" role="status">${renderToStaticMarkup(<Icon name="loader-circle" size={12} spin />)}Sending…</span>`,
    );
    expect(html).toMatch(/<output class="ca-stepper-value"[^>]*>22°<\/output>/);
    expect(html).toContain('aria-busy="true"');
    // The stepper's own spinner is left out: "Sending…" says it once.
    expect(html).not.toContain("ca-stepper-spin");
    expect(thermo()).not.toContain("Sending…");
  });

  test('read level: "View only · Heat mode", no mode control', () => {
    const html = thermo({ level: "read" });
    expect(html).toContain(
      `<div class="ca-thermo-foot">${renderToStaticMarkup(<Icon name="lock" size={14} />)}View only · Heat mode</div>`,
    );
    expect(html).not.toContain('role="radiogroup"');
  });

  test("the mode control lists the modes and checks the current one, or the pending one", () => {
    const html = thermo({ mode: "heat" });
    expect(html).toContain('role="radiogroup" aria-label="Mode"');
    const labels = [...html.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Heat", "Cool", "Auto", "Off"]);
    expect(html).toMatch(/aria-checked="true" class="ca-seg-opt ca-seg-on">Heat</);
    expect(thermo({ pendingMode: "cool" })).toMatch(
      /aria-checked="true" class="ca-seg-opt ca-seg-on">Cool</,
    );
  });

  test("custom modes are listed, known ones by their word and others as given", () => {
    const html = thermo({ modes: ["heat", "off", "fan_only"] });
    const labels = [...html.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Heat", "Off", "fan_only"]);
  });

  test("no reading is a dash; unavailable says so in the caption and hides humidity", () => {
    expect(thermo({ current: null })).toContain("<span>—</span>");
    expect(thermo({ available: false, humidity: 40 })).toContain(
      '<div class="ca-thermo-caption">Unavailable · last reading</div>',
    );
    expect(thermo({ available: false, current: null })).toContain(
      '<div class="ca-thermo-caption">Unavailable</div>',
    );
  });

  test("a custom unit and className", () => {
    const html = thermo({ unit: "°F", className: "x" });
    expect(html).toContain('<span class="ca-thermo-unit">°F</span>');
    expect(html).toContain('class="ca-thermo ca-thermo-heat x"');
  });
});
