import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { SceneButton } from "./scene-button.tsx";

const NOW = new Date(2026, 6, 15, 18, 0).getTime();
const icon = (name: string, spin = false) =>
  renderToStaticMarkup(<Icon name={name} size={20} spin={spin} />);
/** The sub line's text, tags removed. */
const sub = (html: string) =>
  html.match(/<span class="ca-scene-sub">(.*?)<\/span><\/span>/)?.[1]?.replace(/<[^>]+>/g, "");

describe("SceneButton", () => {
  test("idle: a button with the play icon, name and description, described by its tooltip", () => {
    expect(
      renderToStaticMarkup(<SceneButton name="Movie night" description="Dims the lights" />),
    ).toBe(
      '<button type="button" class="ca-scene ca-scene-idle" title="Dims the lights">' +
        `<span class="ca-scene-icon">${icon("play")}</span>` +
        '<span class="ca-scene-text"><span class="ca-scene-name">Movie night</span>' +
        '<span class="ca-scene-sub">Dims the lights</span></span></button>',
    );
  });

  test("no description and no last run: no sub line", () => {
    expect(renderToStaticMarkup(<SceneButton name="x" />)).not.toContain("ca-scene-sub");
  });

  test("a last run replaces the description, written relative to now", () => {
    const html = renderToStaticMarkup(
      <SceneButton name="x" description="Dims the lights" lastRun={NOW - 4 * 6e4} now={NOW} />,
    );
    expect(sub(html)).toBe("Ran 4 min ago");
    expect(html).toContain('<span class="ca-scene-sub">Ran <time class="ca-time"');
    // The description is still the tooltip.
    expect(html).toContain('title="Dims the lights"');
  });

  test("an error replaces the last run, with a default word", () => {
    const props = { name: "x", description: "d", lastRun: NOW - 6e4, now: NOW } as const;
    expect(sub(renderToStaticMarkup(<SceneButton {...props} state="error" />))).toBe(
      "Didn’t finish",
    );
    expect(
      sub(renderToStaticMarkup(<SceneButton {...props} state="error" error="Lock jammed" />)),
    ).toBe("Lock jammed");
  });

  test("running text comes first of all, with a default word", () => {
    const props = { name: "x", description: "d", lastRun: NOW - 6e4, now: NOW } as const;
    expect(sub(renderToStaticMarkup(<SceneButton {...props} state="running" />))).toBe("Running…");
    expect(
      sub(
        renderToStaticMarkup(
          <SceneButton {...props} state="running" runningText="Closing blinds…" error="e" />,
        ),
      ),
    ).toBe("Closing blinds…");
  });

  test("running is busy, spins its loader, and is not natively disabled", () => {
    const html = renderToStaticMarkup(<SceneButton name="x" icon="sun" state="running" />);
    expect(html).toMatch(
      /^<button type="button" class="ca-scene ca-scene-running" aria-busy="true" aria-disabled="true">/,
    );
    expect(html).toContain(icon("loader-circle", true));
    expect(html).not.toContain(icon("sun"));
    expect(html).not.toContain(" disabled=");
  });

  test("error shows the alert icon; idle shows its own icon", () => {
    expect(renderToStaticMarkup(<SceneButton name="x" icon="sun" state="error" />)).toContain(
      icon("triangle-alert"),
    );
    const idle = renderToStaticMarkup(<SceneButton name="x" icon="sun" />);
    expect(idle).toContain(icon("sun"));
    expect(idle).not.toContain("aria-busy");
  });

  test("disabled is disabled; className is added", () => {
    expect(renderToStaticMarkup(<SceneButton name="x" disabled className="y" />)).toMatch(
      /^<button type="button" class="ca-scene ca-scene-idle y" disabled="">/,
    );
  });
});
