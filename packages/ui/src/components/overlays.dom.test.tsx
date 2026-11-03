import { expect, test } from "bun:test";
import { useState } from "react";
import { setupDom } from "../test-dom.ts";
import { Button } from "./button.tsx";
import { Dialog } from "./dialog.tsx";
import { Menu } from "./menu.tsx";

const dom = setupDom();

function Confirm({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button id="opener" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <Dialog
        open={open}
        tone="danger"
        title="Remove the lamp?"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        actions={
          <>
            <Button id="cancel">Cancel</Button>
            <Button id="remove" variant="danger">
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}

test("a dialog takes focus, keeps Tab inside, closes on Escape, and hands focus back", async () => {
  let closed = 0;
  const el = await dom.render(<Confirm onClose={() => closed++} />);
  const opener = el.querySelector<HTMLElement>("#opener");
  opener?.focus();
  expect(el.querySelector("[role=alertdialog]")).toBeNull();

  await dom.click(opener);
  const dialog = el.querySelector<HTMLElement>("[role=alertdialog]");
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(dialog);
  expect(document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
    "Remove the lamp?",
  );

  await dom.key("Escape", dialog);
  expect(closed).toBe(1);
  expect(el.querySelector("[role=alertdialog]")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("a press on the scrim closes a dialog unless it is not dismissable", async () => {
  let closed = 0;
  const el = await dom.render(
    <>
      <Dialog open title="One" onClose={() => closed++} />
      <Dialog open title="Two" dismissable={false} onClose={() => closed++} />
    </>,
  );
  const [first, second] = [...el.querySelectorAll(".ca-scrim")];
  await dom.act(() => {
    first?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(closed).toBe(1);
  await dom.act(() => {
    second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(closed).toBe(1);
  // A press inside the dialog is not a press on the scrim.
  await dom.act(() => {
    first?.querySelector("h2")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(closed).toBe(1);
});

test("a menu opens on its first item, moves with the arrows, and returns focus on Escape", async () => {
  const picked: string[] = [];
  const el = await dom.render(
    <Menu
      label="Lamp actions"
      items={[
        { label: "Rename", onSelect: () => picked.push("rename") },
        { type: "separator" },
        { label: "Disable", disabled: true },
        { label: "Remove", tone: "danger", onSelect: () => picked.push("remove") },
      ]}
    />,
  );
  const trigger = el.querySelector<HTMLElement>("[aria-haspopup=menu]");
  expect(trigger?.getAttribute("aria-label")).toBe("Lamp actions");
  expect(trigger?.getAttribute("aria-expanded")).toBe("false");

  await dom.click(trigger);
  expect(trigger?.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Rename");

  // The disabled item is skipped; the list wraps.
  await dom.key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Remove");
  await dom.key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Rename");
  await dom.key("End");
  expect(document.activeElement?.textContent).toBe("Remove");

  await dom.key("Escape");
  expect(el.querySelector("[role=menu]")).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await dom.click(trigger);
  await dom.click(el.querySelectorAll("[role=menuitem]")[2]);
  expect(picked).toEqual(["remove"]);
  expect(el.querySelector("[role=menu]")).toBeNull();
});

test("a checked item is a checkbox with a check, in the arrows' path with the rest", async () => {
  const picked: string[] = [];
  const el = await dom.render(
    <Menu
      items={[
        { label: "1 column", checked: false, onSelect: () => picked.push("1") },
        { label: "3 columns", checked: true },
        { type: "separator" },
        { label: "Status chips", checked: true, onSelect: () => picked.push("chips") },
        { label: "Rename" },
      ]}
    />,
  );
  await dom.click(el.querySelector("[aria-haspopup=menu]"));
  const boxes = [...el.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")];
  expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual(["false", "true", "true"]);
  expect(boxes.map((box) => box.querySelector(".ca-pop-check") !== null)).toEqual([
    false,
    true,
    true,
  ]);
  expect(el.querySelectorAll("[role=menuitem]")).toHaveLength(1);

  expect(document.activeElement?.textContent).toBe("1 column");
  await dom.key("ArrowDown");
  await dom.key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Status chips");
  await dom.key("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Rename");

  await dom.click(boxes[2]);
  expect(picked).toEqual(["chips"]);
  expect(el.querySelector("[role=menu]")).toBeNull();
});

test("a press outside closes a menu", async () => {
  const el = await dom.render(<Menu items={[{ label: "Rename" }]} />);
  await dom.click(el.querySelector("[aria-haspopup=menu]"));
  expect(el.querySelector("[role=menu]")).not.toBeNull();
  await dom.act(() => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(el.querySelector("[role=menu]")).toBeNull();
});
