import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../icon.tsx";
import { pushToast, Toast, type ToastItem, ToastRegion, toastDuration } from "./toast.tsx";

const t = (id: string, message = id): ToastItem => ({ id, message });

describe("pushToast", () => {
  test("appends a new toast", () => {
    expect(pushToast([t("a")], t("b"))).toEqual([t("a"), t("b")]);
  });

  test("a toast with an existing id replaces it in place", () => {
    const list = [t("a"), t("b"), t("c")];
    const next = pushToast(list, { id: "b", message: "Saved", tone: "ok" });
    expect(next.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(next[1]).toEqual({ id: "b", message: "Saved", tone: "ok" });
  });

  test("past max the oldest fall off; max defaults to 3", () => {
    const list = [t("a"), t("b"), t("c")];
    expect(pushToast(list, t("d")).map((x) => x.id)).toEqual(["b", "c", "d"]);
    expect(pushToast(list, t("d"), 2).map((x) => x.id)).toEqual(["c", "d"]);
    expect(pushToast([], t("a"), 1)).toEqual([t("a")]);
  });

  test("replacing does not push anything off", () => {
    const list = [t("a"), t("b"), t("c")];
    expect(pushToast(list, t("a", "again")).map((x) => x.message)).toEqual(["again", "b", "c"]);
  });

  test("leaves the given list alone", () => {
    const list = [t("a"), t("b")];
    pushToast(list, t("a", "changed"));
    pushToast(list, t("c"));
    expect(list).toEqual([t("a"), t("b")]);
  });
});

describe("toastDuration", () => {
  test("errors and pending toasts stay until dismissed or replaced", () => {
    expect(toastDuration({ tone: "error" })).toBe(0);
    expect(toastDuration({ tone: "pending" })).toBe(0);
    expect(toastDuration({ tone: "error" }, 1000)).toBe(0);
  });

  test("others stay four seconds, or the given fallback", () => {
    expect(toastDuration({})).toBe(4000);
    expect(toastDuration({ tone: "ok" })).toBe(4000);
    expect(toastDuration({ tone: "neutral" }, 1500)).toBe(1500);
  });

  test("an explicit duration wins, including 0", () => {
    expect(toastDuration({ tone: "error", duration: 2000 })).toBe(2000);
    expect(toastDuration({ tone: "ok", duration: 0 })).toBe(0);
  });
});

describe("Toast markup", () => {
  const icon = (name: string, spin = false) =>
    renderToStaticMarkup(<Icon name={name} size={18} spin={spin} className="ca-toast-icon" />);

  test("neutral is a status with the info icon", () => {
    const html = renderToStaticMarkup(<Toast message="Saved" />);
    expect(html).toStartWith('<div class="ca-toast ca-toast-neutral" role="status">');
    expect(html).toContain(icon("info"));
    expect(html).toContain('<div class="ca-toast-text"><span>Saved</span></div>');
  });

  test("an error is an alert with the warning icon", () => {
    const html = renderToStaticMarkup(<Toast tone="error" message="Couldn't reload" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(icon("triangle-alert"));
  });

  test("ok uses the check circle", () => {
    expect(renderToStaticMarkup(<Toast tone="ok" message="Done" />)).toContain(
      icon("circle-check"),
    );
  });

  test("pending spins the loader, unless a custom icon is given", () => {
    expect(renderToStaticMarkup(<Toast tone="pending" message="Saving" />)).toContain(
      icon("loader-circle", true),
    );
    const custom = renderToStaticMarkup(<Toast tone="pending" icon="lock" message="Locking" />);
    expect(custom).toContain(icon("lock"));
    expect(custom).not.toContain("ca-spin");
  });

  test("only pending spins", () => {
    for (const tone of ["neutral", "ok", "error"] as const) {
      expect(renderToStaticMarkup(<Toast tone={tone} message="x" />)).not.toContain("ca-spin");
    }
  });

  test("a title comes before the message; the message beats children", () => {
    const html = renderToStaticMarkup(
      <Toast title="Guests" message="Set to Read">
        ignored
      </Toast>,
    );
    expect(html).toContain("<strong>Guests</strong><span>Set to Read</span>");
    expect(html).not.toContain("ignored");
    expect(renderToStaticMarkup(<Toast>From children</Toast>)).toContain(
      "<span>From children</span>",
    );
  });

  test("an action is a small quiet button; onDismiss adds a Dismiss button", () => {
    const html = renderToStaticMarkup(
      <Toast message="Removed" action={{ label: "Undo" }} onDismiss={() => {}} />,
    );
    expect(html).toContain(
      '<button type="button" class="ca-btn ca-btn-quiet ca-btn-sm">Undo</button>',
    );
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain("ca-iconbtn-sm");
  });

  test("no action and no onDismiss means no buttons", () => {
    expect(renderToStaticMarkup(<Toast message="x" />)).not.toContain("<button");
  });
});

describe("ToastRegion markup", () => {
  test("a polite live region at the bottom end by default", () => {
    const html = renderToStaticMarkup(<ToastRegion toasts={[]} />);
    expect(html).toBe('<div class="ca-toasts ca-toasts-bottom-end" aria-live="polite"></div>');
  });

  test("placement, contained and className add classes", () => {
    const html = renderToStaticMarkup(
      <ToastRegion toasts={[]} placement="top-end" contained className="x" />,
    );
    expect(html).toContain('class="ca-toasts ca-toasts-top-end ca-contained x"');
  });

  test("draws each toast in order, without leaking ids or durations into the markup", () => {
    const html = renderToStaticMarkup(
      <ToastRegion
        toasts={[
          { id: "one", message: "First", duration: 100 },
          { id: "two", message: "Second", tone: "error" },
        ]}
      />,
    );
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html.match(/class="ca-toast /g)).toHaveLength(2);
    expect(html).not.toContain("duration");
    expect(html).not.toContain('id="one"');
    expect(html).not.toContain("Dismiss");
  });

  test("the region's onDismiss gives every toast a Dismiss button", () => {
    const html = renderToStaticMarkup(
      <ToastRegion toasts={[t("a"), t("b")]} onDismiss={() => {}} />,
    );
    expect(html.match(/aria-label="Dismiss"/g)).toHaveLength(2);
  });

  test("without the region's onDismiss, a toast's own onDismiss still shows", () => {
    const html = renderToStaticMarkup(
      <ToastRegion toasts={[{ ...t("a"), onDismiss: () => {} }, t("b")]} />,
    );
    expect(html.match(/aria-label="Dismiss"/g)).toHaveLength(1);
  });
});
