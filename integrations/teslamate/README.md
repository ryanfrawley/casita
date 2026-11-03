# @casita/integration-teslamate

Tesla vehicles as TeslaMate reports them, read-only, from TeslaMate's MQTT topics
(`<base>/cars/<id>/<topic>`). TeslaMate talks to Tesla; this integration never does.

## Owns

- One device per car, and an entity for each mapped topic that TeslaMate publishes: battery, range,
  charging, temperatures, odometer, state, location (with coordinates as attributes), doors,
  windows, climate, sentry mode, and a read-only lock.

## Notes

- TeslaMate must have MQTT enabled (`MQTT_HOST`), and its broker must be reachable from here.
- Units are TeslaMate's: km, kW, °C.
- For a broker behind mutual TLS, set `caFile`, `certFile`, and `keyFile` with an `mqtts://` URL.

## Must not import

- Anything from the core except `@casita/core/types`. `@casita/mqtt-shared` is its transport.
