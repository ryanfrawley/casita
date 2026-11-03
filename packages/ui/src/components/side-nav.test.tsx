import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SideNav, type SideNavItem } from "./side-nav.tsx";

const ITEMS: SideNavItem[] = [
  { value: "home", label: "Home", icon: "house" },
  { value: "devices", label: "Devices", href: "/devices", count: 12 },
  { value: "logs", label: "Logs", alert: "2 integrations failing" },
];
const item = (html: string, label: string) =>
  html.match(new RegExp(`<li><(a|button)[^>]*>(?:(?!</li>).)*${label}(?:(?!</li>).)*</li>`))?.[0] ??
  "";

test("a navigation landmark named Main by default", () => {
  const html = renderToStaticMarkup(<SideNav items={ITEMS} />);
  expect(html).toStartWith('<nav class="ca-nav" aria-label="Main"><div class="ca-nav-section">');
  expect(html).not.toContain("ca-nav-heading");
  expect(html).not.toContain("ca-nav-brand");
  expect(renderToStaticMarkup(<SideNav items={ITEMS} label="Settings" />)).toContain(
    'aria-label="Settings"',
  );
});

test("the item matching `value` is current", () => {
  const html = renderToStaticMarkup(<SideNav items={ITEMS} value="devices" />);
  expect(item(html, "Devices")).toContain('class="ca-nav-item ca-nav-on" aria-current="page"');
  expect(item(html, "Home")).not.toContain("aria-current");
  expect(item(html, "Home")).not.toContain("ca-nav-on");
  expect(html.match(/aria-current/g)).toHaveLength(1);
});

test("without `value`, an item's own `current` marks it", () => {
  const html = renderToStaticMarkup(
    <SideNav items={[{ label: "Home" }, { label: "Logs", current: true }]} />,
  );
  expect(item(html, "Logs")).toContain('aria-current="page"');
  expect(item(html, "Home")).not.toContain("aria-current");
});

test("when both have a value, `value` matching wins over `current`", () => {
  const html = renderToStaticMarkup(
    <SideNav
      items={[
        { value: "a", label: "A", current: true },
        { value: "b", label: "B" },
      ]}
      value="b"
    />,
  );
  expect(item(html, "A")).not.toContain("aria-current");
  expect(item(html, "B")).toContain('aria-current="page"');
});

test("an item with href is a link; without, a button", () => {
  const html = renderToStaticMarkup(<SideNav items={ITEMS} />);
  expect(item(html, "Devices")).toStartWith('<li><a href="/devices" class="ca-nav-item">');
  expect(item(html, "Home")).toStartWith('<li><button type="button" class="ca-nav-item">');
});

test("icon, label, count and alert", () => {
  const html = renderToStaticMarkup(<SideNav items={ITEMS} />);
  expect(item(html, "Home")).toContain('<svg class="ca-icon" width="20"');
  expect(item(html, "Home")).toContain('<span class="ca-nav-label">Home</span>');
  expect(item(html, "Devices")).toContain('<span class="ca-nav-count">12</span>');
  const logs = item(html, "Logs");
  expect(logs).toContain('<span class="ca-nav-alert" title="2 integrations failing">');
  expect(logs).toContain('role="img" aria-label="2 integrations failing"');
  expect(logs).not.toContain("ca-nav-count");
});

test("a count of 0 still shows", () => {
  expect(renderToStaticMarkup(<SideNav items={[{ label: "Inbox", count: 0 }]} />)).toContain(
    '<span class="ca-nav-count">0</span>',
  );
});

test("sections, with and without titles, replace items", () => {
  const html = renderToStaticMarkup(
    <SideNav
      items={[{ label: "Ignored" }]}
      sections={[
        { items: [{ label: "Home" }] },
        { title: "Admin", items: [{ label: "Users" }, { label: "Logs" }] },
      ]}
    />,
  );
  expect(html.match(/class="ca-nav-section"/g)).toHaveLength(2);
  expect(html.match(/class="ca-nav-heading"/g)).toHaveLength(1);
  expect(html).toContain('<div class="ca-nav-heading">Admin</div><ul class="ca-nav-list">');
  expect(html).not.toContain("Ignored");
});

test("brand, footer and className", () => {
  const html = renderToStaticMarkup(
    <SideNav items={[]} brand={<b>Casita</b>} footer="v1" className="x" />,
  );
  expect(html).toBe(
    '<nav class="ca-nav x" aria-label="Main"><div class="ca-nav-brand"><b>Casita</b></div>' +
      '<div class="ca-nav-section"><ul class="ca-nav-list"></ul></div><div class="ca-nav-foot">v1</div></nav>',
  );
});
