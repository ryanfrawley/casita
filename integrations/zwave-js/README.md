# @casita/integration-zwave-js

Z-Wave through a Z-Wave JS server (zwave-js-server or Z-Wave JS UI), which owns the radio.

## Owns

- `src/client.ts`: the WebSocket protocol, pinned to schema version 35.
- `src/mapping.ts`: command classes to entities.
- `src/settings.ts`: configuration parameters as device settings, from the driver's metadata.
- `src/effects.ts`: LED effects, found among the partial parameters by what the driver calls their parts.
- Pairing without a UI: inclusion that answers the S2 prompts itself, SmartStart provisioning
  from a QR code, exclusion, removing a failed node, raw configuration parameters, and heal.

## Actions

| Action | Parameters | What it does |
| --- | --- | --- |
| `start_inclusion` | `pin?`, `qr?`, `timeoutSec?` (120) | Begins inclusion and waits for a node to join. With a `pin`, every security class the device asks for is granted; without one, S2 Authenticated and Access Control are withheld so the device joins at the level it can reach. With `qr` (an S2 QR code), the DSK comes from the code and nothing is asked. Returns `{ nodeId, securityClass, lowSecurityReason? }` once the node is added; its entities appear when the interview finishes and the node reports ready. |
| `stop_inclusion` | | Leaves inclusion mode; a waiting `start_inclusion` rejects. |
| `provision_qr` | `qr` | Provisions a SmartStart QR code. The device joins securely on its own when powered up. An S2 (non-SmartStart) code is refused with a pointer to `start_inclusion`. Returns the DSK, the classes, and whether the device supports Long Range. |
| `list_provisioned`, `unprovision` | `dsk?`, `nodeId?` | The SmartStart list and removing an entry. |
| `remove_failed_node` | `nodeId` | Removes a dead node; its entities go with it. |
| `get_config_parameter`, `set_config_parameter` | `nodeId`, `parameter`, `value`, `valueSize?`, `signed?`, `bitMask?` | Raw configuration parameters. `valueSize` (1, 2 or 4) is needed when the driver has no config file for the device. |
| `led_effects` | `nodeId` or `deviceId` | The LED effects the node's driver describes: each target (a parameter, such as `99` "All LED Strip"), and the range and named values of its fields. |
| `led_notify` | `nodeId` or `deviceId`, `effect`, `target?`, `color?`, `level?`, `duration?` | Shows an effect on a target, all its LEDs when there is a target for them and none is named. Each field takes a number or a name the driver gives it (`"pulse"`, `"indefinitely"`, `"red"`); a field left out keeps its value, except that a level or duration of 0 goes to its maximum. The whole parameter is written in one Configuration Set and read back. `effect: "off"` (or `"clear"` where the driver names it) ends it. |
| `start_exclusion`, `stop_exclusion`, `heal_network`, `stop_heal_network` | | As named. A heal (route rebuild) holds every other controller operation, including a joining node's interview, so stop it before including a device. |

Only the client that began an inclusion receives its S2 prompts, so another client (Z-Wave JS
UI) pairing at the same time does not get ours.

From the CLI, values are read as JSON: `--pin 12345` arrives as a number and is accepted, but a
digit-only QR code must be quoted as a string, `--qr '"9001..."'`, or it is read as a number and
loses digits.

## Device settings

Every Configuration CC value of a node is a device setting (`get_device_settings`, the device's
Settings page, `casita device settings`), described by the metadata the driver gives it: from the
device's config file when the driver has one, or from what a Configuration CC v3+ device says about
itself. A whole parameter is keyed by its number (`22`), a part by its mask (`99[0xff00]`), and on
another endpoint with the endpoint first (`2.5`). Options are a list when the driver allows nothing
else (`allowManualEntry: false`); exactly Disable/Enable (or Off/On) on 0 and 1 is on or off; a
parameter the driver marks read-only is a reading. The parts of a partial parameter share a heading
made of the words their labels have in common. A change goes through `node.set_value`, which keeps a
partial parameter whole; the settings update when the driver reports the parameter, and a burst of
reports for one parameter's parts is one `settings_changed`.

LED effects are found, not listed per model: a partial parameter is an effect target when one part's
label names an effect after the word "Effect" ("… Effect - Effect", "… Effect Type") and another a
color, level (brightness, intensity) or duration. That covers the Inovelli Red Series of both
generations (VZW31-SN's `64`–`99`, LZW31-SN's `16`, LZW36's `24` and `25`) and any other device a
driver config describes the same way. Each field's place comes from its part's mask, so byte order
differs freely.

## Notes

- Only `ready` nodes become devices; a dead node's entities are unavailable, a sleeping one's is not.
- Meter readings (energy, power by unit) and battery level are sensors; a meter's previous value,
  delta time and reset are not.
- zwave-js is never embedded in-process.

## Must not import

- Anything from the core except `@casita/core/types`.
