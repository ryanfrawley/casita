# @casita/integration-mqtt

Devices that announce themselves with the MQTT discovery convention
(`<prefix>/<component>/[<node>/]<object>/config`), as Tasmota, Shelly, and DIY devices do.

## Owns

- Discovery parsing (abbreviations, `~`, `{{ value_json.<path> }}` templates).
- light, switch, sensor, binary_sensor, cover, and button entities, with availability topics.

## Notes

- `discoveryPrefix` defaults to `casita`; set it to `homeassistant` for devices left on their default.
- An entity whose state cannot be observed is skipped: state is never guessed.

## Must not import

- Anything from the core except `@casita/core/types`. `@casita/mqtt-shared` is its transport.
