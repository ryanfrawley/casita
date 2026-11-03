# @casita/integration-rachio

Rachio irrigation controllers through Rachio's public cloud API.

## Owns

- `src/api.ts`: the REST calls and the daily request budget (3,500 a day per account).
- One switch per enabled zone (on runs it for `defaultRunMinutes`, off stops watering), a
  `schedules` switch for standby, `rain delay` and `rain sensor` binary sensors, and a `next run` sensor.
- Each zone carries when it was last watered and for how long, as attributes.
- Actions: `run_zone` (a chosen number of minutes), `stop_water`, `rain_delay`, `status`.

## Notes

- State comes from polling, since Rachio's webhooks need a server reachable from the internet.
  The poll interval is raised automatically so a day of polling fits the request limit.
- Needs internet access; when the limit is spent or the API is unreachable, entities go unavailable.

## Must not import

- Anything from the core except `@casita/core/types`.
