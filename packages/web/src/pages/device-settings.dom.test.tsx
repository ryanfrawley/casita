import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { setupDom } from "@casita/ui/test-dom";
import { CasaStore } from "../casa/host.ts";
import { AppProvider } from "../context.tsx";
import { EMPTY, type House, reduce, type Store } from "../store.ts";
import { DeviceSettings } from "./device-settings.tsx";

const dom = setupDom();

const scope = globalThis as unknown as Record<string, unknown>;
let savedMatchMedia: unknown;
beforeAll(() => {
  savedMatchMedia = scope.matchMedia;
  scope.matchMedia = () => ({ matches: false });
});
afterAll(() => {
  scope.matchMedia = savedMatchMedia;
});

const SETTINGS = (values: Row) => [
  {
    key: "22",
    label: "Switch Type",
    type: "enum",
    value: values["22"] ?? 0,
    default: 0,
    options: [
      { value: 0, label: "Single pole" },
      { value: 2, label: "Multi-Way with aux switch" },
    ],
  },
  { key: "52", label: "Smart Bulb Mode", type: "boolean", value: values["52"] ?? false },
  {
    key: "12",
    label: "Auto Off Timer",
    type: "number",
    value: values["12"] ?? 0,
    min: 0,
    max: 32767,
    unit: "seconds",
    options: [{ value: 0, label: "Disabled" }],
  },
  {
    key: "21",
    label: "Power Type",
    type: "enum",
    value: 1,
    readOnly: true,
    options: [{ value: 1, label: "Neutral" }],
  },
  {
    key: "99[0xff000000]",
    label: "All LED Strip Effect - Effect",
    group: "All LED Strip Effect",
    type: "enum",
    value: 0,
    options: [
      { value: 0, label: "Off" },
      { value: 4, label: "Pulse" },
    ],
  },
  {
    key: "240",
    label: "Factory Reset",
    type: "enum",
    value: 0,
    default: 0,
    destructive: true,
    options: [
      { value: 0, label: "Default" },
      { value: 120935937, label: "Perform a factory reset" },
    ],
  },
];

/** A store whose device obeys a change only when the test says it reported back. */
function fakeStore(role = "admin") {
  const house: House = reduce(EMPTY, {
    type: "loaded",
    data: {
      me: { username: "ry", role },
      entities: [],
      devices: [
        {
          id: "kitchen_dimmer",
          name: "Kitchen dimmer",
          manufacturer: "Inovelli",
          model: "VZW31-SN",
          integrationId: "zwave-js.main",
        },
      ],
      areas: [],
      states: [],
      integrations: [{ integrationId: "zwave-js.main", deviceSettings: true }],
    } as never,
  });
  const values: Row = {};
  const sent: Row[] = [];
  const asked: string[] = [];
  const listeners = new Set<(event: Row) => void>();
  const store = {
    getState: () => house,
    subscribe: () => () => {},
    request: async (type: string, params: Row) => {
      asked.push(type);
      if (type === "get_device_settings") return { settings: SETTINGS(values) };
      if (type === "set_device_setting") {
        sent.push(params);
        return { key: params.key, value: params.value };
      }
      return {};
    },
    onEvent: (type: string, listener: (event: Row) => void) => {
      if (type !== "settings_changed") return () => {};
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onRenamed: () => () => {},
  } as unknown as Store;
  /** The device reports what it was sent. */
  const report = async () => {
    for (const change of sent) values[String(change.key)] = change.value;
    await dom.act(async () => {
      for (const listener of listeners) listener({ deviceId: "kitchen_dimmer" });
      await Bun.sleep(0);
    });
  };
  return { store, sent, asked, report };
}

async function mount(role = "admin") {
  const fake = fakeStore(role);
  const casa = new CasaStore(fake.store, { width: () => 1200, tick: false, timezone: "UTC" });
  const el = await dom.render(
    <AppProvider store={fake.store} toast={() => ""} casa={casa} themes={[]}>
      <DeviceSettings deviceId="kitchen_dimmer" />
    </AppProvider>,
  );
  await dom.act(() => Bun.sleep(0));
  return { el, ...fake };
}

const headings = (el: HTMLElement) =>
  [...el.querySelectorAll(".app-card h2")].map((h) => h.textContent);
const row = (el: HTMLElement, key: string) =>
  [...el.querySelectorAll(".app-setting")].find(
    (li) => li.querySelector(".app-setting-key")?.textContent === key,
  ) as HTMLElement;

test("lists the settings in sections, named by the device and its integration", async () => {
  const { el } = await mount();
  expect(el.querySelector("h1")?.textContent).toBe("Kitchen dimmer");
  expect(el.textContent).toContain("Inovelli · VZW31-SN · zwave-js.main");
  expect(headings(el)).toEqual(["General", "All LED Strip Effect"]);
  // A part's label drops the heading's words.
  expect(row(el, "99[0xff000000]").querySelector(".app-setting-label")?.textContent).toBe(
    "Effect99[0xff000000]",
  );
  expect(row(el, "21").textContent).toContain("Neutral");
  expect(row(el, "21").querySelector("select, input, button")).toBeNull();
  expect(row(el, "12").textContent).toContain("0 to 32767 seconds. 0 Disabled");
});

test("a switch is sent at once and shows pending until the device reports it", async () => {
  const { el, sent, report } = await mount();
  const toggle = () => row(el, "52").querySelector("[role=switch]") as HTMLElement;
  await dom.click(toggle());
  expect(sent).toEqual([{ deviceId: "kitchen_dimmer", key: "52", value: true }]);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(toggle().getAttribute("aria-busy")).toBe("true");
  expect(row(el, "52").textContent).toContain("waiting for the device");
  await report();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(toggle().getAttribute("aria-busy")).toBeNull();
});

test("a number is checked as it is typed and sent with Set", async () => {
  const { el, sent, report } = await mount();
  const input = () => row(el, "12").querySelector("input") as HTMLInputElement;
  const set = () => row(el, "12").querySelector("button[type=submit]") as HTMLButtonElement;
  expect(set().disabled).toBe(true);
  await dom.type(input(), "40000");
  expect(row(el, "12").textContent).toContain("At most 32767.");
  expect(set().disabled).toBe(true);
  await dom.type(input(), "300");
  await dom.click(set());
  expect(sent).toEqual([{ deviceId: "kitchen_dimmer", key: "12", value: 300 }]);
  await report();
  expect(input().value).toBe("300");
});

test("a list sends its choice; a changed one offers to put it back", async () => {
  const { el, sent, report } = await mount();
  const select = row(el, "22").querySelector("select") as HTMLSelectElement;
  await dom.act(() => {
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(sent.at(-1)).toEqual({ deviceId: "kitchen_dimmer", key: "22", value: 2 });
  await report();
  expect(row(el, "22").textContent).toContain("Normally Single pole.");
  await dom.click(row(el, "22").querySelector(".app-setting-reset"));
  expect(sent.at(-1)).toEqual({ deviceId: "kitchen_dimmer", key: "22", value: 0 });
});

test("a destructive change asks first, and Cancel sends nothing", async () => {
  const { el, sent } = await mount();
  const select = row(el, "240").querySelector("select") as HTMLSelectElement;
  await dom.act(() => {
    select.value = "120935937";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const dialog = dom.document.querySelector("[role=alertdialog], [role=dialog]");
  expect(dialog?.textContent).toContain("Setting it to Perform a factory reset is hard to undo.");
  const cancel = [...(dialog?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === "Cancel",
  );
  await dom.click(cancel);
  expect(sent).toEqual([]);
});

test("Find narrows the list to settings that hold every word", async () => {
  const { el } = await mount();
  const find = el.querySelector("input[type=search]");
  await dom.type(find, "led effect");
  expect(headings(el)).toEqual(["All LED Strip Effect"]);
  await dom.type(find, "nothing like it");
  expect(el.textContent).toContain("Nothing matches");
});

test("a member is told settings are an admin's, and nothing is asked of the server", async () => {
  const { el, asked } = await mount("member");
  expect(el.textContent).toContain("Only an admin can change a device's settings.");
  expect(el.querySelectorAll(".app-setting")).toHaveLength(0);
  expect(asked).not.toContain("get_device_settings");
});
