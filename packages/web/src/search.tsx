// The search in the header, on every page: ⌘K (Ctrl+K) focuses it, typing lists what matches
// by name or id, a row opens its details. It is the app's, not a page's: a Casa page no
// longer places it.

import { Icon } from "@casita/ui";
import { useEffect, useRef, useState } from "react";
import { useHouse } from "./context.tsx";
import { EntityControls } from "./controls.tsx";
import { EntityDetail } from "./detail.tsx";
import { entityView } from "./model.ts";

/** How many matches the list shows; more than this wants a narrower search. */
const SHOWN = 8;

/** Whether the keydown is the search shortcut: ⌘K on a Mac, Ctrl+K elsewhere. */
export const isSearchShortcut = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";

export function HeaderSearch() {
  const house = useHouse();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!house.entities.length) return null;
  const needle = query.trim().toLowerCase();
  const found = needle
    ? house.entities
        .filter(
          (e) => !e.hidden && !e.disabled && `${e.name} ${e.id}`.toLowerCase().includes(needle),
        )
        .slice(0, SHOWN)
    : [];
  const pick = (id: string) => {
    setOpen(id);
    setQuery("");
    input.current?.blur();
  };

  return (
    <div className="app-header-search">
      <label className="app-search">
        <Icon name="search" size={18} />
        <span className="app-sr">Search</span>
        <input
          ref={input}
          type="search"
          placeholder="Search lights, rooms, scenes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              input.current?.blur();
            } else if (event.key === "Enter" && found[0]) {
              pick(String(found[0].id));
            }
          }}
        />
        <kbd className="app-kbd" aria-hidden="true">
          {mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </label>
      {needle ? (
        <div className="app-search-found" role="listbox" aria-label="Matches">
          {found.length ? (
            found.map((entity) => {
              const view = entityView(house, entity);
              return (
                <div key={view.id} className="app-search-hit">
                  <button type="button" className="app-search-pick" onClick={() => pick(view.id)}>
                    <Icon name={view.icon ?? view.domain} size={18} />
                    <span className="app-search-name">{view.name}</span>
                    <span className="app-search-id">{view.id}</span>
                    <span className="app-search-state">{view.summary}</span>
                  </button>
                  <EntityControls view={view} />
                </div>
              );
            })
          ) : (
            <p className="app-muted">Nothing matches “{query.trim()}”</p>
          )}
        </div>
      ) : null}
      <EntityDetail entityId={open} onClose={() => setOpen(null)} onRenamed={setOpen} />
    </div>
  );
}
