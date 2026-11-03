// Rebuilds the web app into dist/ whenever its source changes. The server serves dist/ on
// every request, so with `bun run start` in another terminal a reload shows the change, on
// the same origin the session cookie is for.

import { watch } from "node:fs";
import { join } from "node:path";
import { build } from "./build.ts";

let queued: ReturnType<typeof setTimeout> | undefined;
const rebuild = () => {
  clearTimeout(queued);
  queued = setTimeout(async () => {
    const started = performance.now();
    try {
      const result = await build();
      for (const log of result.logs) console.log(log);
      console.log(`web: built in ${Math.round(performance.now() - started)} ms`);
    } catch (err) {
      console.error("web: build failed", err);
    }
  }, 50);
};

for (const dir of ["src", join("..", "ui", "src"), join("..", "client", "src")]) {
  watch(join(import.meta.dir, dir), { recursive: true }, rebuild);
}
rebuild();
