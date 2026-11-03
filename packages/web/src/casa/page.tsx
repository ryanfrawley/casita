// A Casa page as the app shows it: fetched by id, mounted on the house, fetched again when
// an admin saves it. A node the house no longer has is an inline note, not a blank page.

import { CasitaError } from "@casita/client";
import type { CompiledPage } from "@casita/core/casa";
import { EmptyState, Skeleton, useGridSnap } from "@casita/ui";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCasaStore, useHouse, useStore, useToast } from "../context.tsx";
import { useThingSheets } from "../detail.tsx";
import { CasaContext, type CasaContextValue, PageView } from "./render.tsx";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; page: CompiledPage; updatedAt: number };

/** Fetches a page and keeps it current: `page_changed` for its id fetches it again. */
export function usePage(pageId: string): Loaded {
  const store = useStore();
  const { phase } = useHouse();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    if (phase !== "ready") return;
    let current = true;
    const load = () =>
      store.request("get_page", { pageId }).then(
        (result) => {
          if (!current) return;
          const page = result as { compiled: CompiledPage; updatedAt: number };
          setLoaded({ status: "ready", page: page.compiled, updatedAt: page.updatedAt });
        },
        (err: unknown) => {
          if (!current) return;
          const message = err instanceof CasitaError ? err.message : "Couldn't load the page";
          setLoaded({ status: "error", message });
        },
      );
    void load();
    const off = store.onEvent("page_changed", () => void load());
    return () => {
      current = false;
      off();
    };
  }, [store, pageId, phase]);
  return loaded;
}

/** A node that throws while drawing shows where it broke; the rest of the page stands. */
class NodeBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("casa page failed to draw", error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <EmptyState
          size="inline"
          icon="triangle-alert"
          title="This part of the page couldn't be drawn"
          description={this.state.error}
        />
      );
    }
    return this.props.children;
  }
}

/** What counts as a card on a page, for the grid: the things drawn as wells. */
const CARDS =
  ".ca-widget, .ca-ecard, .ca-thermo, .ca-meter, .ca-chart, .ca-fc, .ca-rows, .app-recent > ul";

/**
 * Mounts a compiled page on the house. `onLocate` is the editor's Alt-click; left out, the
 * page is the app's own.
 */
export function CasaPage({
  page,
  onLocate,
  className = "app-page",
}: {
  page: CompiledPage;
  onLocate?: (at: [number, number]) => void;
  className?: string;
}) {
  const store = useStore();
  const casa = useCasaStore();
  const toast = useToast();
  const { open, sheets } = useThingSheets();
  const context = useMemo<CasaContextValue>(
    () => ({
      casa,
      store,
      page,
      onOpen: (id) => open({ kind: "entity", id }),
      onOpenThing: open,
      onFailure: (message) => toast({ tone: "error", title: "The house didn't do that", message }),
      onLocate,
    }),
    [casa, store, page, toast, onLocate, open],
  );
  // Every card on the page stands on the grid: a whole number of units tall.
  const root = useRef<HTMLDivElement>(null);
  useGridSnap(root, CARDS);
  // A node's hooks follow its properties, so a new compiled page mounts a new tree.
  const seen = useRef<{ page: CompiledPage; key: number }>({ page, key: 1 });
  if (seen.current.page !== page) seen.current = { page, key: seen.current.key + 1 };
  const key = seen.current.key;
  return (
    <CasaContext.Provider value={context}>
      <div className={className} ref={root}>
        <NodeBoundary key={key}>
          <PageView page={page} />
        </NodeBoundary>
        {sheets}
      </div>
    </CasaContext.Provider>
  );
}

/** The app's page by id, with its loading and failure states; the editor is reached from Settings. */
export function PageScreen({ pageId }: { pageId: string }) {
  const loaded = usePage(pageId);
  const { phase } = useHouse();
  if (phase === "connecting" || loaded.status === "loading") {
    return (
      <div className="app-page">
        <Skeleton shape="block" width={280} height={44} />
        <Skeleton shape="block" width="100%" height={220} />
        <Skeleton shape="block" width="100%" height={220} />
      </div>
    );
  }
  if (loaded.status === "error") {
    return (
      <div className="app-page">
        <EmptyState
          icon="triangle-alert"
          title="Couldn't load this page"
          description={loaded.message}
        />
      </div>
    );
  }
  return <CasaPage page={loaded.page} />;
}
