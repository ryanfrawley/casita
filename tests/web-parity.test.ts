// The web app mirrors the CLI: every request the API takes is sent from somewhere in it.
// The CLI's README states the same rule for subcommands.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { requestSchema } from "../packages/api/src/schema.ts";

/** Requests the web app has no use for, and why. Anything else must be sent. */
const NOT_NEEDED: Record<string, string> = {
  unsubscribe: "one subscription lasts as long as the tab does",
  list_pages: "v1 has one page, Home, and the editor opens it by id",
  check_automation:
    "the browser compiles an automation with the same house the server has, so a save is the only check it needs; the CLI uses it",
  check_sensor: "as check_automation: the browser compiles a sensor itself; the CLI uses it",
};

const types = requestSchema.options.map((option) => option.shape.type.value);

async function sentByWeb(): Promise<Set<string>> {
  const root = join(import.meta.dir, "..", "packages", "web", "src");
  const sent = new Set<string>();
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (/\.test\.tsx?$/.test(path)) continue;
    const source = await Bun.file(join(root, path)).text();
    for (const match of source.matchAll(/\brequest\(\s*"([a-z_]+)"/g)) sent.add(match[1] ?? "");
  }
  return sent;
}

test("the schema lists the requests this test thinks it does", () => {
  expect(types.length).toBeGreaterThanOrEqual(40);
  expect(types).toContain("send_command");
});

test("every request type is sent somewhere in the web app, or is listed with a reason", async () => {
  const sent = await sentByWeb();
  const missing = types.filter((type) => !sent.has(type) && !(type in NOT_NEEDED));
  expect(missing).toEqual([]);
});

test("the exceptions are real requests that really are unused", async () => {
  const sent = await sentByWeb();
  for (const type of Object.keys(NOT_NEEDED)) {
    expect(types).toContain(type as (typeof types)[number]);
    expect(sent.has(type)).toBe(false);
  }
});
