import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { formatSource } from "@casita/core/casa";
import { setupDom } from "@casita/ui/test-dom";
import { EditorView } from "@codemirror/view";
import type { ReactNode } from "react";
import { CasaStore } from "../casa/host.ts";
import { AppProvider } from "../context.tsx";
import { EMPTY, type House, type Store } from "../store.ts";
import type { ThemeInfo } from "../theme.ts";
import { AutomationEditor } from "./automation-editor.tsx";
import { CHECK_DEBOUNCE_MS, ComponentsEditor, PageEditor, ThemeEditor } from "./page-editor.tsx";
import { SensorEditor } from "./sensor-editor.tsx";

const dom = setupDom();

// CodeMirror watches its content with a MutationObserver, which `setupDom` does not put up. It is
// lent from happy-dom's window for this file, as the editor's own tests do.
const scope = globalThis as unknown as Record<string, unknown>;
let savedObserver: PropertyDescriptor | undefined;
beforeAll(() => {
  savedObserver = Object.getOwnPropertyDescriptor(scope, "MutationObserver");
  const window = dom.document.defaultView as unknown as Record<string, unknown>;
  scope.MutationObserver = window.MutationObserver;
});
afterAll(() => {
  if (savedObserver) Object.defineProperty(scope, "MutationObserver", savedObserver);
  else delete scope.MutationObserver;
});

/** Parses and compiles, but not in the house style. */
const MESSY = 'page Home {\nStack {\nText { value:"a"+"b" }\n}\n}\n';
const TIDY = 'page Home {\n  Stack {\n    Text { value: "a" + "b" }\n  }\n}\n';
/** Does not parse, so formatting leaves it alone. */
const BROKEN = "page Home {\nStack {\nText { value: }\n}\n}\n";

interface Toast {
  tone?: string;
  title?: string;
  message: string;
}

/**
 * An admin's house showing `editor`, answering each request with its entry in `answers` (or
 * `{}`); what the editor sent, and what it toasted, are kept for the test.
 */
async function mount(
  editor: ReactNode,
  answers: Record<string, unknown>,
  themes: ThemeInfo[] = [],
  entities: Row[] = [],
) {
  const sent: { type: string; params: Record<string, unknown> }[] = [];
  const toasts: Toast[] = [];
  const house: House = { ...EMPTY, phase: "ready", me: { role: "admin" } as Row, entities };
  const store = {
    getState: () => house,
    subscribe: () => () => {},
    onEvent: () => () => {},
    request: async (type: string, params: Record<string, unknown>) => {
      sent.push({ type, params });
      // Answered on a later turn, so the answer lands inside the test's next `act` rather than
      // between the render's and it.
      await new Promise((done) => setTimeout(done, 0));
      return answers[type] ?? {};
    },
  } as unknown as Store;
  const casa = new CasaStore(store, { width: () => 1200, tick: false, timezone: "UTC" });
  const el = await dom.render(
    <AppProvider
      store={store}
      toast={(toast) => {
        toasts.push(toast as Toast);
        return "";
      }}
      casa={casa}
      themes={themes}
    >
      {editor}
    </AppProvider>,
  );
  /** Waits out the compile's debounce, so its update lands inside the test. */
  const compiled = () =>
    dom.act(() => new Promise<void>((done) => setTimeout(done, CHECK_DEBOUNCE_MS + 50)));
  // The source arrives on a request, and the first compile runs a debounce after it lands.
  await compiled();
  await compiled();
  const view = () => {
    const editor = el.querySelector(".cm-editor");
    const found = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
    if (!found) throw new Error("no editor");
    return found;
  };
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent === label);
  return {
    el,
    sent,
    toasts,
    button,
    /** The editor's text, line breaks and all. */
    text: () => view().state.doc.toString(),
    /** Types `insert` at the end of the text, as a person would. */
    append: (insert: string) =>
      dom.act(() => {
        const editor = view();
        const end = editor.state.doc.length;
        editor.dispatch({ changes: { from: end, insert } });
      }),
    compiled,
  };
}

/** The Home page's editor, with `source` stored as the page. */
const mountPage = (source: string) =>
  mount(<PageEditor pageId="home" />, {
    get_page_source: { source, versions: [] },
    get_components_source: { source: "" },
    check_page: { diagnostics: [] },
    save_page: { ok: true, diagnostics: [] },
  });

test("Format puts the editor's text in the house style", async () => {
  const { button, text, compiled } = await mountPage(MESSY);
  expect(text()).toBe(MESSY);
  await dom.click(button("Format"));
  await compiled();
  expect(text()).toBe(TIDY);
});

test("Format leaves text already in the house style alone, and says nothing", async () => {
  const { button, text, toasts } = await mountPage(TIDY);
  await dom.click(button("Format"));
  expect(text()).toBe(TIDY);
  expect(toasts).toEqual([]);
});

test("Format on a source that does not parse leaves it alone and says why", async () => {
  const { button, text, toasts } = await mountPage(BROKEN);
  await dom.click(button("Format"));
  expect(text()).toBe(BROKEN);
  expect(toasts.map((t) => t.title)).toEqual(["Not formatted"]);
  expect(toasts[0]?.tone).toBe("error");
});

test("Save sends the formatted source to the check and the save, and shows it", async () => {
  const { button, text, sent, append, compiled } = await mountPage(TIDY);
  // A line in no particular style, so the page is dirty and has something to format.
  await append("\n\n\n// note   ");
  await compiled();
  await dom.click(button("Save"));
  await compiled();
  const expected = formatSource(`${TIDY}\n\n\n// note   `);
  expect(expected).toBe(`${TIDY}\n// note\n`);
  const saves = sent.filter((r) => r.type === "check_page" || r.type === "save_page");
  expect(saves.map((r) => r.type)).toEqual(["check_page", "save_page"]);
  for (const r of saves) expect(r.params).toEqual({ pageId: "home", source: expected });
  expect(text()).toBe(expected);
});

test("Save is not offered before the text changes", async () => {
  const { button } = await mountPage(MESSY);
  expect(button("Save")?.hasAttribute("disabled")).toBe(true);
  expect(button("Format")?.hasAttribute("disabled")).toBe(false);
});

// The other source editors share the page's formatting; each is shown once with untidy text and
// once saving it.

/** A line in no particular style, typed so that a saved source is dirty and has something to format. */
const NOTE = "\n\n\n// note   ";
const NOTED = "\n// note\n";

const THEME_MESSY = "theme Mine extends Night {\npalette { accent:#ff0000 }\n}\n";
const THEME_TIDY = "theme Mine extends Night {\n  palette { accent: #ff0000 }\n}\n";

/** A stored theme, built in or the admin's own. */
const theme = (builtin: boolean): ThemeInfo => ({
  id: "mine",
  name: "Mine",
  extends: "Night",
  css: "",
  dark: true,
  builtin,
  isLightDefault: false,
  isDarkDefault: false,
  breakpoints: { tablet: 600, desktop: 1000 },
  values: {},
  source: builtin ? undefined : THEME_MESSY,
});

const mountTheme = (builtin = false) =>
  mount(<ThemeEditor themeId="mine" />, { save_theme: { ok: true, diagnostics: [] } }, [
    theme(builtin),
  ]);

test("Format puts a theme's text in the house style", async () => {
  const { button, text, compiled } = await mountTheme();
  await dom.click(button("Format"));
  await compiled();
  expect(text()).toBe(THEME_TIDY);
});

test("Save sends a theme's formatted source, and shows it", async () => {
  const { button, text, sent, compiled } = await mountTheme();
  await dom.click(button("Save"));
  await compiled();
  const saves = sent.filter((r) => r.type === "save_theme");
  expect(saves.map((r) => r.params)).toEqual([{ themeId: "mine", source: THEME_TIDY }]);
  expect(text()).toBe(THEME_TIDY);
});

test("Format is not offered for a built-in theme", async () => {
  const { button } = await mountTheme(true);
  expect(button("Format")?.hasAttribute("disabled")).toBe(true);
});

const COMPONENTS_MESSY = 'component Tag() {\nText { value:"a"+"b" }\n}\n';
const COMPONENTS_TIDY = 'component Tag() {\n  Text { value: "a" + "b" }\n}\n';

const mountComponents = () =>
  mount(<ComponentsEditor />, {
    get_components_source: { source: COMPONENTS_MESSY },
    check_components: { diagnostics: [] },
    save_components: { ok: true, diagnostics: [] },
  });

test("Format puts the shared components' text in the house style", async () => {
  const { button, text, compiled } = await mountComponents();
  await dom.click(button("Format"));
  await compiled();
  expect(text()).toBe(COMPONENTS_TIDY);
});

test("Save sends the shared components' formatted source to the check and the save, and shows it", async () => {
  const { button, text, sent, compiled } = await mountComponents();
  await dom.click(button("Save"));
  await compiled();
  const saves = sent.filter((r) => r.type === "check_components" || r.type === "save_components");
  expect(saves.map((r) => r.type)).toEqual(["check_components", "save_components"]);
  for (const r of saves) expect(r.params).toEqual({ source: COMPONENTS_TIDY });
  expect(text()).toBe(COMPONENTS_TIDY);
});

const AUTOMATION_MESSY = "automation Hall {\nevery 10m {\nafter 5m {   }\n}\n}\n";
const AUTOMATION_TIDY = "automation Hall {\n  every 10m {\n    after 5m { }\n  }\n}\n";

const mountAutomation = (source: string) =>
  mount(<AutomationEditor automationId="hall" />, {
    get_automation_source: { source, versions: [] },
    get_automation_runs: [],
    save_automation: { ok: true, diagnostics: [] },
  });

test("Format puts an automation's text in the house style", async () => {
  const { button, text, compiled } = await mountAutomation(AUTOMATION_MESSY);
  await dom.click(button("Format"));
  await compiled();
  expect(text()).toBe(AUTOMATION_TIDY);
});

test("Save sends an automation's formatted source, and shows it", async () => {
  const { button, text, sent, append, compiled } = await mountAutomation(AUTOMATION_TIDY);
  await append(NOTE);
  await compiled();
  await dom.click(button("Save"));
  await compiled();
  const expected = `${AUTOMATION_TIDY}${NOTED}`;
  const saves = sent.filter((r) => r.type === "save_automation");
  expect(saves.map((r) => r.params)).toEqual([{ automationId: "hall", source: expected }]);
  expect(text()).toBe(expected);
});

// ───────── testing an automation ─────────

const RAINY = `automation Rainy {
  on weather.home#conditionNext12h changed { call light.hall.turn_on }
}
`;
const TWO = `automation Two {
  every 1h { call light.hall.turn_on }
  on weather.home#conditionNext12h changed { call light.hall.turn_off }
}
`;
const HOUSE: Row[] = [
  { id: "weather.home", domain: "weather", name: "Home" },
  { id: "light.hall", domain: "light", name: "Hall" },
];
const RAN = { at: 1, line: 2, trigger: "test", calls: [], actions: [], armed: [] };

const mountTest = (source: string, ran: unknown = RAN) =>
  mount(
    <AutomationEditor automationId="rainy" />,
    {
      get_automation_source: { source, versions: [] },
      get_automation_runs: [],
      test_automation: ran,
    },
    [],
    HOUSE,
  );

const settle = () => dom.act(() => new Promise<void>((done) => setTimeout(done, 20)));

/**
 * Presses the sheet's run button and waits for the answer, then for the runs it asks for again
 * (the reload's request goes out as the first `act` ends, so it lands in the second).
 */
const press = async (el: Element | undefined) => {
  if (!el) throw new Error("no button");
  await dom.act(async () => {
    (el as HTMLElement).click();
    await new Promise((done) => setTimeout(done, 20));
  });
  await settle();
};

/** What the Test sheet sent, by request. */
const tests = (sent: { type: string; params: Record<string, unknown> }[]) =>
  sent.filter((r) => r.type === "test_automation").map((r) => r.params);

test("Test is offered for a saved automation with handlers, not while it is being edited", async () => {
  const { button, append, compiled } = await mountTest(RAINY);
  expect(button("Test")?.hasAttribute("disabled")).toBe(false);
  await append(NOTE);
  await compiled();
  expect(button("Test")?.hasAttribute("disabled")).toBe(true);
});

test("Test is not offered for an automation with no handlers", async () => {
  const { button } = await mountTest("automation Empty {\n}\n");
  expect(button("Test")?.hasAttribute("disabled")).toBe(true);
});

test("the sheet starts with the trigger's attribute to pretend, and sends the value typed", async () => {
  const { el, button, sent, toasts } = await mountTest(RAINY);
  await dom.click(button("Test"));
  const key = el.querySelector<HTMLInputElement>('input[placeholder="sensor.outside"]');
  expect(key?.value).toBe("weather.home#conditionNext12h");
  expect(button("Run now")).toBeDefined();
  await dom.type(el.querySelector('input[placeholder="as it is"]'), "rain");
  await press(button("Run with pretend values"));
  expect(tests(sent)).toEqual([
    {
      automationId: "rainy",
      line: 2,
      pretend: { "weather.home#conditionNext12h": "rain" },
    },
  ]);
  expect(toasts.map((t) => t.tone)).toEqual(["ok"]);
  // The runs are asked for again, so the test shows under Recent runs; the sheet closes.
  expect(sent.filter((r) => r.type === "get_automation_runs").length).toBeGreaterThan(1);
  expect(button("Run now")).toBeUndefined();
});

test("values are read as the page preview reads them: numbers, states, Unavailable as null", async () => {
  const { el, button, sent } = await mountTest(RAINY);
  await dom.click(button("Test"));
  await dom.type(el.querySelector('input[placeholder="as it is"]'), "12.5");
  await dom.click(button("Pretend another value"));
  const keys = el.querySelectorAll('input[placeholder="sensor.outside"]');
  const values = el.querySelectorAll('input[placeholder="as it is"]');
  await dom.type(keys[1], "light.hall");
  await dom.type(values[1], ".On");
  await dom.click(button("Pretend another value"));
  await dom.type(el.querySelectorAll('input[placeholder="sensor.outside"]')[2], "sensor.gone");
  await dom.type(el.querySelectorAll('input[placeholder="as it is"]')[2], "Unavailable");
  await press(button("Run with pretend values"));
  expect(tests(sent)[0]?.pretend).toEqual({
    "weather.home#conditionNext12h": 12.5,
    "light.hall": "On",
    "sensor.gone": null,
  });
});

test("left blank, the test reads the house as it is and pretends nothing", async () => {
  const { button, sent } = await mountTest(RAINY);
  await dom.click(button("Test"));
  await press(button("Run now"));
  expect(tests(sent)).toEqual([{ automationId: "rainy", line: 2 }]);
});

test("with several handlers, the one picked is tested, its trigger ready to pretend", async () => {
  const { el, button, sent } = await mountTest(TWO);
  await dom.click(button("Test"));
  const select = el.querySelector("select");
  expect([...(select?.options ?? [])].map((o) => o.value)).toEqual(["2", "3"]);
  // The first is a schedule: nothing to pretend.
  expect(el.querySelectorAll('input[placeholder="sensor.outside"]')).toHaveLength(0);
  await dom.act(() => {
    if (!select) throw new Error("no select");
    select.value = "3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(el.querySelector<HTMLInputElement>('input[placeholder="sensor.outside"]')?.value).toBe(
    "weather.home#conditionNext12h",
  );
  await press(button("Run now"));
  expect(tests(sent)).toEqual([{ automationId: "rainy", line: 3 }]);
});

test("a test whose command failed says so", async () => {
  const failed = {
    ...RAN,
    calls: [{ entityId: "light.hall", command: { action: "turn_on" }, error: "not permitted" }],
  };
  const { button, toasts } = await mountTest(RAINY, failed);
  await dom.click(button("Test"));
  await press(button("Run now"));
  expect(toasts).toEqual([
    { tone: "error", title: "The test ran into a problem", message: "not permitted" },
  ]);
});

const SENSOR_MESSY = 'sensor Word {\nname:"Word"\ntype: String\nvalue:"a"+"b"\n}\n';
const SENSOR_TIDY = 'sensor Word {\n  name: "Word"\n  type: String\n  value: "a" + "b"\n}\n';

const mountSensor = (source: string) =>
  mount(<SensorEditor sensorId="word" />, {
    get_sensor_source: { source, versions: [] },
    get_sensors: [],
    save_sensor: { ok: true, diagnostics: [] },
  });

test("Format puts a sensor's text in the house style", async () => {
  const { button, text, compiled } = await mountSensor(SENSOR_MESSY);
  await dom.click(button("Format"));
  await compiled();
  expect(text()).toBe(SENSOR_TIDY);
});

test("Save sends a sensor's formatted source, and shows it", async () => {
  const { button, text, sent, append, compiled } = await mountSensor(SENSOR_TIDY);
  await append(NOTE);
  await compiled();
  await dom.click(button("Save"));
  await compiled();
  const expected = `${SENSOR_TIDY}${NOTED}`;
  const saves = sent.filter((r) => r.type === "save_sensor");
  expect(saves.map((r) => r.params)).toEqual([{ sensorId: "word", source: expected }]);
  expect(text()).toBe(expected);
});
