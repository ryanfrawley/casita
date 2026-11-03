import { describe, expect, test } from "bun:test";
import { failure } from "./context.tsx";

describe("failure", () => {
  test("says nothing for a confirmed command", () => {
    expect(failure("Desk lamp", { ok: true, confirmed: true })).toBeUndefined();
  });

  test("says the device didn't confirm when the command was sent but not confirmed", () => {
    expect(failure("Desk lamp", { ok: true, confirmed: false })).toEqual({
      title: "Desk lamp didn't confirm",
      message: "The command was sent, but the device hasn't reported the change.",
    });
  });

  test("passes a refusal's message through verbatim", () => {
    const message = "You can view Front door but not change it.";
    expect(failure("Front door", { ok: false, code: "forbidden", message })).toEqual({
      title: "Couldn't change Front door",
      message,
    });
  });

  test("keeps the server's message even when it is empty or odd", () => {
    const odd = "  Line one\nline two <b>  ";
    expect(failure("Fan", { ok: false, code: "internal", message: odd })?.message).toBe(odd);
    expect(failure("Fan", { ok: false, code: "timeout", message: "" })).toEqual({
      title: "Couldn't change Fan",
      message: "",
    });
  });
});
