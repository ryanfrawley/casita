# Design source

`tokens.json` is copied, unchanged, from the Casita design system artifact
(a private Claude artifact of the maintainer, version `1791169322-80db`). The logos under
`src/assets/` and the icon paths in `src/icon-paths.gen.ts` come from the same version.

To take a newer version: replace `tokens.json`, run `bun run ui:tokens`, and review the diff of
`src/styles/tokens.css`. Never edit a value here or in the generated file; change the design system.
