// What every screen reaches for: the store, the house it holds, and somewhere to say what happened.

import type { ToastItem } from "@casita/ui";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { CasaStore } from "./casa/host.ts";
import type { Intent } from "./model.ts";
import type { House, Outcome, Store } from "./store.ts";
import type { ThemeInfo } from "./theme.ts";

type Push = (toast: Omit<ToastItem, "id"> & { id?: string }) => string;

interface App {
  store: Store;
  toast: Push;
  /** What a Casa page reads the house through. */
  casa: CasaStore;
  /** The themes the server lists, once loaded. */
  themes: readonly ThemeInfo[];
}

const AppContext = createContext<App | null>(null);

export function AppProvider({
  store,
  toast,
  casa,
  themes,
  children,
}: App & { children: ReactNode }) {
  return (
    <AppContext.Provider value={{ store, toast, casa, themes }}>{children}</AppContext.Provider>
  );
}

function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("No AppProvider above this component");
  return app;
}

export const useStore = (): Store => useApp().store;
export const useToast = (): Push => useApp().toast;
export const useCasaStore = (): CasaStore => useApp().casa;
export const useThemes = (): readonly ThemeInfo[] => useApp().themes;

export function useHouse(): House {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** What to say when a command did not do what was asked. Undefined when it did. */
export function failure(
  name: string,
  outcome: Outcome,
): { title: string; message: string } | undefined {
  if (outcome.ok && outcome.confirmed) return undefined;
  return outcome.ok
    ? {
        title: `${name} didn't confirm`,
        message: "The command was sent, but the device hasn't reported the change.",
      }
    : // The server's message is already written for people; show it as it is.
      { title: `Couldn't change ${name}`, message: outcome.message };
}

/**
 * Sends an entity a command. The row shows pending by itself; this only speaks up, in a
 * toast, when the house did not do it.
 */
export function useCommand(): (entityId: string, name: string, intent: Intent) => Promise<void> {
  const { store, toast } = useApp();
  return async (entityId, name, intent) => {
    const failed = failure(name, await store.command(entityId, intent.command, intent.waiting));
    if (failed) toast({ tone: "error", ...failed });
  };
}

/**
 * Runs a request that changes something and says how it went: a toast when it is done, or the
 * server's own message when it could not be. Resolves to whether it worked.
 */
export function useAction(): (
  done: string,
  failed: string,
  action: () => Promise<unknown>,
) => Promise<boolean> {
  const { toast } = useApp();
  return async (done, failed, action) => {
    try {
      await action();
      toast({ tone: "ok", message: done });
      return true;
    } catch (err) {
      toast({
        tone: "error",
        title: failed,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}

export const useIsAdmin = (): boolean => useHouse().me?.role === "admin";
