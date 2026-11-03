# ESPHome native API definitions

`api.proto` and `api_options.proto` are copied unmodified from
[esphome/esphome](https://github.com/esphome/esphome) at commit
`fb65096ea3dc4cccf53681b501dec01fd2ec9538` (`esphome/components/api/`). ESPHome licenses
everything that is not C++ runtime code, including these files, under the MIT license.

`src/api.gen.ts` is generated from them and committed. To update: replace the two files, set the
commit hash in `scripts/generate.ts`, and run `bun integrations/esphome/scripts/generate.ts`.
