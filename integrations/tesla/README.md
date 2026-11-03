# @casita/integration-tesla

Tesla vehicles through the official Fleet API. Read-only for now.

## Owns

- `src/api.ts`: OAuth tokens, partner registration, vehicle list and `vehicle_data`.
- Per vehicle: battery, range, charge limit, charger power, time to full, inside and outside
  temperature, odometer, charging, plugged in, awake, and a read-only door lock.
- Actions: `authorize_url`, `complete_authorization`, `register_partner`, `refresh`, `status`.

## Setup

1. Create an application at developer.tesla.com; put its id, secret, and redirect URI in config.
2. Host the app's public key on your domain, then run `register_partner --domain <domain>` once.
3. Run `authorize_url`, log in, and pass the `code` from the redirect to `complete_authorization`.

## Notes

- Tesla bills each data request and a car that is polled often never sleeps, so the default is one
  read every 30 minutes and a sleeping car is never woken.
- Refresh tokens are single use; the current one lives in integration storage, not in config.
- Commands (lock, climate, charging) are not implemented: they need requests signed with the
  app's private key, via Tesla's vehicle-command protocol or its HTTP proxy.

## Must not import

- Anything from the core except `@casita/core/types`.
