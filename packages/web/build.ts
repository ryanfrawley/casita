// Builds the web app into dist/, which the server serves.

import { rm } from "node:fs/promises";
import { join } from "node:path";

export async function build(outdir = join(import.meta.dir, "dist")): Promise<Bun.BuildOutput> {
  // Hashed names change with every build; old ones would pile up.
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.html")],
    outdir,
    target: "browser",
    minify: true,
    // Without this React ships its development build.
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: "linked",
    naming: { chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    // The app's files are named from the root, so a page at a deeper path (`/devices/x/card`)
    // loads them too.
    publicPath: "/",
  });
  if (result.success) await writeManifest(outdir);
  return result;
}

/**
 * What lets a phone or a wall tablet add Casita to its home screen and open it without the
 * browser's own bars. Written here, with the icon beside it, because their names must not change.
 */
async function writeManifest(outdir: string): Promise<void> {
  const icon = join(import.meta.dir, "..", "ui", "src", "assets", "casita-app-icon.svg");
  await Bun.write(join(outdir, "app-icon.svg"), Bun.file(icon));
  await Bun.write(
    join(outdir, "manifest.webmanifest"),
    JSON.stringify({
      name: "Casita",
      short_name: "Casita",
      start_url: "/",
      display: "standalone",
      background_color: "#f6f1ea",
      theme_color: "#f6f1ea",
      icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
    }),
  );
  // The bundler would try to resolve the link as a file of its own, so it is added afterwards.
  const index = join(outdir, "index.html");
  const html = await Bun.file(index).text();
  await Bun.write(
    index,
    html.replace("</head>", '<link rel="manifest" href="/manifest.webmanifest" /></head>'),
  );
}

if (import.meta.main) {
  const result = await build();
  for (const output of result.outputs) console.log(output.path);
}
