import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { setupDom } from "@casita/ui/test-dom";
import { CasaStore } from "./casa/host.ts";
import { AppProvider } from "./context.tsx";
import { Settings } from "./pages/settings.tsx";
import { type Page, Shell } from "./shell.tsx";
import { EMPTY, type House, type Store } from "./store.ts";
import type { ThemeInfo } from "./theme.ts";

const dom = setupDom();

// The theme asks the system for dark mode and the browser for the remembered choice; the DOM
// harness puts up neither `matchMedia` nor `localStorage`.
const scope = globalThis as unknown as Record<string, unknown>;
let savedMatchMedia: unknown;
let savedStorage: unknown;
const remembered = new Map<string, string>();
beforeAll(() => {
  savedMatchMedia = scope.matchMedia;
  savedStorage = scope.localStorage;
  scope.matchMedia = () => ({ matches: false });
  scope.localStorage = {
    getItem: (key: string) => remembered.get(key) ?? null,
    setItem: (key: string, value: string) => remembered.set(key, value),
    removeItem: (key: string) => remembered.delete(key),
  };
});
afterAll(() => {
  scope.matchMedia = savedMatchMedia;
  scope.localStorage = savedStorage;
});

/** Only what the Shell, the card menu and Settings read: the house, held still. */
const stubStore = (me?: Row): Store => {
  const house: House = { ...EMPTY, phase: "ready", me };
  return {
    getState: () => house,
    subscribe: () => () => {},
    logout: async () => {},
    // Settings asks the server about itself; it shrugs off a refusal, so nothing answers.
    request: () => Promise.reject(new Error("no server in this test")),
  } as unknown as Store;
};

const page = (path: string, label: string, extra: Partial<Page> = {}): Page => ({
  path,
  label,
  icon: "house",
  render: () => <p className="shown">{label}</p>,
  ...extra,
});

const PAGES: Page[] = [
  page("/", "Home"),
  page("/devices", "Devices"),
  page("/devices/:id/card", "Customize card", {
    hidden: true,
    nav: "/",
    render: (params) => <p className="shown">card for {params.id}</p>,
  }),
];

async function renderShell(
  path: string,
  options: { pages?: Page[]; me?: Row; themes?: ThemeInfo[] } = {},
) {
  const went: string[] = [];
  const store = stubStore(options.me);
  const el = await dom.render(
    <AppProvider
      store={store}
      toast={() => ""}
      casa={new CasaStore(store, { tick: false })}
      themes={options.themes ?? []}
    >
      <Shell pages={options.pages ?? PAGES} path={path} onNavigate={(to) => went.push(to)} />
    </AppProvider>,
  );
  return { el, went };
}

const navLabels = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-nav-item")].map((item) => item.textContent);
const current = (el: HTMLElement) => el.querySelector("[aria-current=page]")?.textContent;
const shown = (el: HTMLElement) => el.querySelector(".shown")?.textContent;

test("a hidden page is left out of the navigation", async () => {
  const { el } = await renderShell("/devices");
  expect(navLabels(el)).toEqual(["Home", "Devices"]);
  expect(current(el)).toBe("Devices");
  expect(shown(el)).toBe("Devices");
});

test("a hidden page lights its nav item and gets the parts of its path", async () => {
  const { el } = await renderShell("/devices/dev%2012/card");
  expect(shown(el)).toBe("card for dev 12");
  expect(current(el)).toBe("Home");
  expect(document.title).toBe("Customize card · Casita");
});

test("an unknown path shows the first page", async () => {
  const { el } = await renderShell("/nowhere");
  expect(shown(el)).toBe("Home");
  expect(current(el)).toBe("Home");
});

const themeInfo = (id: string, name: string, extra: Partial<ThemeInfo> = {}): ThemeInfo => ({
  id,
  name,
  css: "",
  dark: true,
  builtin: true,
  isLightDefault: false,
  isDarkDefault: false,
  breakpoints: { tablet: 860, desktop: 1100 },
  values: {},
  ...extra,
});
const THEMES = [
  themeInfo("day", "Day", { dark: false, isLightDefault: true }),
  themeInfo("night", "Night", { isDarkDefault: true }),
  themeInfo("october", "October", { extends: "Night" }),
  themeInfo("spookier", "Spookier", { extends: "October", builtin: false }),
];

/** Renders the shell with a remembered theme choice, and forgets it again. */
async function renderThemed(choice: string) {
  localStorage.setItem("casita.theme", choice);
  try {
    return await renderShell("/", { themes: THEMES });
  } finally {
    localStorage.removeItem("casita.theme");
    delete document.documentElement.dataset.theme;
  }
}

test("the mark is drawn in the theme's colours, without a moon", async () => {
  const { el } = await renderThemed("night");
  const mark = el.querySelector(".app-brand-mark") as SVGElement;
  expect(mark.getAttribute("viewBox")).toBe("0 0 64 64");
  expect([...mark.querySelectorAll("path")].map((p) => p.getAttribute("fill"))).toEqual([
    "var(--terracotta)",
    "var(--lamp)",
  ]);
  expect(el.querySelector(".app-shell-october")).toBeNull();
});

test("in October a moon rises by the roof and moonlight falls on the page", async () => {
  const { el } = await renderThemed("october");
  const mark = el.querySelector(".app-brand-mark") as SVGElement;
  expect(mark.getAttribute("viewBox")).toBe("0 0 72 64");
  expect(mark.querySelectorAll("path")).toHaveLength(3);
  expect(el.querySelector(".app-shell-october")).not.toBeNull();
});

test("a theme that extends October keeps the moon", async () => {
  const { el } = await renderThemed("spookier");
  expect(el.querySelector(".app-brand-mark path:nth-of-type(3)")).not.toBeNull();
});

// The theme is a choice of this browser's, so it is offered on Settings to every role rather
// than squeezed into the navigation.

const SETTINGS: Page[] = [
  page("/", "Home"),
  { path: "/settings", label: "Settings", icon: "settings", render: () => <Settings /> },
];
const MEMBER = { username: "ana", role: "member" };

const themeControl = (el: Element) =>
  el.querySelector('[role=radiogroup][aria-label="Theme"]') as HTMLElement | null;
const option = (el: Element, label: string) =>
  [...(themeControl(el)?.querySelectorAll("[role=radio]") ?? [])].find(
    (radio) => radio.textContent === label,
  );

test("the navigation has no theme control", async () => {
  const { el } = await renderShell("/settings", { pages: SETTINGS, me: MEMBER, themes: THEMES });
  const nav = el.querySelector(".app-nav") as HTMLElement;
  expect(nav).not.toBeNull();
  expect(nav.querySelector("[role=radiogroup]")).toBeNull();
  expect(nav.textContent).not.toContain("Auto");
  // The page beside it has one, so the control moved rather than vanished.
  expect(themeControl(el.querySelector("main") as HTMLElement)).not.toBeNull();
});

describe("Settings offers the theme", () => {
  afterEach(() => {
    localStorage.removeItem("casita.theme");
    delete document.documentElement.dataset.theme;
  });

  test("to a member, with Auto and each of the house's themes", async () => {
    const { el } = await renderShell("/settings", { pages: SETTINGS, me: MEMBER, themes: THEMES });
    const radios = [...(themeControl(el)?.querySelectorAll("[role=radio]") ?? [])];
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Auto",
      "Day",
      "Night",
      "October",
      "Spookier",
    ]);
    // Nothing remembered yet, so Auto is the one chosen.
    expect(option(el, "Auto")?.getAttribute("aria-checked")).toBe("true");
  });

  test("starting from the choice this browser remembered", async () => {
    localStorage.setItem("casita.theme", "night");
    const { el } = await renderShell("/settings", { pages: SETTINGS, me: MEMBER, themes: THEMES });
    expect(option(el, "Night")?.getAttribute("aria-checked")).toBe("true");
  });

  test("and choosing one dresses the whole shell in it, and Auto forgets it", async () => {
    const { el } = await renderShell("/settings", { pages: SETTINGS, me: MEMBER, themes: THEMES });
    expect(el.querySelector(".app-shell-october")).toBeNull();

    await dom.click(option(el, "October"));
    expect(document.documentElement.dataset.theme).toBe("october");
    expect(localStorage.getItem("casita.theme")).toBe("october");
    expect(el.querySelector(".app-shell-october")).not.toBeNull();
    expect(option(el, "October")?.getAttribute("aria-checked")).toBe("true");

    await dom.click(option(el, "Auto"));
    expect(localStorage.getItem("casita.theme")).toBeNull();
    // This test's device is in light mode, so Auto lands on the light default.
    expect(document.documentElement.dataset.theme).toBe("day");
    expect(el.querySelector(".app-shell-october")).toBeNull();
  });
});

// ───────── the brand and the footer ─────────

describe("the brand", () => {
  const brand = (el: HTMLElement) => el.querySelector(".ca-nav-brand a") as HTMLAnchorElement;

  /** Clicks the brand and reports whether its default was prevented by the time it bubbled out. */
  async function clickBrand(el: HTMLElement, init: MouseEventInit = {}) {
    let prevented: boolean | undefined;
    // Bubbles after React's own listener at the root; stops happy-dom following the link.
    const watch = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", watch);
    try {
      await dom.act(() => {
        brand(el).dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
        );
      });
    } finally {
      document.removeEventListener("click", watch);
    }
    return prevented;
  }

  test("is a link home with a label", async () => {
    const { el } = await renderShell("/devices");
    const link = brand(el);
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("/");
    expect(link.getAttribute("aria-label")).toBe("Casita, home");
    expect(link.textContent).toBe("Casita");
    expect(link.querySelector(".app-brand-mark")).not.toBeNull();
  });

  test("a plain click goes home in the app and keeps the browser from loading the page", async () => {
    const { el, went } = await renderShell("/devices");
    expect(await clickBrand(el)).toBe(true);
    expect(went).toEqual(["/"]);
  });

  test("a cmd- or ctrl-click is left to the browser, for a new tab", async () => {
    const { el, went } = await renderShell("/devices");
    expect(await clickBrand(el, { metaKey: true })).toBe(false);
    expect(await clickBrand(el, { ctrlKey: true })).toBe(false);
    expect(went).toEqual([]);
  });
});

describe("the nav footer", () => {
  const foot = (el: HTMLElement) => el.querySelector(".ca-nav-foot") as HTMLElement;

  test("names who is signed in and offers to sign out, without a role badge", async () => {
    const { el } = await renderShell("/", {
      me: { username: "ry", displayName: "Ryan", role: "admin" },
    });
    expect(foot(el).querySelector(".app-me")?.textContent).toBe("Ryan");
    expect([...foot(el).querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Sign out",
    ]);
    expect(foot(el).querySelector(".ca-badge")).toBeNull();
    expect(foot(el).textContent).not.toContain("Admin");
  });

  test("falls back to the username when there is no display name", async () => {
    const { el } = await renderShell("/", { me: MEMBER });
    expect(foot(el).querySelector(".app-me")?.textContent).toBe("ana");
    expect(foot(el).textContent).not.toContain("Member");
  });
});
