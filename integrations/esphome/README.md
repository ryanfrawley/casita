# @casita/integration-esphome

ESPHome devices over their native API, without an MQTT hop.

## Owns

- `src/proto.ts`, `src/api.gen.ts`: plaintext framing and protobuf messages (generated; see `proto/`).
- `src/noise.ts`: Noise_NNpsk0_25519_ChaChaPoly_SHA256 for encrypted devices.
- `src/device.ts`: one device's session, reconnect with backoff, keepalive.
- `src/mdns.ts`: discovery of `_esphomelib._tcp`.

## Notes

- Devices are listed under `[[integration.devices]]` and/or found with `discover = true`.
- A device that is unreachable does not fail the instance; it is retried on its own.

## Must not import

- Anything from the core except `@casita/core/types`.
