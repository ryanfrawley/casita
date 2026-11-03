# @casita/mqtt-shared

The MQTT connection layer shared by the generic MQTT and zigbee2mqtt integrations.

## Owns

- `connectMqtt`: connect with reconnect, per-filter handlers, publish, connection changes.
- `mqttConfigFields`: the broker fields both integrations take.
- `./testing`: `FakeBroker`, an in-memory stand-in with retained messages.

## Must not import

- Anything from the core except `@casita/core/types`.
