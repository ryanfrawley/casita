import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkBrowserImport,
  checkImport,
  externalImports,
  scanBrowserPackages,
  scanIntegrations,
} from "./boundaries.ts";

const file = "integrations/mqtt/src/index.ts";
const root = join(import.meta.dir, "..");

test.each([
  ["@casita/core/types", true],
  ["@casita/mqtt-shared", true],
  ["mqtt", true],
  ["zod", true],
  ["./discovery.ts", true],
  ["../../mqtt-shared/src/index.ts", true],
  ["../../../packages/core/src/types.ts", true],
  ["../../../packages/core/src/types", true],
  ["@casita/core", false],
  ["@casita/core/router", false],
  ["@casita/api", false],
  ["../../../packages/core/src/router.ts", false],
  ["../../../packages/core/src/db/sqlite.ts", false],
  ["../../../packages/api/src/schema.ts", false],
])("import %p allowed: %p", (specifier, allowed) => {
  expect(checkImport(file, specifier) === null).toBe(allowed);
});

test("no integration imports core internals", async () => {
  const violations = await scanIntegrations(join(import.meta.dir, ".."));
  expect(violations).toEqual([]);
});

test.each([
  ["packages/client/src/client.ts", "@casita/api/schema", true],
  ["packages/client/src/client.ts", "./units.ts", true],
  ["packages/client/src/client.ts", "@casita/api", false],
  ["packages/client/src/client.ts", "@casita/core/types", false],
  ["packages/client/src/client.ts", "../../cli/src/style.ts", false],
  ["packages/ui/src/button.tsx", "react", true],
  ["packages/ui/src/button.tsx", "./icon.tsx", true],
  ["packages/ui/src/button.tsx", "@casita/client", false],
  ["packages/ui/src/button.tsx", "@casita/api/schema", false],
  ["packages/web/src/app.tsx", "@casita/ui", true],
  ["packages/web/src/app.tsx", "@casita/client", true],
  ["packages/web/src/app.tsx", "@casita/api/schema", true],
  ["packages/web/src/app.tsx", "@casita/ui/styles.css", true],
  ["packages/web/src/app.tsx", "@casita/ui/assets/casita-mark.svg", true],
  ["packages/web/src/shell.dom.test.tsx", "@casita/ui/test-dom", true],
  ["packages/web/src/shell.dom.test.tsx", "../../ui/src/test-dom.ts", false],
  ["packages/web/src/app.tsx", "@casita/api/server.css", false],
  ["packages/web/src/app.tsx", "@casita/core", false],
  ["packages/web/src/app.tsx", "@casita/api", false],
  ["packages/web/src/app.tsx", "../../api/src/server.ts", false],
  ["packages/cli/src/main.ts", "@casita/api", true],
])("in %p, import %p allowed: %p", (path, specifier, allowed) => {
  expect(checkBrowserImport(path, specifier) === null).toBe(allowed);
});

test("no browser package imports outside its allowance", async () => {
  expect(await scanBrowserPackages(root)).toEqual([]);
});

test("the wire schema pulls in nothing but zod", async () => {
  expect(await externalImports(root, "packages/api/src/schema.ts")).toEqual(["zod"]);
});

test("the web app pulls in nothing that needs Bun or Node", async () => {
  const allowed = [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-dev-runtime",
    "react/jsx-runtime",
    "jsqr",
    "zod",
    // The Casa editor.
    "@codemirror/autocomplete",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/highlight",
  ];
  const external = await externalImports(root, "packages/web/src/main.tsx");
  expect(external.filter((name) => !allowed.includes(name))).toEqual([]);
});
