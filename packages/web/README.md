# @casita/web

The web app: a client of the WebSocket API, like the CLI, built from `@casita/ui`.

## Owns

- `index.html`, `src/main.tsx`: the entry.
- `src/store.ts`: what the app knows about the house. `reduce` is pure; `createStore` connects,
  loads, subscribes, reconnects and sends commands. A command marks its entity pending and the
  state changes only when the device reports it: nothing is shown ahead of the house.
- `src/model.ts`: pure functions from the house to what a screen shows: rows, a room's facts,
  command intents, history for charts.
- `src/casa/`: Home is a Casa page. `host.ts` is what a page reads the house through, with each
  read stamped so a property re-evaluates only when something it read changed; `render.tsx` mounts
  the compiled tree; `builtins.tsx` draws each built-in with a `@casita/ui` component;
  `language.ts` and `editor.tsx` are the source pane (CodeMirror), `page.tsx` the page screen.
  The compiler itself is `@casita/core/casa`, and runs in the browser for the editor's preview.
- `src/context.tsx`, `src/controls.tsx`, `src/shell.tsx`, `src/detail.tsx`, `src/pages/`: the
  screens. They hold no rules of their own: wording comes from `@casita/client`, layout from the model.
- `build.ts`: builds into `dist/` (`bun run web:build`). `dev.ts`: rebuilds on change
  (`bun run web:dev`), with `bun run start` serving the result.

## Checking it by hand

There is no browser test in the suite. After a change to a screen, with `bun run start` and
`bun run web:build`:

1. Sign in; reload and still be signed in; sign out.
2. On Home, turn a light on: the row reads "Turning on…" and only then "On". Open its details and
   see its history.
3. Rename an entity from its sheet and see the sheet follow it; add and remove an area.
4. Run an integration action; add a user, grant them Read on something, and sign in as them: the
   thing is shown with "View only" and nothing else is there.
5. Narrow the window under 860px, and switch Day and Night.
6. On Home choose "Edit page". Add a `Text` naming an entity's state and see it in the preview as
   you type; misspell an enum member and see the problem inline with Save disabled; flip a switch
   from the preview and see the house follow. Save, go back to Home and see the change; open
   Versions and revert. In Settings start a theme, change a palette colour and watch the
   preview recolour; save, and pick it in the sidebar.

## Must not import

- Anything in the workspace except `@casita/ui`, `@casita/client`, `@casita/api/schema` and
  `@casita/core/casa`.
  `tests/boundaries.test.ts` enforces this, and that nothing needing Bun or Node is pulled in.
