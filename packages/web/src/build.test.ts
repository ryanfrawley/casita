import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../build.ts";

test("the app builds for the browser", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "casita-web-"));
  try {
    const result = await build(outdir);
    expect(result.success).toBe(true);
    const html = await Bun.file(join(outdir, "index.html")).text();
    // Named from the root, so a page at a deeper path (`/devices/x/card`) loads them too.
    expect(html).toMatch(/<script[^>]+src="\/[^"/]+\.js"/);
    expect(html).toMatch(/<link[^>]+href="\/[^"/]+\.css"/);
    const script = result.outputs.find(
      (output) => output.kind === "entry-point" && output.path.endsWith(".js"),
    );
    const code = (await script?.text()) ?? "";
    expect(code.length).toBeGreaterThan(0);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const manifest = await Bun.file(join(outdir, "manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "Casita", display: "standalone", start_url: "/" });
    expect(await Bun.file(join(outdir, "app-icon.svg")).exists()).toBe(true);
    const css = result.outputs.find((output) => output.path.endsWith(".css"));
    // Fonts are files, so a browser fetches only the subsets a page uses.
    expect(await css?.text()).not.toContain("data:font");
    expect(result.outputs.filter((output) => output.path.endsWith(".woff2"))).toHaveLength(6);
    // The server's own modules must never reach the bundle.
    expect(code).not.toMatch(/bun:sqlite|node:fs/);
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
