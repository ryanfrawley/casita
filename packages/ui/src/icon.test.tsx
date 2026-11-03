import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEVICE_ICON,
  DOMAIN_ICON,
  ICON_NAMES,
  ICON_PATHS,
  Icon,
  type IconName,
  resolveIcon,
  WEATHER_ICON,
} from "./icon.tsx";
import { EXTRA_ICON_PATHS } from "./icon-paths.extra.gen.ts";
import { ICON_PATHS as BUNDLE_ICON_PATHS } from "./icon-paths.gen.ts";
import { ICON_TAGS } from "./icon-tags.gen.ts";
import { cx } from "./util.ts";

test("the set is the design system's 77 icons and all of Lucide, with no name said twice", () => {
  const bundle = Object.keys(BUNDLE_ICON_PATHS);
  const extra = Object.keys(EXTRA_ICON_PATHS);
  expect(bundle).toHaveLength(77);
  expect(extra.length).toBeGreaterThan(1700);
  expect(ICON_NAMES).toHaveLength(bundle.length + extra.length);
  expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  // Every extra is drawn with the same elements as the bundle, so the one stroke suits it.
  for (const paths of Object.values(EXTRA_ICON_PATHS))
    expect(paths).toMatch(/^(<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/>)+$/);
});

test("the extras cover the house, its rooms, the outdoors, its people and its sensors", () => {
  for (const name of [
    "sofa",
    "bed",
    "bath",
    "refrigerator",
    "trees",
    "dog",
    "camera",
    "zap",
    "rocking-chair",
    "app-window",
    "user-round",
    "baby",
    "radar",
    "magnet",
    "vibrate",
  ])
    expect(resolveIcon(name)).toBe(name as IconName);
});

test("every tagged icon exists, and its tags add words its name does not say", () => {
  const names = new Set<string>(ICON_NAMES);
  for (const [name, tags] of Object.entries(ICON_TAGS)) {
    expect(names.has(name)).toBe(true);
    expect(tags).not.toBe("");
  }
  expect(ICON_TAGS.armchair).toContain("couch");
  expect(ICON_TAGS["app-window"]).not.toContain("window");
});

test("every domain, device kind and weather condition maps to an icon that exists", () => {
  for (const map of [DOMAIN_ICON, DEVICE_ICON, WEATHER_ICON]) {
    for (const name of Object.values(map)) expect(ICON_NAMES).toContain(name);
  }
});

test("a name resolves as an icon, a domain, or a device kind", () => {
  expect(resolveIcon("lightbulb")).toBe("lightbulb");
  expect(resolveIcon("light")).toBe("lightbulb");
  expect(resolveIcon("garage_door")).toBe("warehouse");
  // `lock`, `fan` and `car` are both a domain or kind and an icon; they agree.
  expect(resolveIcon("lock")).toBe("lock");
  expect(resolveIcon("nope")).toBeUndefined();
  expect(resolveIcon("toString")).toBeUndefined();
});

test("draws at a 1.5 stroke in currentColor, hidden from assistive technology by default", () => {
  const html = renderToStaticMarkup(<Icon name="lock" />);
  expect(html).toStartWith('<svg class="ca-icon" width="20" height="20" viewBox="0 0 24 24"');
  expect(html).toContain('stroke="currentColor"');
  expect(html).toContain('stroke-width="1.5"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("<rect");
  expect(html).not.toContain("role=");
});

test("a title makes it an image with that name", () => {
  const html = renderToStaticMarkup(<Icon name="triangle-alert" title="Jammed" size={14} />);
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="Jammed"');
  expect(html).toContain('width="14"');
  expect(html).not.toContain("aria-hidden");
});

test("spin and className add classes", () => {
  const html = renderToStaticMarkup(<Icon name="loader-circle" spin className="x" />);
  expect(html).toContain('class="ca-icon ca-spin x"');
});

test("an unknown name draws an empty icon rather than throwing", () => {
  expect(renderToStaticMarkup(<Icon name="nope" />)).toMatch(/<svg[^>]*><\/svg>/);
});

test("cx joins class names and drops falsy ones", () => {
  expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  expect(cx()).toBe("");
});

test("a domain or a device kind draws its mapped icon's paths", () => {
  for (const [name, icon] of [
    ["light", DOMAIN_ICON.light],
    ["garage_door", DEVICE_ICON.garage_door],
  ] as const) {
    const html = renderToStaticMarkup(<Icon name={name} />);
    expect(html).toContain(ICON_PATHS[icon]);
    expect(html).toBe(renderToStaticMarkup(<Icon name={icon} />));
  }
});
