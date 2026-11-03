import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { Badge } from "./badge.tsx";

const icon = (name: string, spin = false) =>
  renderToStaticMarkup(<Icon name={name} size={14} spin={spin} />);

test("neutral by default, with no icon", () => {
  expect(renderToStaticMarkup(<Badge>Stopped</Badge>)).toBe(
    '<span class="ca-badge ca-badge-neutral">Stopped</span>',
  );
});

test("each tone with an icon draws it before the text", () => {
  expect(renderToStaticMarkup(<Badge tone="ok">Running</Badge>)).toBe(
    `<span class="ca-badge ca-badge-ok">${icon("check")}Running</span>`,
  );
  expect(renderToStaticMarkup(<Badge tone="error">Error</Badge>)).toContain(icon("triangle-alert"));
  expect(renderToStaticMarkup(<Badge tone="unavailable">Offline</Badge>)).toContain(
    icon("wifi-off"),
  );
});

test("pending spins its loader", () => {
  expect(renderToStaticMarkup(<Badge tone="pending">Starting</Badge>)).toContain(
    icon("loader-circle", true),
  );
});

test("on and brand have no icon of their own", () => {
  for (const tone of ["on", "brand"] as const) {
    expect(renderToStaticMarkup(<Badge tone={tone}>x</Badge>)).not.toContain("<svg");
  }
});

test("icon={null} leaves out the tone's icon", () => {
  expect(
    renderToStaticMarkup(
      <Badge tone="ok" icon={null}>
        Running
      </Badge>,
    ),
  ).toBe('<span class="ca-badge ca-badge-ok">Running</span>');
});

test("a custom icon replaces the tone's, and does not spin even when pending", () => {
  const html = renderToStaticMarkup(
    <Badge tone="pending" icon="lock">
      Locking
    </Badge>,
  );
  expect(html).toContain(icon("lock"));
  expect(html).not.toContain("ca-spin");
});

test("className is added", () => {
  expect(renderToStaticMarkup(<Badge className="x">y</Badge>)).toContain(
    'class="ca-badge ca-badge-neutral x"',
  );
});
