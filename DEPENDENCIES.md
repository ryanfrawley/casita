# Dependencies

All dependencies must be MIT, BSD, Apache 2.0, or ISC. Note any exception here before adding it.

| Package | License | Used by |
| --- | --- | --- |
| zod | MIT | config, API messages, integration schemas |
| smol-toml | BSD-3-Clause | core config store (TOML parse and write) |
| croner | MIT | core scheduler (cron) |
| pino | MIT | core logging |
| mqtt | MIT | integrations/mqtt-shared |
| commander | MIT | CLI |
| protobufjs | BSD-3-Clause | integrations/esphome (message encoding) |
| @noble/ciphers | MIT | integrations/esphome (ChaCha20-Poly1305 for Noise) |
| react, react-dom | MIT | packages/ui, packages/web |
| jsqr | Apache-2.0 | packages/web (QR codes from the camera) |
| codemirror, @codemirror/* (state, view, language, commands, autocomplete, lint; with @lezer/* and style-mod, w3c-keyname, crelt) | MIT | packages/web (the Casa page editor) |
| @biomejs/biome | MIT OR Apache-2.0 | lint / format (dev) |
| typescript | Apache-2.0 | typecheck (dev) |
| @types/bun | MIT | types (dev) |
| @types/react, @types/react-dom | MIT | types (dev) |
| happy-dom | MIT | DOM for packages/ui component tests (dev) |
| aedes | MIT | in-process MQTT broker for tests (dev) |

## Vendored files

`integrations/esphome/proto/*.proto` are copied from esphome/esphome (MIT for non-C++ files); see
`integrations/esphome/proto/README.md` for the commit.

`packages/ui/src/fonts/*.woff2` are copied from the Fontsource packages (version 5.3.0):
`@fontsource-variable/fraunces`, `@fontsource-variable/figtree`, `@fontsource/jetbrains-mono`; latin
and latin-ext subsets only.

`packages/ui/src/icon-paths.gen.ts` holds icon paths from Lucide (ISC), by way of the design system.

## Exceptions

- Fraunces, Figtree and JetBrains Mono are under the SIL Open Font License 1.1, which is not on the
  list above. They are fonts, served as files and not linked into code, and the design system names
  them; serving them ourselves is what lets the UI work with no internet.
