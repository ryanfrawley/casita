import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "./badge.tsx";
import { IntegrationRow, type IntegrationRowProps } from "./integration-row.tsx";

const row = (props: Partial<IntegrationRowProps> = {}) =>
  renderToStaticMarkup(
    <IntegrationRow name="TeslaMate" integrationId="teslamate" status="running" {...props} />,
  );

describe("IntegrationRow", () => {
  test("name with its id in mono, then the meta line", () => {
    const html = row({ entities: 12, since: "since 9:02 am" });
    expect(html).toContain(
      '<div class="ca-introw-name">TeslaMate <code class="ca-mono">teslamate</code></div>',
    );
    expect(html).toContain('<div class="ca-introw-meta">12 entities · since 9:02 am</div>');
  });

  test("the meta line joins only what is given, and zero entities still counts", () => {
    expect(row({ entities: 0 })).toContain('<div class="ca-introw-meta">0 entities</div>');
    expect(row({ since: "since 9:02 am" })).toContain(
      '<div class="ca-introw-meta">since 9:02 am</div>',
    );
    expect(row()).toContain('<div class="ca-introw-meta"></div>');
  });

  test("each status has its badge tone and word", () => {
    for (const [status, tone, word] of [
      ["running", "ok", "Running"],
      ["starting", "pending", "Starting"],
      ["error", "error", "Error"],
    ] as const) {
      expect(row({ status })).toContain(renderToStaticMarkup(<Badge tone={tone}>{word}</Badge>));
    }
  });

  test("stopped is a neutral badge with no icon", () => {
    const html = row({ status: "stopped" });
    expect(html).toContain('<span class="ca-badge ca-badge-neutral">Stopped</span>');
  });

  test("an unknown status reads as stopped", () => {
    // A status from a newer server than this client.
    const html = row({ status: "paused" as IntegrationRowProps["status"] });
    expect(html).toContain(">Stopped</span>");
    expect(html).toContain("ca-badge-neutral");
  });

  test("while in error, the error text replaces the meta line", () => {
    const html = row({ status: "error", error: "Token expired", entities: 3 });
    expect(html).toContain('<div class="ca-introw-error">Token expired</div>');
    expect(html).not.toContain("ca-introw-meta");
    expect(html).not.toContain("3 entities");
  });

  test("the error text is ignored when the status is not error", () => {
    const html = row({ status: "running", error: "Token expired", entities: 3 });
    expect(html).not.toContain("Token expired");
    expect(html).toContain('<div class="ca-introw-meta">3 entities</div>');
  });

  test("error status with no error text keeps the meta line", () => {
    expect(row({ status: "error", entities: 3 })).toContain(
      '<div class="ca-introw-meta">3 entities</div>',
    );
  });

  test("a Reload button only with onReload", () => {
    expect(row()).not.toContain("<button");
    expect(row({ onReload: () => {} })).toContain(
      '<button type="button" class="ca-btn ca-btn-quiet ca-btn-sm">Reload</button>',
    );
  });

  test("className is added", () => {
    expect(row({ className: "x" })).toMatch(/^<div class="ca-introw x">/);
  });
});
