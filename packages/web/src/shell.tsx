// The frame around every page once signed in: navigation down the left, the page beside it.

import { Badge, Button, formatTime, SideNav, Toast } from "@casita/ui";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useCasaStore, useHouse, useStore, useThemes } from "./context.tsx";
import { matchPath } from "./routes.ts";
import { HeaderSearch } from "./search.tsx";
import { applyTheme, descendsFrom, resolveTheme, savedTheme, type Theme } from "./theme.ts";

export interface Page {
  /** May name parts: `/devices/:id/card`. */
  path: string;
  label: string;
  /** A different label for some roles. */
  labelFor?: (role: string) => string;
  icon: string;
  /** Left out of the navigation; `nav` is the path of the item lit while it is open. */
  hidden?: boolean;
  nav?: string;
  render: (params: Record<string, string>) => ReactNode;
}

const NavigateContext = createContext<(path: string) => void>(() => {});
/** Moves to another page, as a click in the navigation would. */
export const useNavigate = () => useContext(NavigateContext);

/** The theme this browser chose, and a way to choose another; the shell holds it, Settings offers it. */
export interface ThemeChoice {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}
const ThemeChoiceContext = createContext<ThemeChoice>({ theme: "system", setTheme: () => {} });
export const useThemeChoice = () => useContext(ThemeChoiceContext);

const ROLE_ICON: Record<string, string> = { admin: "shield", member: "user", guest: "eye" };

export function Shell({
  pages,
  path,
  onNavigate,
}: {
  pages: Page[];
  path: string;
  onNavigate: (path: string) => void;
}) {
  const store = useStore();
  const house = useHouse();
  const themes = useThemes();
  const casa = useCasaStore();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const active = resolveTheme(theme, themes);
  // October's flourishes: a moon by the roof and moonlight over the page.
  const october = descendsFrom(active, "October", themes);
  useEffect(() => {
    applyTheme(theme, themes);
    if (active) casa.setBreakpoints(active.breakpoints);
  }, [theme, themes, active, casa]);
  const hit = pages
    .map((candidate) => ({ page: candidate, params: matchPath(candidate.path, path) }))
    .find((candidate) => candidate.params);
  const page = hit?.page ?? pages[0];
  const params = hit?.params ?? {};
  // A new page says so: in the tab's title, and by moving focus to it so a screen reader
  // starts reading there and Tab continues from its top.
  const main = useRef<HTMLElement>(null);
  const shown = page?.labelFor?.(String(house.me?.role ?? "")) ?? page?.label;
  const first = useRef(true);
  useEffect(() => {
    document.title = shown ? `${shown} · Casita` : "Casita";
    if (first.current) first.current = false;
    else main.current?.focus({ preventScroll: true });
  }, [shown]);
  const role = String(house.me?.role ?? "");

  return (
    <div className={october ? "app-shell app-shell-october" : "app-shell"}>
      <a className="app-skip" href="#main">
        Skip to the page
      </a>
      <SideNav
        className="app-nav"
        value={page?.nav ?? page?.path}
        onSelect={onNavigate}
        brand={
          <span className="app-brand">
            <BrandMark moon={october} />
            <span>Casita</span>
          </span>
        }
        items={pages
          .filter((item) => !item.hidden)
          .map((item) => ({
            value: item.path,
            href: item.path,
            label: item.labelFor?.(role) ?? item.label,
            icon: item.icon,
          }))}
        footer={
          <div className="app-nav-foot">
            <div className="app-me">
              <span className="ca-text-label">
                {String(house.me?.displayName || house.me?.username || "")}
              </span>
              {role ? (
                <Badge tone={role === "admin" ? "brand" : "neutral"} icon={ROLE_ICON[role]}>
                  {role.charAt(0).toUpperCase() + role.slice(1)}
                </Badge>
              ) : null}
            </div>
            <Button variant="quiet" size="sm" onClick={() => void store.logout()}>
              Sign out
            </Button>
          </div>
        }
      />
      <main className="app-main" id="main" ref={main} tabIndex={-1}>
        {house.phase === "ready" ? (
          <header className="app-header">
            <HeaderSearch />
            <Clock />
          </header>
        ) : null}
        {house.phase === "reconnecting" ? (
          <div className="app-banner">
            <Toast
              tone="pending"
              message="Reconnecting to the house. What you see is the last it reported."
            />
          </div>
        ) : null}
        <NavigateContext.Provider value={onNavigate}>
          <ThemeChoiceContext.Provider value={{ theme, setTheme }}>
            {page?.render(params)}
          </ThemeChoiceContext.Provider>
        </NavigateContext.Provider>
      </main>
    </div>
  );
}

/**
 * The house mark, in the theme's own terracotta and lamp so a house theme recolours it too;
 * with `moon`, a crescent rises beside the roof.
 */
function BrandMark({ moon }: { moon: boolean }) {
  return (
    <svg
      className="app-brand-mark"
      viewBox={moon ? "0 0 72 64" : "0 0 64 64"}
      aria-hidden="true"
      data-moon={moon || undefined}
    >
      <path fill="var(--terracotta)" d="M10 60V26A22 22 0 0 1 54 26V60Z" />
      <path fill="var(--lamp)" d="M25 52V37A7 7 0 0 1 39 37V52Z" />
      {moon ? (
        <path fill="var(--lamp)" d="M68.3 14.1A7 7 0 1 1 61 4.1A6.2 6.2 0 0 0 68.3 14.1Z" />
      ) : null}
    </svg>
  );
}

/** The day and time at the header's end, as the design draws it; it moves with the clock. */
function Clock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="app-header-clock">{formatTime(now, { format: "datetime" })}</span>;
}
