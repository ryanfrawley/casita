# @casita/ui

The Casita design system as React components. The source of truth for how things look is the
design system artifact named in `docs/web-ui-plan.md`; this package is its port.

## Owns

- `design/tokens.json`: copied from the design system; `scripts/tokens.ts` turns it into
  `src/styles/tokens.css`. `src/styles/`: tokens and base rules; pages import `@casita/ui/styles.css`.
- `src/fonts.ts`, `src/fonts/`: the three families; pages call `installFonts()` once.
- `src/icon.tsx`, `src/icon-paths.gen.ts`: `Icon` and the icon maps. `src/assets/`: the logos.
- `src/components/`: one file per component; its CSS is the file of the same name under
  `src/styles/components/`, copied from the design system and not edited by hand.
- `src/hooks.ts`, `src/time.ts`: what overlays share, and the content rules for time.
- `src/test-dom.ts`: the DOM harness for `*.dom.test.tsx`; everything else tests rendered markup.
- `gallery/`: every token and component in both themes (`bun run ui:gallery`).

## Rules

- Components keep the design system's class names (`ca-` prefix), props, and token use.
- Base components know nothing about devices or the house; compose, don't add domain props.

## Must not import

- Any workspace package. `tests/boundaries.test.ts` enforces this.
