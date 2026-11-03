import { expect, test } from "bun:test";
import { cameraProblem } from "./scan.ts";

const named = (name: string) => Object.assign(new Error(name), { name });

test("cameraProblem names the cause the browser gave, and falls back to a plain sentence", () => {
  expect(cameraProblem(named("NotAllowedError"))).toBe(
    "The browser was not allowed to use the camera.",
  );
  expect(cameraProblem(named("SecurityError"))).toBe(
    "The browser was not allowed to use the camera.",
  );
  expect(cameraProblem(named("NotFoundError"))).toBe("No camera was found.");
  expect(cameraProblem(named("OverconstrainedError"))).toBe("No camera was found.");
  expect(cameraProblem(named("NotReadableError"))).toBe("The camera is in use by another app.");
  expect(cameraProblem(named("AbortError"))).toBe("The camera could not be opened.");
  expect(cameraProblem("nope")).toBe("The camera could not be opened.");
});
