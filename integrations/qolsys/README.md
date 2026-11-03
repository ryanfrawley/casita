# @casita/integration-qolsys

A Qolsys IQ Panel (IQ Panel 2+, IQ Panel 4; sold by ADT as "ADT Command") over its local
Control4 interface. No Alarm.com account or dealer service is involved: the panel keeps owning
its sensors, arming and siren, and this integration mirrors them on the LAN.

## Setting up the panel

With the dealer code (Qolsys ships 2222): Settings, Advanced Settings, Installation.

1. Installer Settings: turn on **6 Digit User Code**; the interface refuses shorter ones.
2. User Management: add a user for Casita with its own six-digit code, so it can be revoked
   alone and the panel's log names it.
3. Devices, Wi-Fi Devices, 3rd Party Connections: enable **Control4**, then **Reveal Secure
   Token**.

Give the panel a DHCP reservation; its address is `host`.

## Owns

- `src/client.ts`: the socket. TLS on port 12345 with the panel's self-signed certificate,
  one JSON object per line, `ACK` lines dropped.
- `src/mapping.ts`: zone types to binary-sensor classes, partition status words to a state.

## Entities

- Each zone is a device behind the panel with one `binary_sensor`: `door` or `window` for a
  door-window zone by the word in its name, else by group (entry/exit is a door, instant
  perimeter a window); tilt sensors are doors; `motion`, `smoke`, `leak`; glass breaks, CO
  detectors, panic buttons and the like have no class. Takeover modules (the translators that
  bring hardwired sensors in), keypads and sirens are the panel's plumbing and get no entity. `on` is Open or
  Active. The panel's own words travel in the attributes (`type`, `group`, `status`).
- Each partition has a `sensor` whose value is `disarmed`, `armed_stay`, `armed_away`,
  `arming` (exit delay), `entry_delay` or `alarm` (with `alarmType` in the attributes), and two
  switches, **Armed stay** and **Armed away**. Turning one on arms that mode; turning either off
  disarms. A switch reads on from the start of its exit delay, which is when the panel has
  accepted the request. A wrong user code arrives as an ERROR event, logged as a warning; the
  command then goes unconfirmed.
- With one partition the entities are `Alarm`, `Armed stay`, `Armed away`; with more, the
  partition's name is prefixed.

## Actions

| Action | What it does |
| --- | --- |
| `refresh` | Asks the panel for its summary again. It is also polled every `pollSeconds` (60), which keeps the connection alive. |

## Notes

- The panel does not confirm commands; it reports the result as `ARMING`, `ALARM` or `ERROR`
  events. An exit delay older firmware reports as plain `EXIT_DELAY` is attributed to the mode
  last asked for.
- Triggering an alarm from software is deliberately not offered.

## Must not import

- Anything from the core except `@casita/core/types`.
