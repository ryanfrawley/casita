import { ToastRegion, useToasts } from "@casita/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CasaStore } from "./casa/host.ts";
import { AppProvider, useHouse } from "./context.tsx";
import { Areas } from "./pages/areas.tsx";
import { AutomationEditor } from "./pages/automation-editor.tsx";
import { Automations } from "./pages/automations.tsx";
import { DeviceSettings } from "./pages/device-settings.tsx";
import { Devices } from "./pages/devices.tsx";
import { Entities } from "./pages/entities.tsx";
import { History } from "./pages/history.tsx";
import { Home } from "./pages/home.tsx";
import { Integrations } from "./pages/integrations.tsx";
import { Login } from "./pages/login.tsx";
import { ComponentsEditor, PageEditor, ThemeEditor } from "./pages/page-editor.tsx";
import { SensorEditor } from "./pages/sensor-editor.tsx";
import { Settings } from "./pages/settings.tsx";
import { Users } from "./pages/users.tsx";
import { DEVICE_SETTINGS_PATH, EDIT_COMPONENTS_PATH } from "./routes.ts";
import { type Page, Shell } from "./shell.tsx";
import type { Store } from "./store.ts";
import type { ThemeInfo } from "./theme.ts";

const PAGES: Page[] = [
  { path: "/", label: "Home", icon: "house", render: () => <Home /> },
  { path: "/entities", label: "Entities", icon: "layout-grid", render: () => <Entities /> },
  { path: "/devices", label: "Devices", icon: "cpu", render: () => <Devices /> },
  { path: "/areas", label: "Areas", icon: "map", render: () => <Areas /> },
  { path: "/integrations", label: "Integrations", icon: "plug", render: () => <Integrations /> },
  { path: "/automations", label: "Automations", icon: "workflow", render: () => <Automations /> },
  { path: "/history", label: "History", icon: "history", render: () => <History /> },
  {
    path: "/users",
    label: "Users & access",
    // Someone who is not an admin finds only their own tokens and sessions there.
    labelFor: (role) => (role === "admin" ? "Users & access" : "Account"),
    icon: "users",
    render: () => <Users />,
  },
  { path: "/settings", label: "Settings", icon: "settings", render: () => <Settings /> },
  {
    path: DEVICE_SETTINGS_PATH,
    label: "Device settings",
    icon: "settings-2",
    hidden: true,
    nav: "/devices",
    render: (params) => <DeviceSettings key={params.id} deviceId={params.id ?? ""} />,
  },
  {
    path: "/edit/theme/:id",
    label: "Edit theme",
    icon: "pencil",
    hidden: true,
    nav: "/settings",
    render: (params) => <ThemeEditor themeId={params.id ?? ""} />,
  },
  {
    path: EDIT_COMPONENTS_PATH,
    label: "Shared components",
    icon: "pencil",
    hidden: true,
    nav: "/settings",
    render: () => <ComponentsEditor />,
  },
  {
    path: "/automations/edit/:id",
    label: "Edit automation",
    icon: "pencil",
    hidden: true,
    nav: "/automations",
    render: (params) => <AutomationEditor automationId={params.id ?? ""} />,
  },
  {
    path: "/automations/sensor/:id",
    label: "Edit sensor",
    icon: "pencil",
    hidden: true,
    nav: "/automations",
    render: (params) => <SensorEditor sensorId={params.id ?? ""} />,
  },
  {
    path: "/edit/:id",
    label: "Edit page",
    icon: "pencil",
    hidden: true,
    nav: "/",
    render: (params) => <PageEditor pageId={params.id ?? ""} />,
  },
];

/**
 * The page the address bar names, kept in step with back and forward. A destination may
 * carry a query (`/devices?open=thermostat`) for the page to read; only the path picks the page.
 */
function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const back = () => setPath(location.pathname);
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  return [
    path,
    (next) => {
      if (next !== location.pathname + location.search) history.pushState(null, "", next);
      setPath(new URL(next, location.origin).pathname);
    },
  ];
}

function Screen() {
  const { phase } = useHouse();
  const [path, navigate] = usePath();
  if (phase === "signed-out") return <Login />;
  return <Shell pages={PAGES} path={path} onNavigate={navigate} />;
}

/** The themes the server lists, fetched when the house is ready and again when one is saved. */
function useThemeList(store: Store): readonly ThemeInfo[] {
  const { phase } = useHouse();
  const [themes, setThemes] = useState<readonly ThemeInfo[]>([]);
  useEffect(() => {
    if (phase !== "ready") return;
    let current = true;
    const load = () =>
      store.request("list_themes", {}).then(
        (list) => {
          if (current) setThemes(list as ThemeInfo[]);
        },
        () => {},
      );
    void load();
    const off = store.onEvent("theme_changed", () => void load());
    return () => {
      current = false;
      off();
    };
  }, [store, phase]);
  return themes;
}

function Themed({
  store,
  children,
}: {
  store: Store;
  children: (themes: readonly ThemeInfo[]) => ReactNode;
}) {
  return <>{children(useThemeList(store))}</>;
}

export function App({ store }: { store: Store }) {
  const { toasts, push, dismiss } = useToasts();
  const casa = useMemo(() => new CasaStore(store), [store]);
  // The theme list needs the house's phase, which needs the provider: a bare provider first.
  return (
    <AppProvider store={store} toast={push} casa={casa} themes={[]}>
      <Themed store={store}>
        {(themes) => (
          <AppProvider store={store} toast={push} casa={casa} themes={themes}>
            <Screen />
            <ToastRegion toasts={toasts} onDismiss={dismiss} />
          </AppProvider>
        )}
      </Themed>
    </AppProvider>
  );
}
