# @casita/integration-lamarzocco

La Marzocco espresso machines (Linea Mini R, Micra, Mini, GS3) through La Marzocco's cloud, the
same one the La Marzocco app uses. Signs in with the app account's email and password.

## Owns

- `src/signing.ts`: the per-installation P-256 key and the request proof and signature every
  request carries. The key is made on first start, registered once at `/auth/init`, and kept in
  the instance's storage under `installation`.
- `src/api.ts`: sign-in and token refresh, the machine list, a machine's dashboard, commands,
  and the dashboard's STOMP socket (`src/stomp.ts` frames it).
- Per machine: a `power` switch (on is brewing mode, off is standby), a `ready` binary sensor
  (the coffee boiler is at temperature), a `ready at` sensor (while heating, the time the
  machine expects to be ready, as "7:42 am", with the epoch ms in its `at` attribute), and,
  where the steam boiler can be switched, a `steam` switch and a `steam ready` binary sensor.
- The power switch carries the machine's `status`, `mode`, `brewing`, `brewingSince`,
  `targetTemperature` and `noWater` as attributes.
- Actions: `refresh` (reads the dashboard now), `status` (whether each machine's socket is up).

## Notes

- State arrives on the dashboard socket within seconds. While the socket is down the dashboard
  is read every `pollSeconds` and the socket is retried with backoff; while it is up the
  dashboard is still read every ten minutes, in case the socket went quiet without closing.
- Endpoints, payloads and the signing scheme follow pylamarzocco (MIT), which reads them from the
  app. La Marzocco publishes no API, so a change on their side can break this.
- If La Marzocco asks for a new privacy policy to be accepted, setup fails saying so; accept it
  in the app.
- Needs internet access; a machine that is offline with the cloud is unavailable.

## Must not import

- Anything from the core except `@casita/core/types`.
