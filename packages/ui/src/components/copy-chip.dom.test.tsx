import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../test-dom.ts";
import { CopyChip } from "./copy-chip.tsx";

const dom = setupDom();

// The stubs go on this file's happy-dom navigator and document, which are thrown away with the
// window after the file, and are removed after each test.
function stub(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard;
  delete (document as unknown as Record<string, unknown>).execCommand;
});

/** Clicks copy and lets the clipboard's promise settle. */
async function copy(el: HTMLElement) {
  await dom.click(el.querySelector(".ca-copy-btn"));
  await dom.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

test("copies the value through the Clipboard API and says Copied", async () => {
  const written: string[] = [];
  stub(navigator, "clipboard", {
    writeText: (text: string) => {
      written.push(text);
      return Promise.resolve();
    },
  });
  const copied: string[] = [];
  const el = await dom.render(
    <CopyChip value="light.kitchen" onCopy={(v) => copied.push(v)}>
      Kitchen
    </CopyChip>,
  );
  const button = el.querySelector(".ca-copy-btn");
  expect(button?.getAttribute("title")).toBe("Copy");
  await copy(el);
  expect(written).toEqual(["light.kitchen"]);
  expect(copied).toEqual(["light.kitchen"]);
  expect(button?.getAttribute("title")).toBe("Copied");
  expect(el.querySelector("[role=status]")?.textContent).toBe("Copied");
});

test("when the Clipboard API refuses, it copies by hand", async () => {
  stub(navigator, "clipboard", { writeText: () => Promise.reject(new Error("insecure")) });
  const commands: string[] = [];
  stub(document, "execCommand", (command: string) => {
    commands.push(command);
    return true;
  });
  const copied: string[] = [];
  const el = await dom.render(<CopyChip value="token" onCopy={(v) => copied.push(v)} />);
  await copy(el);
  expect(commands).toEqual(["copy"]);
  expect(copied).toEqual(["token"]);
  expect(el.querySelector("[role=status]")?.textContent).toBe("Copied");
  // The hidden textarea is gone again.
  expect(document.querySelector("textarea")).toBeNull();
});

test("without a Clipboard API it copies by hand", async () => {
  stub(navigator, "clipboard", undefined);
  stub(document, "execCommand", () => true);
  const copied: string[] = [];
  const el = await dom.render(<CopyChip value="v" onCopy={(v) => copied.push(v)} />);
  await copy(el);
  expect(copied).toEqual(["v"]);
});

test("when nothing can copy, it does not claim to have copied", async () => {
  stub(navigator, "clipboard", undefined);
  stub(document, "execCommand", () => false);
  const copied: string[] = [];
  const el = await dom.render(<CopyChip value="v" onCopy={(v) => copied.push(v)} />);
  await copy(el);
  expect(copied).toEqual([]);
  expect(el.querySelector("[role=status]")?.textContent).toBe("");
  expect(el.querySelector(".ca-copy-btn")?.getAttribute("title")).toBe("Copy");
});
