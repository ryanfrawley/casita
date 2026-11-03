import { dirname, join, relative, resolve, sep } from "node:path";

/** Workspace packages an integration may import, besides its own dependencies. */
const ALLOWED_INTERNAL = new Set([
  "@casita/core/types",
  "@casita/mqtt-shared",
  "@casita/mqtt-shared/testing",
  "@casita/integration-testing",
]);
const CORE_SRC = join("packages", "core", "src");
const CORE_TYPES = join(CORE_SRC, "types");

export interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

/**
 * Checks one import specifier found in `file` (a repo-relative path under integrations/).
 * Returns the reason it breaks the boundary, or null when it is allowed.
 */
export function checkImport(file: string, specifier: string): string | null {
  if (specifier.startsWith("@casita/")) {
    return ALLOWED_INTERNAL.has(specifier)
      ? null
      : "integrations may import only @casita/core/types from the core";
  }
  if (!specifier.startsWith(".")) return null;

  const target = relative(".", resolve(dirname(file), specifier)).replace(/\.(ts|js)$/, "");
  if (target === CORE_TYPES) return null;
  if (target.startsWith(`packages${sep}`)) {
    return target.startsWith(CORE_SRC)
      ? "integrations may import only types.ts from packages/core/src"
      : "integrations must not import from packages/";
  }
  return null;
}

export async function scanIntegrations(root: string): Promise<Violation[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const violations: Violation[] = [];
  const glob = new Bun.Glob("integrations/**/*.ts");
  for await (const file of glob.scan({ cwd: root })) {
    if (file.includes("node_modules")) continue;
    const source = await Bun.file(join(root, file)).text();
    for (const { path } of transpiler.scanImports(source)) {
      const reason = checkImport(file, path);
      if (reason) violations.push({ file, specifier: path, reason });
    }
  }
  return violations;
}

// ───────── packages that run in a browser ─────────

/** The packages that end up in a browser, and the workspace packages each may import. */
export const BROWSER_PACKAGES: Record<string, readonly string[]> = {
  "packages/client": ["@casita/api/schema"],
  "packages/ui": [],
  // The DOM harness is for tests; main.tsx's bundle is checked below for anything it drags in.
  "packages/web": [
    "@casita/api/schema",
    "@casita/client",
    "@casita/ui",
    "@casita/ui/test-dom",
    // The page language's compiler and evaluator, which import nothing of Bun or Node.
    "@casita/core/casa",
  ],
};

/** Checks one import specifier found in `file`, a repo-relative path under a browser package. */
export function checkBrowserImport(file: string, specifier: string): string | null {
  const home = Object.keys(BROWSER_PACKAGES).find((dir) => file.startsWith(`${dir}/`));
  if (!home) return null;
  if (specifier.startsWith("@casita/")) {
    const allowed = BROWSER_PACKAGES[home] ?? [];
    // A package that may be imported may also be asked for its stylesheet and images.
    const owner = specifier.split("/").slice(0, 2).join("/");
    return allowed.includes(specifier) ||
      (/\.(css|svg)$/.test(specifier) && allowed.includes(owner))
      ? null
      : `${home} may import only ${allowed.join(", ") || "no workspace package"}`;
  }
  if (!specifier.startsWith(".")) return null;
  const target = relative(".", resolve(dirname(file), specifier));
  return target.startsWith(`${home}${sep}`) ? null : `${home} must not reach outside itself`;
}

const SOURCE = /\.tsx?$/;
const scan = (file: string, source: string) =>
  new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" }).scanImports(source);

export async function scanBrowserPackages(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const dir of Object.keys(BROWSER_PACKAGES)) {
    for await (const path of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scan({ cwd: root })) {
      if (path.includes("node_modules")) continue;
      const source = await Bun.file(join(root, path)).text();
      for (const { path: specifier } of scan(path, source)) {
        const reason = checkBrowserImport(path, specifier);
        if (reason) violations.push({ file: path, specifier, reason });
      }
    }
  }
  return violations;
}

/**
 * Every package from outside the workspace that `entry` pulls in, following relative imports
 * and workspace packages through their `exports`. What comes back is what a bundler would
 * have to put in the browser, so a `bun:` or `node:` name here means the bundle is broken.
 */
export async function externalImports(root: string, entry: string): Promise<string[]> {
  const packages = new Map<string, { dir: string; exports: Record<string, string> }>();
  for await (const path of new Bun.Glob("{packages,integrations}/*/package.json").scan({
    cwd: root,
  })) {
    const manifest = await Bun.file(join(root, path)).json();
    packages.set(manifest.name, { dir: dirname(path), exports: manifest.exports ?? {} });
  }

  const external = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { path: specifier } of scan(file, await Bun.file(join(root, file)).text())) {
      if (specifier.startsWith(".")) {
        const target = join(dirname(file), specifier);
        // Stylesheets, fonts and images are leaves.
        if (SOURCE.test(target)) queue.push(target);
        continue;
      }
      // A workspace package's stylesheet or image, likewise.
      if (specifier.startsWith("@casita/") && !SOURCE.test(specifier) && /\.\w+$/.test(specifier))
        continue;
      const [scope, name, ...rest] = specifier.split("/");
      const workspace = packages.get(`${scope}/${name}`);
      if (!workspace) {
        external.add(specifier);
        continue;
      }
      const target = workspace.exports[rest.length ? `./${rest.join("/")}` : "."];
      if (!target) throw new Error(`${specifier} is not exported (imported by ${file})`);
      queue.push(join(workspace.dir, target));
    }
  }
  return [...external].sort();
}
