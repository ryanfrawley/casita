import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Row } from "@casita/client";
import { setupDom } from "@casita/ui/test-dom";
import type { ReactNode } from "react";
import { CasaStore } from "./casa/host.ts";
import { AppProvider } from "./context.tsx";
import { AreaDetail, DeviceDetail, EntityDetail } from "./detail.tsx";
import { type Page, Shell } from "./shell.tsx";
import { EMPTY, type House, reduce, type Store } from "./store.ts";

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

// ───────── a house ─────────

const entity = (id: string, name: string, extra: Row = {}): Row => ({
  id,
  domain: id.split(".")[0],
  name,
  integrationId: "test.main",
  capabilities: {},
  level: "control",
  controllable: true,
  ...extra,
});

const state = (id: string, state: Row, extra: Row = {}): Row => ({
  entityId: id,
  state,
  available: true,
  changedAt: 1000,
  updatedAt: 2000,
  ...extra,
});

const LOADED = {
  me: { username: "ry", role: "member" },
  entities: [
    entity("light.hall", "Hall light", {
      deviceId: "dev_lamp",
      areaId: "hall",
      effectiveAreaId: "hall",
      capabilities: { brightness: true },
    }),
    entity("sensor.lamp_power", "Lamp power", {
      deviceId: "dev_lamp",
      effectiveAreaId: "hall",
      controllable: false,
    }),
    entity("switch.porch", "Porch", { deviceId: "dev_porch", effectiveAreaId: "porch" }),
    entity("lock.front", "Front door", { effectiveAreaId: "hall" }),
    entity("sensor.elsewhere", "Elsewhere", { areaId: "hall" }),
  ],
  devices: [
    {
      id: "dev_lamp",
      name: "Hall lamp",
      manufacturer: "IKEA",
      model: "TRADFRI",
      areaId: "hall",
      integrationId: "test.main",
    },
    { id: "dev_plug", name: "Hall plug", areaId: "hall", integrationId: "test.main" },
    { id: "dev_porch", name: "Porch switch", areaId: "porch", integrationId: "test.main" },
  ],
  areas: [
    { id: "hall", name: "Hall" },
    { id: "porch", name: "Porch" },
    { id: "attic", name: "Attic" },
  ],
  cards: [],
  states: [
    state("light.hall", { domain: "light", on: true, brightness: 0.5 }),
    state("sensor.lamp_power", { domain: "sensor", value: 12, unit: "W" }),
    state("switch.porch", { domain: "switch", on: false }),
    state("lock.front", { domain: "lock", locked: true }),
    state("sensor.elsewhere", { domain: "sensor", value: 1 }),
  ],
  integrations: [],
};

function stubStore(overrides: Row = {}): Store {
  const house: House = reduce(EMPTY, {
    type: "loaded",
    data: { ...LOADED, ...overrides } as never,
  });
  return {
    getState: () => house,
    subscribe: () => () => {},
    command: async () => ({ ok: true, confirmed: true }),
    request: async (type: string) => (type === "get_history" ? { records: [] } : {}),
    onEvent: () => () => {},
    onRenamed: () => () => {},
  } as unknown as Store;
}

async function mount(node: ReactNode, overrides: Row = {}) {
  const store = stubStore(overrides);
  const casa = new CasaStore(store, { width: () => 1200, tick: false, timezone: "UTC" });
  const el = await dom.render(
    <AppProvider store={store} toast={() => ""} casa={casa} themes={[]}>
      {node}
    </AppProvider>,
  );
  return { el, text: () => el.textContent ?? "" };
}

const noop = () => {};
const title = (el: HTMLElement) => el.querySelector("[role=dialog] h2")?.textContent;
const rowNames = (el: HTMLElement) =>
  [...el.querySelectorAll(".ca-row .ca-row-name")].map((name) => name.textContent);

// ───────── tests ─────────

describe("DeviceDetail", () => {
  test("no device id draws nothing", async () => {
    const { el } = await mount(<DeviceDetail deviceId={null} onClose={noop} />);
    expect(el.querySelector("[role=dialog]")).toBeNull();
    expect(el.textContent).toBe("");
  });

  test("a device the house no longer has opens a sheet saying it is gone", async () => {
    const { el, text } = await mount(<DeviceDetail deviceId="dev_gone" onClose={noop} />);
    expect(title(el)).toBe("Not here any more");
    expect(text()).toContain("That device is gone.");
  });

  test("a device's sheet is titled by its name and shows its id", async () => {
    const { el, text } = await mount(<DeviceDetail deviceId="dev_lamp" onClose={noop} />);
    expect(title(el)).toBe("Hall lamp");
    expect(el.querySelector("[role=dialog] .ca-sheet-sub")?.textContent).toContain("dev_lamp");
    expect(text()).toContain("IKEA");
  });

  test("a device's sheet has one row for each entity on it", async () => {
    const { el } = await mount(<DeviceDetail deviceId="dev_lamp" onClose={noop} />);
    expect(rowNames(el)).toEqual(["Hall light", "Lamp power"]);
  });

  test("a device with no entities has no rows", async () => {
    const { el } = await mount(<DeviceDetail deviceId="dev_plug" onClose={noop} />);
    expect(title(el)).toBe("Hall plug");
    expect(el.querySelectorAll(".ca-row")).toHaveLength(0);
  });

  test("a row's details button opens that entity", async () => {
    const opened: string[] = [];
    const { el } = await mount(
      <DeviceDetail deviceId="dev_lamp" onClose={noop} onOpenEntity={(id) => opened.push(id)} />,
    );
    await dom.click(el.querySelector("[aria-label='Lamp power details']"));
    expect(opened).toEqual(["sensor.lamp_power"]);
  });
});

describe("AreaDetail", () => {
  test("no area id draws nothing", async () => {
    const { el } = await mount(<AreaDetail areaId={null} onClose={noop} />);
    expect(el.querySelector("[role=dialog]")).toBeNull();
    expect(el.textContent).toBe("");
  });

  test("an area the house no longer has opens a sheet saying it is gone", async () => {
    const { el, text } = await mount(<AreaDetail areaId="area_gone" onClose={noop} />);
    expect(title(el)).toBe("Not here any more");
    expect(text()).toContain("That area is gone.");
  });

  test("an area's sheet is titled by its name and names its devices", async () => {
    const { el, text } = await mount(<AreaDetail areaId="hall" onClose={noop} />);
    expect(title(el)).toBe("Hall");
    expect(el.querySelector("[role=dialog] .ca-sheet-sub")?.textContent).toContain("hall");
    expect(text()).toContain("2 devices: Hall lamp, Hall plug");
  });

  test("one device is counted in the singular", async () => {
    const { text } = await mount(<AreaDetail areaId="porch" onClose={noop} />);
    expect(text()).toContain("1 device: Porch switch");
  });

  test("an area has a row for each entity whose effective area it is, and no other", async () => {
    const { el } = await mount(<AreaDetail areaId="hall" onClose={noop} />);
    expect(rowNames(el)).toEqual(["Hall light", "Lamp power", "Front door"]);
  });

  test("an area with nothing in it says so", async () => {
    const { el, text } = await mount(<AreaDetail areaId="attic" onClose={noop} />);
    expect(text()).toContain("0 devices");
    expect(text()).not.toContain("0 devices:");
    expect(text()).toContain("Nothing is in this area yet.");
    expect(el.querySelectorAll(".ca-row")).toHaveLength(0);
  });
});

describe("the way to a device's settings", () => {
  const admin = { me: { username: "ry", role: "admin" } };
  const withSettings = {
    ...admin,
    integrations: [{ integrationId: "test.main", deviceSettings: true }],
  };
  const settingsButton = (el: HTMLElement) =>
    [...el.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Settings");

  test("a device's sheet has it for an admin when its integration keeps settings", async () => {
    const { el } = await mount(<DeviceDetail deviceId="dev_lamp" onClose={noop} />, withSettings);
    expect(settingsButton(el)).toBeDefined();
  });

  test("an entity's sheet has it too, for its device", async () => {
    const { el } = await mount(<EntityDetail entityId="light.hall" onClose={noop} />, withSettings);
    expect(settingsButton(el)).toBeDefined();
  });

  test("not for a member, an integration without settings, or an entity with no device", async () => {
    const lamp = <DeviceDetail deviceId="dev_lamp" onClose={noop} />;
    expect(
      settingsButton((await mount(lamp, { integrations: withSettings.integrations })).el),
    ).toBeUndefined();
    expect(settingsButton((await mount(lamp, admin)).el)).toBeUndefined();
    const front = <EntityDetail entityId="lock.front" onClose={noop} />;
    expect(settingsButton((await mount(front, withSettings)).el)).toBeUndefined();
  });
});

describe("the way up from an entity to its device", () => {
  const parentLink = (el: HTMLElement) =>
    el.querySelector("[role=dialog] .app-parent-link") as HTMLButtonElement | null;

  test("an entity on a device names the device in the sheet's subtitle", async () => {
    const { el } = await mount(<EntityDetail entityId="light.hall" onClose={noop} />);
    const link = parentLink(el);
    expect(link).not.toBeNull();
    expect(link?.tagName).toBe("BUTTON");
    expect(link?.textContent).toBe("Hall lamp");
    expect(link?.closest(".ca-sheet-sub")).not.toBeNull();
    // The id is still there beside it.
    expect(el.querySelector("[role=dialog] .ca-sheet-sub")?.textContent).toContain("light.hall");
  });

  test("an entity with no device has no link", async () => {
    const { el } = await mount(<EntityDetail entityId="lock.front" onClose={noop} />);
    expect(title(el)).toBe("Front door");
    expect(parentLink(el)).toBeNull();
  });

  test("an entity whose device the house no longer has has no link", async () => {
    const { el } = await mount(<EntityDetail entityId="light.hall" onClose={noop} />, {
      devices: [],
    });
    expect(parentLink(el)).toBeNull();
  });

  test("pressing it opens the device through onOpenDevice", async () => {
    const opened: string[] = [];
    const { el } = await mount(
      <EntityDetail
        entityId="switch.porch"
        onClose={noop}
        onOpenDevice={(id) => opened.push(id)}
      />,
    );
    expect(parentLink(el)?.textContent).toBe("Porch switch");
    await dom.click(parentLink(el));
    expect(opened).toEqual(["dev_porch"]);
  });

  test("without onOpenDevice it goes to the Devices page with the device open", async () => {
    // The page's navigation comes from the Shell around it.
    const went: string[] = [];
    const pages: Page[] = [
      {
        path: "/",
        label: "Home",
        icon: "house",
        render: () => <EntityDetail entityId="light.hall" onClose={noop} />,
      },
    ];
    const { el } = await mount(
      <Shell pages={pages} path="/" onNavigate={(to) => went.push(to)} />,
      {
        devices: [{ ...LOADED.devices[0], id: "dev lamp/1" }],
        entities: [entity("light.hall", "Hall light", { deviceId: "dev lamp/1" })],
      },
    );
    await dom.click(parentLink(el));
    expect(went).toEqual(["/devices?open=dev%20lamp%2F1"]);
  });
});
