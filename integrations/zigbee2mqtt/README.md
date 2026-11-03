# @casita/integration-zigbee2mqtt

Zigbee devices through zigbee2mqtt's own MQTT topics.

## Owns

- `src/exposes.ts`: mapping a device's `exposes` metadata to entities.
- Device list from `<base>/bridge/devices`, state from `<base>/<friendly_name>`, commands to `.../set`.
- The `permit_join` action.

## Notes

- Devices are keyed by IEEE address, so a rename in zigbee2mqtt keeps the entity.
- Link quality and last-seen are attributes, not entities.

## Must not import

- Anything from the core except `@casita/core/types`. `@casita/mqtt-shared` is its transport.
