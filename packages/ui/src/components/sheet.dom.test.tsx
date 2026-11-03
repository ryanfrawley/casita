import { expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { Button } from "./button.tsx";
import { Sheet } from "./sheet.tsx";

const dom = setupDom();

function Detail({ modal, onClose }: { modal?: boolean; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="opener" onClick={() => setOpen(true)}>
        Open
      </Button>
      <Sheet
        open={open}
        modal={modal}
        title="Kitchen lamp"
        subtitle="light.kitchen"
        closeLabel="Close details"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        footer={<Button className="save">Save</Button>}
      >
        <input className="name" />
      </Sheet>
    </>
  );
}

async function openSheet(modal: boolean) {
  let closed = 0;
  const el = await dom.render(<Detail modal={modal} onClose={() => closed++} />);
  const opener = el.querySelector<HTMLElement>(".opener");
  opener?.focus();
  await dom.click(opener);
  const sheet = el.querySelector<HTMLElement>("[role=dialog]");
  return { el, opener, sheet, closes: () => closed };
}

/** Sends Tab and says whether the sheet kept it (prevented the browser's own move). */
async function tab(target: Element | null, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await dom.act(() => {
    target?.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

test("a sheet is titled, takes focus when it opens, and is closed by its close button", async () => {
  const { el, opener, sheet, closes } = await openSheet(false);
  expect(sheet?.tagName).toBe("ASIDE");
  expect(document.activeElement).toBe(sheet);
  const title = document.getElementById(sheet?.getAttribute("aria-labelledby") ?? "");
  expect(title?.textContent).toBe("Kitchen lamp");
  expect(sheet?.querySelector(".ca-sheet-sub")?.textContent).toBe("light.kitchen");

  await dom.click(el.querySelector("[aria-label='Close details']"));
  expect(closes()).toBe(1);
  expect(el.querySelector("[role=dialog]")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("a modal sheet has a scrim, is aria-modal, and keeps Tab inside", async () => {
  const { el, sheet } = await openSheet(true);
  expect(sheet?.getAttribute("aria-modal")).toBe("true");
  const scrim = el.querySelector(".ca-scrim.ca-scrim-sheet");
  expect(scrim).not.toBeNull();
  expect(scrim?.firstElementChild).toBe(sheet);

  const close = el.querySelector<HTMLElement>("[aria-label='Close details']");
  const save = el.querySelector<HTMLElement>(".save");
  // From the last control, Tab wraps to the first.
  save?.focus();
  expect(await tab(save)).toBe(true);
  expect(document.activeElement).toBe(close);
  // From the first control, or the sheet itself, Shift+Tab wraps to the last.
  expect(await tab(close, true)).toBe(true);
  expect(document.activeElement).toBe(save);
  sheet?.focus();
  expect(await tab(sheet, true)).toBe(true);
  expect(document.activeElement).toBe(save);
  // In between, Tab is the browser's.
  const name = el.querySelector<HTMLElement>(".name");
  name?.focus();
  expect(await tab(name)).toBe(false);
});

test("a press on a modal sheet's scrim closes it; a press inside does not", async () => {
  const { el, closes } = await openSheet(true);
  await dom.act(() => {
    el.querySelector(".ca-sheet-body")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
  });
  expect(closes()).toBe(0);
  await dom.act(() => {
    el.querySelector(".ca-scrim")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(closes()).toBe(1);
  expect(el.querySelector("[role=dialog]")).toBeNull();
});

test("a non-modal sheet has no scrim and leaves Tab alone", async () => {
  const { el, sheet } = await openSheet(false);
  expect(sheet?.hasAttribute("aria-modal")).toBe(false);
  expect(el.querySelector(".ca-scrim")).toBeNull();
  const save = el.querySelector<HTMLElement>(".save");
  save?.focus();
  expect(await tab(save)).toBe(false);
  expect(document.activeElement).toBe(save);
});

test("Escape closes a sheet, modal or not", async () => {
  for (const modal of [false, true]) {
    const { el, sheet, opener, closes } = await openSheet(modal);
    await dom.key("Escape", sheet);
    expect(closes()).toBe(1);
    expect(el.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  }
});

test("Escape closes a sheet from anywhere on the page, and a key already used is left alone", async () => {
  const { el, opener, closes } = await openSheet(false);
  // A sheet that is not modal leaves the page usable; focus wandered off it.
  opener?.focus();
  expect(document.activeElement).toBe(opener);
  const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  used.preventDefault();
  await dom.act(() => {
    opener?.dispatchEvent(used);
  });
  expect(closes()).toBe(0);
  await dom.key("Escape", opener);
  expect(closes()).toBe(1);
  expect(el.querySelector("[role=dialog]")).toBeNull();
});

test("with a sheet over another, Escape closes the one on top, then the one under it", async () => {
  const closed: string[] = [];
  function Two() {
    const [device, setDevice] = useState(true);
    const [entity, setEntity] = useState(true);
    return (
      <>
        <Sheet
          open={device}
          title="Lamp"
          onClose={() => {
            closed.push("device");
            setDevice(false);
          }}
        />
        <Sheet
          open={entity}
          title="Lamp power"
          onClose={() => {
            closed.push("entity");
            setEntity(false);
          }}
        />
      </>
    );
  }
  const el = await dom.render(<Two />);
  expect(el.querySelectorAll("[role=dialog]").length).toBe(2);
  await dom.key("Escape", document.body);
  expect(closed).toEqual(["entity"]);
  expect(el.querySelectorAll("[role=dialog]").length).toBe(1);
  await dom.key("Escape", document.body);
  expect(closed).toEqual(["entity", "device"]);
  expect(el.querySelector("[role=dialog]")).toBeNull();
});

test("a closed sheet renders nothing", async () => {
  const el = await dom.render(<Sheet open={false} title="x" />);
  expect(el.innerHTML).toBe("");
});
