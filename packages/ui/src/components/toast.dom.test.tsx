import { expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { ToastRegion, useToasts } from "./toast.tsx";

const dom = setupDom();

type Api = ReturnType<typeof useToasts>;

/** Renders a region driven by useToasts and hands back the hook's API. */
async function host(options?: { duration?: number; max?: number }) {
  const ref: { api?: Api } = {};
  function Host() {
    const api = useToasts(options);
    ref.api = api;
    return <ToastRegion toasts={api.toasts} onDismiss={api.dismiss} />;
  }
  const el = await dom.render(<Host />);
  const api = () => {
    if (!ref.api) throw new Error("not rendered");
    return ref.api;
  };
  const messages = () => [...el.querySelectorAll(".ca-toast-text span")].map((s) => s.textContent);
  const push = async (toast: Parameters<Api["push"]>[0]) => {
    let id = "";
    await dom.act(() => {
      id = api().push(toast);
    });
    return id;
  };
  return { el, api, messages, push };
}

const wait = (ms: number) => dom.act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("push adds a toast and returns a fresh id each time", async () => {
  const { messages, push } = await host();
  const a = await push({ message: "One", duration: 0 });
  const b = await push({ message: "Two", duration: 0 });
  expect(a).not.toBe(b);
  expect(messages()).toEqual(["One", "Two"]);
});

test("pushing the same id replaces that toast in place", async () => {
  const { el, messages, push } = await host();
  await push({ id: "save", message: "Saving…", tone: "pending" });
  await push({ id: "other", message: "Other", duration: 0 });
  expect(el.querySelector(".ca-toast-pending")).not.toBeNull();
  const id = await push({ id: "save", message: "Saved", tone: "ok", duration: 0 });
  expect(id).toBe("save");
  expect(messages()).toEqual(["Saved", "Other"]);
  expect(el.querySelector(".ca-toast-pending")).toBeNull();
});

test("past max the oldest toast leaves", async () => {
  const { messages, push } = await host({ max: 2 });
  for (const message of ["One", "Two", "Three"]) await push({ message, duration: 0 });
  expect(messages()).toEqual(["Two", "Three"]);
});

test("a toast leaves after its duration", async () => {
  const { messages, push } = await host();
  await push({ message: "Brief", duration: 20 });
  await push({ message: "Stays", duration: 0 });
  expect(messages()).toEqual(["Brief", "Stays"]);
  await wait(60);
  expect(messages()).toEqual(["Stays"]);
});

test("the hook's duration applies to ordinary toasts, not to errors or pending ones", async () => {
  const { messages, push } = await host({ duration: 20 });
  await push({ message: "Saved", tone: "ok" });
  await push({ message: "Failed", tone: "error" });
  await push({ message: "Working", tone: "pending" });
  await wait(60);
  expect(messages()).toEqual(["Failed", "Working"]);
});

test("replacing a timed toast with one that stays cancels the old timer", async () => {
  const { messages, push } = await host();
  await push({ id: "x", message: "Timed", duration: 20 });
  await push({ id: "x", message: "Pending", tone: "pending" });
  await wait(60);
  expect(messages()).toEqual(["Pending"]);
});

test("dismiss, and the Dismiss button, remove a toast", async () => {
  const { el, api, messages, push } = await host();
  const a = await push({ message: "One", duration: 0 });
  await push({ message: "Two", duration: 0 });
  await dom.act(() => api().dismiss(a));
  expect(messages()).toEqual(["Two"]);
  await dom.click(el.querySelector("[aria-label=Dismiss]"));
  expect(messages()).toEqual([]);
});
