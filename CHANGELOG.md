# Changelog

## November 2026

- La Marzocco espresso machines, through La Marzocco's cloud (`type = "lamarzocco"`, the app
  account's email and password). Each machine has a power switch (brewing mode or standby), a
  `ready` sensor that turns on when the coffee boiler reaches temperature, a `ready at` sensor
  with the time it expects to while heating, and, on a Mini R or Micra, a steam switch and
  `steam ready`. Changes arrive on La Marzocco's live socket within seconds, with polling while
  it is down, so an automation can say when the coffee is ready.
- Opening Automations, Sensors, Settings or Users straight from its address no longer says
  "Not connected to the house right now": a request made while the app is still connecting
  waits up to ten seconds for the connection instead of failing at once. A command still
  fails at once while disconnected, so nothing tapped fires late.
- An automation can be tested: Test in its editor (or `casita automation test`) runs a handler
  now, as if its trigger had fired, against the house as it is, so a weather-to-LED
  automation shows the real outlook on the switch straight away. A value can be pretended for
  the run (`weather.home#conditionNext12h` as `thunderstorm`, `sensor.outside` as `-3`) to see
  what it would do. What a test sends is real; it runs the saved version, enabled or not, and
  appears in the run log as a test. `test_automation` in the API, admins only, audited.
- Comparing an entity or attribute with a plain value (`weather.home#rain == "x"`) is an
  error now, E030, pointing at `.value`: it compared the reference itself, so it was never
  true and the branch under it could never run.
- The Open-Meteo weather entity has a `conditionNext12h` attribute: the most severe sky from
  now through the next twelve hours, ranked from clear through cloud, fog, wind, drizzle,
  rain, pouring, snow and hail to thunderstorm and tornado, so a clear morning before an
  afternoon of rain reads `rain`. An automation can trigger on it changing and show it on a
  switch's LEDs.
- An automation can run an integration's action with `run`, such as an LED effect on a switch
  while the garage door is open:
  `run zwave_js.main.led_notify { deviceId: device.kitchen_dimmer, effect: "pulse", color: 0 }`.
  The instance is written with `_` for the `-` in its type. The editor knows each running
  integration's actions and checks the names, required parameters and their types as it does a
  command's; a device, area or entity given for a text parameter is sent as its id. `run` is
  for server handlers only, and the run log lists what each firing ran and whether it failed.

## October 2026

- A device's settings have a page of their own, reached from its sheet or any of its entities'
  sheets with Settings: everything its integration says can be adjusted, one card per section,
  each with the control its kind takes (a switch, a list, a number with its range). A change is
  sent at once and shows pending until the device reports it; a changed setting says what it is
  normally and offers to put it back; one that is hard to undo, such as a factory reset, asks
  first. Admins only. `get_device_settings` and `set_device_setting` in the API (the core checks
  every value against the setting before an integration sees it, and `settings_changed` says a
  device reported new values), `casita device settings` and `casita device setting` in the CLI,
  and `provideDeviceSettings` and `settingsChanged` for an integration.
- Z-Wave devices' configuration parameters are their settings, read from what the Z-Wave JS
  driver says about each one, so every device with a driver config file (or Configuration CC v3)
  has its own labels, ranges and options without Casita knowing the model.
- `led_notify` shows an LED effect on a Z-Wave switch, such as a red pulse on an Inovelli Red
  Series bar until it is cleared, from names as well as numbers (`effect: "pulse"`,
  `duration: "indefinitely"`); `led_effects` lists what a device has. Effects are found among a
  device's parameters by how its driver labels them, so both Red Series generations and the
  fan/light switch work, each with its own parameter numbers and byte order.

- The weather outside has depth: it falls behind the greeting's words and in front of them.
  Cloud has body, lit from above and shaded under, gathering along the top and thinning
  down; fog and haze fill the head with it and soften the words, the large ones most, as
  if the small ones were nearer. A hailstone strikes the bottom and bounces before it goes.
- Rows side by side in a card, in a `Grid` of two or three columns, are divided as a list's
  are: a line between the grid's rows and one running between its columns.
- The weather outside falls behind the greeting, faintly: rain streaks in the sky accent,
  snow drifts in ink, stars twinkle on a clear night, and a thunderstorm flickers now and
  then. It holds still where motion is asked to be reduced and pauses in a hidden tab.
  `Forecast` draws the same over its card with `effect`.
- A `History` in a card is one grid unit exactly for a state bar (a 16px label, the 20px bar,
  its 20px axis) and three for a chart, drawn 150px tall, so the card stays on the grid
  instead of being padded under its last block.
- Changing the range in an entity's history keeps the last chart up, faded, until the new
  one arrives, instead of swapping in a placeholder and back; the placeholder before the first
  load is the size of what is coming.
- A `ButtonGroup` that ends a card runs to the card's edges: a strip of segments flush with
  the sides and the bottom, parted by hairlines, with no track of its own, starting at the
  line over it and taking the room under that line into itself.
- An area's heading sits at the bottom of its unit, by the cards it names. A card with a body
  has a head half a step taller, 12px above and below its title, with a line the card's
  whole width at its edge and 8px from the line to the first block, so the title sits in the
  middle of the room over the line and the blocks keep to the grid; a card that is its head
  alone keeps the 56px head and draws no line. A row with a dimmer under it is the same. `History` and `Timeline` take a `duration`
  (`6h`, `3d`) that says how far back the bar reaches, in place of `range`.
- A light that dims has its slider whether it is on or off, so its card is the same height
  either way and nothing moves when it is switched.
- A `Map`'s `height` is rounded up to whole grid units (150 draws as 200), so the card it is
  in stays on the grid with no slack under its last block.
- A `SunPath` alone in a `Card` runs its plot to the card's edges; its heading keeps the
  card's side padding, and the block has a little room above the heading and under the times.
- A `Map` is three grid units tall by default (200px), its edge drawn inside, so a card with
  one has no slack to spread; what slack a card has stays under its last block, and a
  `ButtonGroup`, `Segmented` or `Button` in a body sits at the top of its unit.
- A card that is one row draws the gutter, line and dimmer under it only for a light that
  dims and is on; a switch, a door or a light that is off is the row alone. A `Button`,
  `ButtonGroup` or `Segmented` in a card's body stands in a unit of its own, in the middle of it.
- A `SunPath` alone in a `Card` fills the card, its plot growing with it, so beside a taller
  card in a `Grid` (three `Scale`s, say) the two stand the same height.
- Everything on a page stands on a grid: 56px blocks with a 16px gutter between them, a 72px
  pitch, the same inside a card as between cards, so the rows of one card line up with the
  cards beside it. A heading (an area's, a card's, a section's, a chart's, the Recent list's),
  a row, a dimmer, a strip of stats, a bar, a Scale, a control and a line of status are one
  block each, their content in the middle; a map is three, a SunPath, a LevelMeter, a
  Thermostat's reading and the greeting two; a Forecast's days are half a block each. Day and
  Night's `divider.space` is 8, so the line between two blocks runs through the middle of their
  gutter, and every line that was a border is drawn inside its box, so no line adds a pixel.
  Cards in an area are a gutter apart, and a Stack or Grid with no `gap` puts a gutter between
  its children (a Row stack still `space.md`). A card whose content is not made of blocks (a
  paragraph, a chart) is let down to the next whole number of them, so the cards beside it
  still line up. The design tokens gain `grid-unit`, `grid-step` and `grid-pitch`.
- A state timeline's off segments are drawn in the faint line's tone, a step darker than the
  card they lie on, which they had matched since the card became the well.
- An area's heading is its name alone, at 28px: no icon beside it and no count of devices and
  entities under it. `AreaHeader` still takes the area, name and icon, so a house's own can
  draw them. Day and Night's `room.name.size` is 28; October's stays 26.
- A card is the well now, not the room: the sunken surface with no edge and no shadow, and an
  `Area` is its heading and its cards on the page itself, with no well of its own. The icons
  stand raised on a card, a card's and a row's alike, as a room's arch does. A row takes the
  surface it lies on. The cards in a room stand 12px apart down and 16px across, and rooms 16px
  apart; the rest of the page is as it was. Day and Night say so in `surface.card` and
  `card.icon`; October keeps its raised, edged, floating cards. A house theme that sets
  `surface.card.background` still wins.
- An `Area` with an `of` is headed by that area's own name and icon again, without writing
  them; `name:` and `icon:` replace either, and `header: false` leaves the heading out. An
  `Area` with no `of` still draws only the parts it is given. The generated `AreaCard` is back
  to `Area { of: of  facts: facts … }`.
- An `Area` takes its area as `of`, as every other built-in takes what it is about:
  `Area { of: area.hall  name: area.hall.name  icon: area.hall.icon }`. `area:` is an error
  that says so, and the generated `AreaCard` writes `of`.
- Casa's `Room` is `Area` now, and `Room` is an error that says so. An `Area` draws its
  heading only when asked: `name:` puts up the title and what is in the area, `icon:` the
  icon, and with neither (nor a `header:`) there is no heading row at all, so no title, chips
  or Turn off lights, only the cards. `Area { area: a  name: a.name  icon: a.icon }` is the
  old look. The heading component is `AreaHeader`, given the area, name and icon; a house's
  own `RoomHeader` still draws it, with a warning to rename it. A lit area icon is the lamp's
  soft tint, not the lamp. New houses are generated with an `AreaCard` that names both. A
  saved page that uses `Room` no longer compiles: it shows "Unknown node Room" in place of
  each one until it is edited to `Area` and saved.
- Day and Night draw cards with no shadow, controls with a hairline edge, and card titles at
  500, so the quieter cards and controls reach Casa pages: those take the theme's `surface`
  and `card` values, which had kept the old shadow, strong edge and bold title.
- A `Grid` with no `gap` puts its columns `space.xl` apart (24px by default), its rows still
  `space.md`, so blocks side by side (a `SunPath` beside its `Scale`s, room beside room) no
  longer run together. A given `gap` is both ways, as before. The cards in a room stand 24px
  apart across, 16px down.
- Cards, rows, toggles and buttons are quieter, in the bars' manner. What is on is lit with a
  tint of its accent and the icon in it, not a solid fill: a room's, a card's, a row's and a
  device's icon, and a tile that is on. A toggle is an outline with a muted knob, and on, the
  track tinted and the knob a dot of the accent. A ButtonGroup's chosen segment, a
  SegmentedControl's and a PillGroup's are tinted, not filled; their edges, a Stepper's and a
  secondary button's are the faint line. Cards lose their shadow and have a fainter edge. A
  pending outline is 1px. Titles, values and stats are set at 500, not bold. A theme's
  `surface` and `card` settings still win over all of it.
- Every bar is drawn as `Scale` is now: a slider, a level read, a `LevelMeter` and a `RangeBar`
  are a faint line across their range in their tone, a bold one as far as the value, and a
  small haloed dot at it (a slider's thumb, the meter's level, the range's marker). An
  unavailable one is a dashed line; a meter's target is a short muted tick. A slider's value
  is no longer bold.
- `Scale` is quieter, drawn as `SunPath` is: the whole track a faint line in its bands'
  colours, a bold one only as far as the reading, and the reading a small dot in its band's
  colour, haloed like the sun. The band's word is a muted aside after a dot of that colour, in
  place of a pill.
- `SunPath` is the sun's true height through the day now, worked out from where the house is
  (Open-Meteo's weather carries its `latitude` and `longitude`), so the curve runs smoothly
  through sunrise and sunset where it had a corner at each. Below the horizon it is eased, a
  night 50° deep drawn shallower than it is, with the same slope at the horizon. Run a pointer
  or a finger along it and the heading reads the time there and the sun's angle ("2:02 pm ·
  Sun 35° up"); at rest it says the sun's angle now beside the daylight. The day is the
  house's, midnight to midnight, 23 or 25 hours when the clocks change. Without a place the
  curve is a cosine through sunrise and sunset and no angle is shown.
- `SunPath` draws the whole day now: the sun's height as a curve across it, a wave over the
  horizon by day and a shallower one under it by night, at a fixed 72px height that stretches
  to any width. The sun rides it, a ring below the horizon after dark; the way it has come is
  in lamp by day and muted by night; sunrise and sunset sit under where the curve crosses the
  horizon; a line over it says what comes next ("Sunset in 2h 10m · 10h 46m of daylight"). It
  was an arc that grew with its cell, and at night an empty one.
- `Scale` draws one track through its bands' colours, blended, with a dot at the reading, in
  place of separate faint bands that read as mud on a dark theme; without a reading the track
  is grey. The band's word sits beside the scale's name, the value alone on the right. Its label defaults to the scale's name ("PM2.5", "UV index", "Air quality"), not the
  sensor's ("Weather PM2.5").
- The weather beside the greeting says what it feels like when that differs by 2° or more:
  "Partly cloudy · Feels 58° · H 76° L 46°".
- Casa gains `SunPath { weather: weather.weather }`, the day as the sun's arc over the
  horizon: walked in lamp as far as the sun has gone, with sunrise and sunset under its ends
  and the daylight left; at night the arc waits and says when the sun is up. And
  `Scale { of: sensor.weather_pm2_5  scale: .PM25 }`, a reading on its health bands (`.UV` by
  the WHO's; `.PM25`, `.PM10` and `.AQI` by the US EPA's; `.EAQI` by the EEA's): a band per
  step, equal in width, the reading's lit, a marker at the reading and the band's word
  ("Moderate"). `SunPath` and `ScaleBar` in `@casita/ui` draw them; the bands and their words
  are in `@casita/client` (`SCALES`, `placeOn`).
- A sensor whose word names a moment (Open-Meteo's sunrise and sunset, "7:29 am") no longer
  appends when it became so: it read "7:29 am · 12:10 am".
- Every Casa editor (pages, shared components, themes, automations, derived sensors) formats
  the source when it saves, and a Format button beside Save does it on demand: two spaces of
  indent per open bracket, one space around operators and after commas, two between the
  properties and nodes that share a line, at most one blank line. The line breaks and
  comments are the writer's. A source that does not parse is left as it is (Format says so),
  and a result that would not parse to the same tree is never used, so formatting cannot
  change what a page does. `formatSource` is in `@casita/core/casa`; `lex` keeps
  comments and every line break when given `{ trivia: true }`.
- Casa gains `Map { of: sensor.model_3_location  zoom: 15  height: 200 }`: a still map of where
  an entity is, from the `latitude` and `longitude` its state carries (TeslaMate's car
  location does), with a pin that points along its `heading`. `latitude` and `longitude`
  written on the Map are a fixed place, or where to look while the entity has none; `zoom`
  is 0 to 19 and `marker: false` drops the pin. A Map with no place, half a place or a zoom
  the tiles lack is E038. The tiles are OpenStreetMap's standard ones, fetched by the browser
  (no key, no account; the page's policy now allows images from `tile.openstreetmap.org`),
  darkened under a dark theme, with the attribution OpenStreetMap requires opening the place
  there. `MapView` in `@casita/ui` is the component, and draws only the tiles in sight.
- A sensor whose value is a word (`asleep`, `Secured`, a derived sensor of `type: String`)
  says when it became so, as a binary sensor does: `Secured · 3 h`, in its row, the CLI and
  Casa's `present(e)`. A number is a reading and still reads alone.
- A sensor or binary sensor can be told what it is: a binary sensor its integration left
  unclassed, which read On and Off, is a Window and reads Open and Closed. The entity's
  settings have a Kind field (each binary class names its words, `Window · Open / Closed`);
  `update_entity` takes `deviceClass`, null for the integration's again, and the CLI
  `casita entity set … --class window` (`default` to clear). The class is written into every
  state the entity reports, so its row, history, the CLI and Casa all read it, and a change
  shows at once without moving "changed … ago".
- Casa gains `ButtonGroup { of: [cover.garage_left, cover.garage_middle, cover.garage_right]
  labels: ["Left", "Middle", "Right"] }`: one segment per entity in a single track, each lit
  in the card's accent while its entity is on or open, by the device's word alone. A light or
  switch toggles and a button presses on one tap. A door opens or closes on two: the first
  arms the segment, which reads "Open?" or "Close?" for four seconds, and the second sends
  it. While a door moves, its segment shows pending and a tap stops it. Its `of` takes
  covers, switches, lights and buttons, checked item by item (E012). `ButtonGroup` in
  `@casita/ui` is the control, with the arming its own.
- A Row in a Grid in a card's body lines up with the card's other blocks and no longer brings
  its own underline: in a one-column Grid the rows are a divided list, the line halfway up the
  gap and none after the last; side by side they are cells with the gap alone between them.
  The last row of an irrigation card drew a line under itself before.
- Casa gains `filter(list, (x) => …)`, the items a lambda says yes to: the lights in a room
  are `count(filter(area.kitchen.entities, (e) => e.domain == "light"))`.
- A device's id is a slug of its name, `thermostat` or `model_3` with `_2` on a collision,
  where it was a random `dev_3f9a1c2b7e4d`; Casa says `device.thermostat.entities` and the
  address `/devices?open=thermostat`. The id is taken at discovery and kept through a rename,
  as an area's is; an admin changes it with `newId` on `update_device`, the Device id field
  on its sheet, or `casita device set … --id`. Its entities and the devices behind it follow,
  and there is no alias: a page or automation that named the old id is rechecked and says so.
  On the first start, every random id becomes a slug and every stored Casa source that named
  one, versions included, is rewritten to the new id, so nothing arranged stops compiling.
- Derived sensors: a `sensor` declaration is a fifth kind of Casa file beside `theme`,
  `component`, `page` and `automation`. It names its `input`s (an entity or a list of them),
  a `name`, a `type` (`String`, `Number` or `Bool`) and a `value`, an expression over the
  inputs alone (E070 names anything else: a bare entity, the house, the clock); a Number may
  carry a `unit` and a Number or a Bool a `class` (`.Temperature`, `.Door`…). The server
  keeps it as an entity of the `casa.sensors` integration, `sensor.<id>` or
  `binary_sensor.<id>`, computed whenever an input changes and unavailable while one is: it
  has a history, a row, a timeline, and automations and pages read it like any other. The
  list sits under the automations with "New sensor" templates (a door and its lock as Open,
  Unlocked or Secured; the same as yes or no; an average), and the editor shows each input's
  reading beside the value it makes. `get_sensors`, `get_sensor_source`, `check_sensor`,
  `save_sensor`, `revert_sensor`, `delete_sensor` and `set_sensor_enabled` in the API;
  `casita sensor …` in the CLI. The language gains `avg` and `sum` over a list.
- A binary sensor's history reads as its row does: a door's timeline is Open and Closed, a
  leak sensor's Wet and Dry (in the alert tone), where it said On and Off. The words live in
  `binaryWords` in `@casita/client`, which the row, the web history and the CLI chart share.
- A Casa `Card` written with no body is its heading alone, for a card whose subtitle says
  everything; it no longer reads "Nothing on this card.", which a card whose `for` left it
  empty still does. `WidgetCard` takes `emptyText: null` for the same.
- Every Casa node takes `valign: .Top | .Center | .Bottom` beside `align`: inside a Grid,
  where it sits on its cell's height, which is the row's. Left out, it fills the cell as
  before. A button beside a two-line heading sits halfway down it with `valign: .Center`.
- A row `Stack` keeps to one line: its text gives way while an icon or a button keeps its
  size, as the design system's card head does, where it wrapped its children onto a new
  line as soon as they outgrew it (a card's titles dropping under its icon when the subtitle
  grew a word). `wrap: true` lets a row break as before. `justify: .Start | .Center | .End |
  .Between` places the children along a Stack; `.Between` puts a heading's button at its far
  end with no Grid.
- A card's heading fills the head whether or not the card is `of` something; a header
  component's `justify: .Between` was only given the room when the heading was a button.
- A Casa `Button` is busy from its press until its handler's commands and its own entity's
  press have been answered: a spinner in its icon's place, and presses ignored meanwhile, as
  a toggle is pending until the device reports. `Button` in `@casita/ui` takes `busy` for it
  (ahead of the design system).
- New integration `qolsys`: a Qolsys IQ Panel (sold by ADT as ADT Command) over its local
  Control4 interface, with no Alarm.com account. Each zone is a device behind the panel with a
  `binary_sensor` (door, window, motion, smoke, leak by zone type); each partition has an
  `Alarm` sensor (`disarmed`, `armed_stay`, `armed_away`, `arming`, `entry_delay`, `alarm`)
  and `Armed stay` / `Armed away` switches that arm with the configured user code and disarm
  when turned off. Zones added, renamed or deleted on the panel follow; the summary is polled
  every `pollSeconds` as a keepalive; action `refresh`.
- Automations are written in Casa and edited in the app; the `automations/*.ts` files are no
  longer loaded. An `automation` declaration is a fourth kind of file beside `theme`,
  `component` and `page`: a PascalCase name and nothing but handlers (`on … changed`, `every`,
  `at`), each run on the server as `automation:<id>`. "New automation" on the Automations
  page names it and starts it from a template (blank, a motion light, a schedule, one thing
  following another) filled with the entities picked there, so the first save compiles; the
  editor is the page editor's, with problems and handlers under the source and the recent
  runs on the right: what fired, what it sent, what was refused and what it armed. An
  automation can be switched off and on without touching its source, deleted, and reverted
  to any saved version. The list shows each automation's status, and a page that has handlers
  beside them.
- Inside an automation, a firing of any handler cancels every timer the automation has
  pending (a page's handlers keep cancelling only their own), a firing that is overtaken
  while one of its commands is in flight arms nothing, every timer a firing armed is cancelled
  by the next rather than only the last, and a save that leaves the handlers as they were
  keeps the timers running. An entity an automation names that is gone marks it `error` until
  it is back. A restart still drops pending timers.
- The grammar takes `else if`, and `else` may start a line. A lambda's own parameter (`any(
  entities, (e) => …)`) is readable in a server handler, where it was refused with E050.
- New: `get_automation_source`, `check_automation`, `save_automation`, `revert_automation`,
  `delete_automation`, `set_automation_enabled`, `get_automation_runs`; `get_automations`
  returns Casa automations and pages with handlers; `reload_automation` is gone; event
  `automation_changed`; `casita automation list|source|check|save|revert|delete|enable|
  disable|runs`; migration 011 (`automations`, `automation_versions`); `server.automationsDir`
  is no longer a config key. `defineAutomation` and `AutomationApi` are gone from the core.

- `span` on a card in a Room works as it does in a Grid: a Room's cards sit in the area's
  grid, which fills as many columns as fit the room, and the count the browser settles on is
  now what a span is measured against, so `Card { span: 3 }` takes the whole row of a room
  two columns wide. Before, a span inside a Room was ignored.
- A card says what it is of, and its heading opens that: `Card { name: "Terry"  of:
  device.dev_abc123 }` opens the car's sheet from the heading, as an entity row does from its
  face; `of` takes an entity, a device or an area. A card that is one row and is of a device
  opens the device rather than its one entity. The page's sheets are the same three the
  editor's are, with the same drill-down from a device or area to an entity.
- Escape closes the open sheet or dialog from anywhere on the page, where before it only did
  while the sheet held focus, so one opened from the editor, or left for the page behind it,
  kept standing. With one over another, the top one closes first. A key an editor or an open
  list has used already is left to it.
- A sensor that reports words (a car that is online, asleep or driving) has a history: a
  timeline with each word a state, in the order the words first appear, where before only a
  sensor reporting numbers was drawn and a text one said "Nothing recorded in this range".
  The same timeline draws on a card's `History` and on the History page.
- An entity row opens its details when its face is pressed, where before a chevron at its end
  did: the icon, the name and the reading are one button up to the row's controls, so a toggle
  or a slider still works on its own. `EntityRow` takes `onOpen`, and so does `EntityCard`:
  a card that is one row opens its details from its heading's icon and name the same way,
  and no chevron is drawn anywhere.
- On a device's sheet, and an area's, each entity row opens that entity's sheet over it;
  closing it comes back to the device or the area. Before, the rows on the Devices page's
  sheet did nothing.
- In the page and components editors, resting the pointer on an entity, device or area
  (`light.hall`, `device.dev_1`, `area.living`) shows what the house knows of it: its name,
  its state or maker, the area it is in, the device it is on, what is in it. One the house
  has no such id for says so, beside its error (E010) and its red line. ⌘-click (Ctrl-click
  elsewhere) on a reference, or the tooltip's link, opens its sheet over the editor: an
  entity's details, a device's card with its entities, or an area's devices and entities
  (the area sheet is new; the device sheet is the Devices page's, now shared).
- A card takes a `subtitle`, a line under its name in the theme's `card.subtitle` (Day and
  Night had the group already, unused): `Card { name: "Oven"  subtitle: "Preheating" }`.
  `CardHeader` takes it as `subtitle`, null when the card has none, and draws the line only
  when it is given and not empty; a custom header may leave the parameter out.
- The editor's completions inside a node open on that node's own attributes, then the four
  every node has, then the rest, where before they were sorted in with the keywords.
- The "Edit page" button is gone from the top of Home and the other pages; the editor is
  reached from Settings, and the page keeps the room.
- A theme says what ink reads on each accent: `accents.onLamp`, `onSky`, `onSage` and
  `onEmber`, which Day and Night set to what the components have always paired with them
  (dark on lamp and ember, white on sky, plaster on sage). A card's heading draws its active
  icon in that ink rather than always the lamp's, so a sky card's icon no longer disappears
  in Day; `CardHeader` takes it as `onAccent`. A colour from elsewhere, `palette.warn` as an
  accent, takes `text.onAccent`.
- A device has an `icon` in Casa: the one chosen for it, else its kind's (a Rachio is
  irrigation, a Tesla a car), else its first entity's domain, as the Devices page has always
  drawn it. A generated Home writes `icon: of.icon` on `DeviceCard` and `icon: device.x.icon`
  on a device's own card, so a device's card no longer shows a plug; a page saved before
  this says it itself.
- In Day and Night the arch is a room's alone: a card's icon, a device's, sits in a circle.
  The Devices page follows, as it follows the theme's `card.icon`. October already drew
  circles for both.
- Layout in a Casa page is explicit. Every block in a card takes the full width; two `Value`s
  no longer sit side by side on their own, a `Grid` says so. A `Grid` has one to three
  columns: `columns` may be left out, and then there is one per child (up to three), so
  `Grid { Text { … }  Text { … } }` is two columns with nothing more written; a number past
  three is an error (E037), a computed one is clamped. Any node inside a `Grid` may say
  `align: .Start | .Center | .End` for where it sits in its cell; a `Text` so aligned is
  aligned as text too. The node written in a `Grid` is its cell, a component's use as much
  as a built-in: `Temp { of: … span: 2  align: .End }` places the component; its root's
  `span` no longer does. `Stack { direction: .Row }` stays for content-sized things beside
  each other, an icon by a name.
- On start, the server recompiles every stored page from its source and keeps the result when
  the compiler changed what it makes of the same text (a new built-in, a bundled component);
  the source and its versions are untouched. Pages saved before the bundled headings existed
  drew no heading until this.
- October's headings use the heading groups in full: a ringed medallion for a room's icon, its
  name in the display face, the line under it in small mono type in moonlight blue; cards
  follow at a smaller size; a section's title is pumpkin.
- A third built-in theme, October: a moonlit night in the house. Night's warm browns go plum,
  terracotta goes pumpkin, the lamp is candlelight, the greens turn a little witchy; cards
  are cut sharp, edged in lavender and float on a deep shadow, fields and buttons are pills,
  there is more air between things, the greeting is bigger, and the lines between rows stop
  short of the card's edge. It is written in Casa over Night, so "View" in Settings shows its
  source: the example of how a theme of the house's own is made, touching every group. In
  October, or a theme that extends it, a crescent moon rises beside the roof of the mark and
  moonlight falls on the page from the top right.
- The whole theme vocabulary now reaches the components, not only the colours: `surface.card`,
  `surface.raised` and `surface.control` set the background, border, shadow and radius of
  cards, dialogs and menus, and fields, buttons and switches; `space` sets the spacing scale;
  `font.body` the body face; `font.size` the type scale; `text.primary`, `text.muted`,
  `text.accent` and `text.onAccent` the ink; `chart.series1-3` the series. Day and Night
  look exactly as they did.
- The mark in the sidebar is drawn in the theme's own terracotta and lamp, so a house theme
  that recolours them recolours the mark too.
- The headings of rooms, cards and sections are themeable and composable. A theme sets
  `room.icon`, `room.name`, `room.subtitle`, `card.icon`, `card.title`, `card.subtitle` and
  `section.title`: an icon's box has a `shape` (`arch circle square none`), `size`, `border`,
  `background` and `padding`; a line of text a `size`, `weight`, `font` (`body display mono`)
  and `color`. The headings are Casa components Casita ships (`RoomHeader`, `CardHeader`,
  `SectionHeader`, drawn with `Icon` and `Text`, which take those properties now); `header:`
  on a Room, Card or Section names another, and a component of the bundled name in the new
  shared components file replaces it on every page. The shared file (Settings, `casita
  components`, `get_components_source` / `check_components` / `save_components`) is one Casa
  file of components every page may use, saved only when every page still compiles against
  it; migration 010 adds its table (dropping the pre-Casa columns is still to come). New
  diagnostics E035 and E036. Day and Night draw as they did; October rings its icons and
  sets a room's name in the display face.

## Home is a page you write

- Home is now a Casa page: one text that describes the layout, the components it is built from,
  the expressions that bind the house to what is shown, and the handlers that run when the house
  changes. An admin edits it at "Edit page" on Home: the source on the left with inline
  diagnostics and completions, the live page on the right on the real house (a control there
  really sends), a Pretend drawer that replaces an entity's value in the preview only and
  narrows the preview to a phone, tablet or desktop, and every saved version to revert to. A save
  compiles on the server against every stored page and theme; one that fails does not save.
- Handlers triggered by an entity, a schedule (`every 5m`) or the clock (`at 23:00`) run on the
  server, tab open or not, as the automation `page:<id>`; `onPress`, `onToggle` and `onChange`
  run in the browser. The compiler decides, and refuses a server handler that reads `screen`,
  local state or a theme value.
- Themes are written in Casa too (`theme Dusk extends Night { palette { lamp: #f2b05e } }`),
  edited in Settings with Home drawn in the theme as you type. Day and Night are built in; a
  page may only name theme values, never a colour, and a save checks every theme a viewer can
  pick defines every name any page uses. The sidebar's theme switch lists every theme; `Auto`
  follows the device between the house's light and dark defaults.
- The first start generates Home from the cards and rooms arranged by form before this: room
  widths and chips, device cards with their readings, custom cards, hidden devices. The form
  editors are gone with them: the Add-card button, "Customize card", a room's "…" menu, the
  `card.*` requests, `update_device`'s `card` and `homeHidden`, `update_area`'s `display`, and
  `casita card`, `device set --card/--hidden/--shown`, `area set --columns/--chips`. The
  `cards` table and the old columns stay until the next release's migration drops them, so
  the deploy before it brings the old Home back with no data loss.
- New: `get_page`, `list_pages`, `get_page_source`, `check_page`, `save_page`, `revert_page`,
  `list_themes`, `save_theme`; events `page_changed` and `theme_changed`; `casita page` and
  `casita theme`; migration 009 (`pages`, `page_versions`, `themes`). The web app's content
  security policy allows the styles the page makes itself (a theme's rule, the editor's) through
  a per-response nonce the page reads from `<meta name="csp-nonce">`.
- `WidgetCard` takes `children` as well as `blocks`, and `WidgetBlockView` draws one block.
- The search is in the header on every page, as the design draws it: ⌘K (Ctrl+K elsewhere)
  focuses it, typing lists what matches by name or id with each thing's control at hand, Enter
  or a click opens its details, Escape clears it. The day and time sit at the header's end.
  `Search` is no longer placed on a page: the node is still accepted, with warning W104, and
  draws nothing, so a stored page keeps working until the line is removed.
- Casa gains `date(t)`, `time(t)` and `datetime(t)` for an epoch-ms instant ("Wed 7 Oct",
  "10:42 pm"), beside `ago(t)`; and `Value` takes `text` for words of the page's own, so a
  timestamp attribute reads as a date: `Value { label: "Last watered"  text:
  date(switch.x#lastWateredAt.value) }`.
- A card's dividers are the card's, not the row's: one line between any two blocks of the body
  (a row, a headline, a chart, a bar, a strip of values), never after the last, where before only
  rows brought a line, every row, and nothing else did. A theme sets them in a `divider` group:
  `color`, `height`, `inset` from each side, and the `space` above and below, in px (Day and
  Night: the line colour, 1, 0, 12). The same line divides a list of rows and hangs a dimmer under
  a one-row card. `Card { dividers: false }` leaves the lines out and keeps the room between
  blocks, for a card (or a component's card) that reads better without them.
- A card that holds one row through a `for` (`Card { name: d.name  for e in d.entities { Row {
  of: e } } }`, as the generated `DeviceCard` is written) or through a component parameter is
  drawn as that row, as a card written `Card { Row { of: switch.x } }` always was; a one-entity
  device no longer says its name twice over a 144px card. "Nothing on this card" sits in the
  middle of the card's height, a one-row card given more height than its row centres it, and a
  pressable card stands as tall as its grid row.
- 224 more icons for naming the house, from Lucide as the design system's are: rooms and what
  is in them (sofa, bed, bath, refrigerator, washing-machine, tv, lamp-desk…), the outdoors
  (trees, flower, fence, waves, dog, cat, bike, car-front…), energy and climate (zap, solar-panel,
  battery-charging, plug-zap…), safety (camera, cctv, siren, alarm-smoke, fingerprint…) and
  things and time (clock, mailbox, package, router, star…). The icon picker gains a search box
  and scrolls.

## A room can be narrower than the page

- Home draws its rooms in three columns on a wide screen, and a room takes as many as the
  household chose: one for a room with a single device, two, or all three (the default, as
  before). A narrow room sits beside another, in order, and every room in a row is as tall as
  the tallest; on a middling screen there are two columns and on a phone one, with a room
  taking what there is. A room's "…" menu, for an admin, has the
  width and "Status chips", which turned off leaves out the row of chips under the room's name.
  Both are `Area.display` (`{ columns?: 1 | 2 | 3; facts?: boolean }`, migration 008), set
  through `update_area`'s `display`, which is merged a field at a time; a field at its default
  is dropped, and `null` takes the whole default back. The CLI takes `area set --columns <n>`,
  `--chips` and `--no-chips`.
- `Menu` takes `checked` on an item, which makes it a checkbox with a check when on; `Area`
  takes `menu` for the "…" at the end of its title line.

## A quiet socket stays up

- The web app pings the server every 30 seconds while nothing else is going over its socket,
  so a proxy's idle timeout (nginx reads an upgraded connection for 60 seconds by default) or
  the server's own (two minutes) no longer takes a quiet evening for a dead connection and
  cuts it, which showed "Reconnecting to the house" though the house was fine. A ping that
  goes unanswered closes the socket, so a dead one is found out instead of waited on.
- When a socket is cut, the store connects again at once and says "reconnecting" only if it
  is not back within two seconds; until then what is shown is the last the server said.
  `createStore` takes `keepaliveMs` and `graceMs`.

## A reading twice, and no header

- A reading can be on a card more than once, shown a different way each time: a lock as its
  "Unlock" row and, under it, its history. In the editor a row's menu has "Show again, another
  way", which adds the reading once more shown the first way it is not shown yet; a row cannot
  be switched to a way the same reading is already shown. The rule in the schema is now "a
  reading is shown one way once". An edit in the editor names the row's place, not its entity.
- A card can go without its header: "Show the header" in Appearance, off, leaves out the name,
  icon and status line so the first reading is the top of the card. Its "…" menu then rides on
  the first row, as on a card that is one row; a card whose first block is not a row gets a thin
  strip for it. `CardConfig.header: false`; `WidgetCard` takes `header={false}`.
- A row now takes its label, so the entity's name on it can be the household's word for it.
- Where a card's "…" menu rides on a row (a card that is one row, or the first row of one with
  no header), the row's chevron is gone: the menu's first choice is that row's details. A
  member, who has nothing to edit on a custom card, still gets the menu there for that. Rows
  with no menu of their own keep the chevron.
- A row in an arranged card lines up with the card's other blocks instead of sitting a second
  gutter in: `.ca-widget-body > .ca-row` drops the row's own side padding, to raise with the
  design system.

## History on a card

- A reading can be shown as its history: the entity's own history view (a line for a number, a
  timeline for a state), drawn to fit a card at 120px, over the last hour, 24 hours (the
  default) or 7 days, chosen per reading in the editor. It is live: fetched again when the
  entity reports, at most once a minute, and when the house's units change. Offered to numeric
  sensors, the weather, and anything that is on or off, open or closed, locked or not.
  `CardReading.display` gains `history` and `range` (`hour` | `day` | `week`, history only);
  `@casita/ui`'s `WidgetCard` gains a `figure` block.

## Custom cards

- A household admin can make a card of the house's own: readings from any device, or several,
  arranged the way a device's card is (rows, values, a headline, bars, a status line, a name,
  icon, colour, "active when" and size). It lives in a room and sits among the room's device
  cards, placed by the first thing it shows; a card put in no room goes with what is in none.
  "Active when: anything is on" means anything on the card, not anything in the house. Home's
  search finds a card by its name or by anything on it, and draws the whole card. A card whose
  readings have all gone is still drawn, empty, so it can be reached and changed.
- The editor is `/cards/new` (reached from "Add card" beside Home's search) and `/cards/<id>`
  (from the card's "…" menu, which also deletes it). It is the device card's editor with the
  picker widened to the house: each reading says which device and room it is from, the filter
  matches those too, and bar targets and "active when" range over what is on the card. A card
  needs a name and a reading before it can be saved.
- A device can be taken off Home: "Show on Home" in its card's Appearance tab, saved at once and
  apart from the card, so the arranged card is kept for when the device is back. Its entities
  still count in the room's facts and are still offered to custom cards. The device sheet says
  when a device is hidden. Nothing is hidden on its own: putting an entity on a custom card
  leaves its device's card alone.
- A card that is one row is drawn as one row. A device with a single entity, or an arranged or
  custom card whose only block is a row, no longer has a header saying the name and a row saying
  it again: the card's name and icon take the row, the entity's state is the line under them,
  and its control sits at the edge, with a dimmer underneath while a light is on. A status line
  chosen for the card joins the state.
- `@casita/ui` gains `EntityCard` (`ca-ecard`), ahead of the design system, with the device
  card's head and the widget's accents. The web app lets an open menu out of it as it does for
  the other cards.
- The API has `get_cards`, `create_card`, `update_card` and `delete_card` (the last three
  admin-only), each card `{ id, areaId?, config }` with the config a `CardConfig` that must have
  a name; the card's id comes from the name (`new` is never given, since the web app edits a new
  card there). Card events are `card_added`, `card_updated`, `card_removed`. A member hears of a
  card with only the readings they may read, and not of one with none. Deleting a room leaves
  its cards in no room; removing a device leaves its readings on a card to be skipped.
  `update_device` takes `homeHidden`. Migration 007 adds the `cards` table and
  `devices.home_hidden`.
- The CLI has `card list|show|add|set|rm` (`--config <json|@file>`, `--area <id|name|none>`),
  and `device set --hidden|--shown`; `device show` says whether the device is on Home.

## Customize card

- A household admin can arrange the card Home shows for a device: which of its readings, in what
  order, and how each is drawn — as a row with its control, a value in a grid, the one headline,
  a bar (with a colour, a target tick from another percent reading such as the charge limit, and
  a "warn below" level), or part of the status line under the name. Readings are the device's
  entities, hidden ones included, and the keys of their state attributes, addressed as
  `<entityId>#<key>`. The card also takes a name, an icon, a colour when active (lamp, sky,
  sage, ember), what "active" means (anything on, one entity, or never), and a size: small
  keeps the status line and two readings, large spans two columns of its room.
- The editor is at `/devices/<id>/card`, reached from a card's "…" menu on Home and from the
  device sheet: a live preview (yours, or the default) beside Content and Appearance tabs.
  Reorder with the arrow keys on a row's handle (Home takes it to the top) or its menu; there is
  no drag yet. Saving a card that equals the default saves nothing, so Home keeps following the
  device as its entities come and go.
- The card is a `card` JSON column on `devices` (migration 006), carried on the device and set
  through `update_device { card }`; `null` returns to the default. The server checks the shape
  only (`@casita/core/card`), not that the entities exist: one that is gone is skipped when
  drawn and listed again when it returns. The CLI takes `device set --card <json|@file|default>`
  and has `device show <device>`.
- `@casita/ui` gains `WidgetCard` (the design system's `ca-widget`), the `lamp`, `sage`,
  `danger` and `accent` tones of `RangeBar`, and the `sliders-horizontal` icon. The web app
  adds two rules of its own to raise with the design system: a card's `overflow: hidden` is
  lifted while its menu is open, since the menu is positioned inside it, and a large widget
  spans two columns of `.ca-area-grid` from 656px.
- Pages may name a part of their path (`/devices/:id/card`); the Devices page opens the device
  named by `?open=`.
- Not done: a device whose every entity is hidden still has no card on Home, since rooms are
  built from the entities that are shown.

## Icons

- An entity, a device or an area can be given an icon from the design system's set, and
  given back its default: the domain's picture for an entity, the device kind's (else its first
  entity's) for a device, the house for an area. `update_entity`, `update_device` and
  `update_area` take `icon` (null clears it); `update_area` no longer requires a name. The web
  editors and the area dialog have an `IconPicker` (new in `@casita/ui`, ahead of the design
  system), whose first choice is the default. The CLI takes `--icon <name>` or `--icon default`
  on `entity set`, `device set` and the new `area set`.

## Display names

- `update_me { displayName }` lets anyone change the name they are shown as; `update_user`
  already let an admin. The admin's user panel and a member's "Your account" page both have
  the field, and the CLI has `user set-name <username> <name>` and `user set-my-name <name>`.
  An empty name shows the username again.

## Z-Wave without a UI

Everything Z-Wave JS UI's screens were needed for is now an action of the `zwave-js`
integration, so the radio can be a headless zwave-js-server. Command and event shapes were
checked against zwave-js-server 3.11.0's source.

- `start_inclusion` takes the device's five-digit `pin` (or its S2 `qr` code) up front and
  answers the server's S2 prompts itself: with a PIN every class the device asks for is granted;
  without one, S2 Authenticated and Access Control are withheld so the device joins at the level
  it can reach rather than failing. It returns `{ nodeId, securityClass, lowSecurityReason? }`
  when the node is added, which is after secure bootstrapping and before the interview, since a
  sleeping battery device can take a long time to finish one. A `timeoutSec` (120) stops
  inclusion if nothing joins.
- `provision_qr` provisions a SmartStart code, so an 800-series device joins securely by itself
  when powered up; `list_provisioned` and `unprovision` manage the list. An S2 (non-SmartStart)
  code is refused with a pointer to `start_inclusion`, which takes it as `qr`.
- `remove_failed_node`, and `get_config_parameter` / `set_config_parameter` for raw
  configuration parameters.
- Meter (CC 50) readings become sensors classed by unit (`kWh` energy, `W` power), and Battery
  (CC 128) level a battery sensor. The porch plug fixture gained a meter.
- The fake server can play the S2 prompts, a node joining, and the SmartStart list.
- In the web app, a QR field can be filled from the camera ("Scan with the camera" under it),
  on a secure page in a browser that offers one. An integration marks the field with
  `.meta({ scan: "qr" })`; decoding is jsQR's.
- The Integrations page is a table, and the actions sheet draws a parameterless action as one
  row. Parameter names read as words: "Node ID", "Timeout sec".
- Not done from the handoff's "Should" rows: `backup_nvm`, because an integration has no file
  path to write into; `node.set_name` is a "Nice" and still open.

## Weather

- A `weather` domain: a read-only entity holding the condition, temperature, feels-like, humidity
  and wind now, with the daily and hourly forecast in its attributes. It takes no commands. Its
  temperature is what history rolls up and charts.
- `integrations/open-meteo`: weather for one place from Open-Meteo, with no account or key. A
  weather entity, sensors for the readings worth a history, precipitation over the last and next
  24 hours (for holding off irrigation), sunrise and sunset, a `daytime` binary sensor that turns
  at the minute the sun does, and air quality (index, PM2.5, PM10) and UV index.
- Home has the weather beside the greeting, as the design does: the temperature outside, the
  condition and today's high and low, and a badge when rain or snow is falling or within twelve
  hours ("Rain until 11 pm"). Under it, the week ahead, in the house's units. The search field
  has a row of its own across the top of Home, as the design has it.
- Fixed: an hour's or a day's mean was skewed when some of a minute's samples carried no number (a
  sensor reporting `null`, a weather report with no temperature), because each minute's mean was
  weighed by all its samples. Rollups now keep how many samples were numeric and weigh by that.
  Rows rolled up before this keep their old weight.
- `casita entities`, `casita watch`, the dashboard and `casita history` show weather entities.

## Web UI, phase 10 — parity, access, small screens

- `tests/web-parity.test.ts`: every request the API takes is sent from somewhere in the web app,
  as the CLI's README requires of subcommands. `ping` and `unsubscribe` are the two it has no use for.
- Under 860px wide the navigation becomes a bar across the top and every page stacks into one
  column; on a touch screen every control is at least 44px tall.
- Each page sets the tab's title and takes focus when it is opened; a "Skip to the page" link
  comes before the navigation.
- A web app manifest, so a phone or a wall tablet can add Casita to its home screen. Files with no
  hash in their name (the manifest, its icon, `index.html`) are no longer cached for good.
- Not done: tiles in place of rows on a phone, and an automated browser test. The app was checked
  by hand in Chrome against the demo integration; the list of what to check is in
  `packages/web/README.md`.

## Web UI, phase 9 — users and access

- Users and access, for an admin: add, disable and remove users, change roles and passwords; for
  each user and for the member and guest roles, grants on an entity, an area or a domain at None,
  Read or Control; each user's API tokens (shown once when made) and signed-in sessions; and the
  audit log.
- Anyone else gets the same page as "Account": their own tokens and sessions.

## Web UI, phase 8 — integrations, automations, settings

- Integrations: each instance with its status, entity count and error, reload for an admin, and a
  form for each of its actions (permit join, inclusion, running a zone) drawn from the action's
  schema, with the result shown after it runs.
- Automations: the loaded files with their status and error, and reload.
- Settings: the server's version and uptime; units, time zone and default history as a form;
  backup; and the whole configuration, with anything named like a credential covered, where any
  path can be set.

## Web UI, phase 7 — history

- History: pick any number of entities and a range (hour, 24 hours, 7 days, 30 days). Sensors and
  thermostats are drawn as lines, one chart each, a thermostat's target stepped beside its reading;
  everything with a state shares one card of timelines. A gap in the record is drawn as a gap.
- A month of a sensor is asked for by the hour; states are always exact.
- The address names the entities and the range, so a view can be bookmarked. Each entity's raw
  records for the range download as CSV.

## Web UI, phase 6 — entities, devices, areas

- Entities: every entity you can read, hidden and disabled ones included, filtered by domain and
  searched by name, id or area. Its sheet has the control, the history, and for an admin its
  settings: name, id, area, hidden, disabled, days of raw history, and remove.
- Devices: the list with maker, area, integration and status; a device's sheet shows its entities
  with their controls, and lets an admin rename it, move it, or remove it.
- Areas: add, rename and remove.
- Removing anything asks first, in a dialog that names it and says what goes with it. A sheet
  that is open on an entity follows it through a rename.

## Web UI, phase 5 — sign-in, the shell, and Home

- The web app signs in (password, or an identity provider), keeps a session cookie, and shows
  Home: a room per area with a card per device, thermostats, locks, vehicles and irrigation, what
  the house did recently, and each entity's history (hour, 24 hours, 7 days) in a side sheet.
- Controls for every domain. A command shows as pending until the device confirms; a light, lock
  or door changes on screen only when the house reports it. A failure is a toast with the server's
  own message.
- Day and Night themes, following the device unless chosen; the unit system follows the server.
- `get_entities` now also returns `level` (`read` or `control`): what the signed-in user may do with
  each entity. An entity they may only read is shown with no control and "View only".
- `Thermostat` no longer says "Idle" when it is not told what the equipment is doing; it names the
  mode it is set to. The core reports a thermostat's mode, not whether it is heating right now.
- `bun run web:dev` now rebuilds the app on change; the server serves the result on its own port.
- Not on Home yet: scenes, weather and the alarm, which the core has nothing behind.

## Web UI, phase 4 — server support and the live store

- A browser signs in for a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` behind TLS)
  by sending `cookie: true` to `POST /api/auth/login`; the reply then carries no token. The socket
  and the HTTP routes accept the cookie, but only on a request from a page this server served. Bearer
  tokens are unchanged, and the `auth` message's `token` is now optional.
- OIDC: `start?web=1` makes the callback end in the cookie and a redirect to `/` (or `/?login=failed`)
  in place of JSON. `GET /api/auth/providers` lists the providers for a login page.
- The server serves the built web app (`bun run web:build`) from its own port: hashed files cached
  for good, `index.html` never, under a content security policy with no inline script or style.
  `[server] web = false` turns it off; an unbuilt app is logged and skipped.
- `packages/web/src/store.ts`: the app's live state, tested against the real server in
  `tests/web-store.test.ts`.
- Fonts are declared through the FontFace API, since the policy forbids inline styles.

## Web UI, phase 3 — charts, house components, exemplars

- Charts: `TimeSeriesChart`, `TimeSeriesCard`, `StateTimeline`, `StateHistoryCard`, `TimeAxis`,
  `ChartFrame`, `ChartLegend`, `LevelMeter`. The arithmetic (ticks, paths that break on gaps, the
  value in force at a time, time in state) is in `src/chart-math.ts` as plain functions.
- House components: `EntityTile`, `EntityRow`, `DeviceCard` / `DeviceSection`, `Area` (masonry
  grid), `IntegrationRow`. Exemplars: `Thermostat`, `SceneButton`, `Forecast`.
- One departure from the design system's reference code: a series whose value never changes is
  drawn mid-plot with a unit of room either side. The reference drew it on the baseline with a
  single tick, and a chart with no readings produced no axis at all.
- With these the design system's 40 components are all ported. The gallery's "House and charts"
  page shows each with realistic data, including pending, unavailable and view-only states.

## Web UI, phase 2 — base components

- `packages/ui/src/components`: the design system's generic components as typed React components,
  keeping its class names, roles and props: `Button`, `IconButton`, `Menu`, `TextField`, `Select`,
  `Combobox`, `Checkbox`, `Toggle`, `Slider`, `Stepper`, `SegmentedControl`, `Pill` / `PillGroup`,
  `Dialog`, `Sheet`, `Toast` / `ToastRegion` / `useToasts`, `SideNav`, `Tabs`, `Badge`, `StatusDot`,
  `EmptyState`, `Skeleton`, `DataTable`, `Timestamp`, `CopyChip`, `CodeView`, `RangeBar`, with
  `formatTime` and `formatDuration`.
- The design system's stylesheet is split, unchanged, into one file per component under
  `src/styles/components/`, including those for the components still to come.
- Ids come from React's `useId` rather than a counter, so they are stable across renders.
- The gallery has a Components page with a working example of each.
- `src/test-dom.ts`: a DOM for the tests that need events and focus, put up for one test file and
  taken down after it so the server's tests never see a `window`.

## Web UI, phase 1 — design system foundations

- `packages/ui`: `tokens.css` generated from the design system's `tokens.json` (`bun run ui:tokens`),
  Day and Night themes (Night follows the system, or `data-theme` on the root), the eight text styles
  as `ca-text-*` classes, the three fonts served from the package, the logos, and `Icon` with the 76
  icons and the domain, device and weather maps.
- `bun run ui:gallery` shows every token, text style, logo and icon in both themes.
- Tests check that `tokens.css` is current and that each text and mark pair meets its contrast
  ratio in both themes. One pair in the design system does not: the `ink` token's note lists `lamp`
  as a ground, but Night `ink` on `lamp` is 1.5:1. Components use `ink-on-lamp` there, which passes.

## Web UI, phase 0 — foundations

- `packages/client`: `CasitaClient`, the words for a state, and unit conversion moved out of the CLI
  so the web app shares them. `present` now reports an unavailable entity as "Unavailable" with its
  last known state in `was`; the CLI still prints "Unavailable ╱╱ was …".
- `packages/ui` and `packages/web` scaffolded: React 18, built with Bun (`bun run web:build`,
  `bun run web:dev`), typechecked by `tsconfig.web.json`.
- The wire schema imports only `@casita/core/types` and the new `@casita/core/retention`, so it
  bundles for a browser. `tests/boundaries.test.ts` checks this and what each browser package may import.
- The plan for the web UI is in `docs/web-ui-plan.md`.

## CLI: one-shot commands and dashboard

- `light set|on|off`, `switch on|off|toggle`, `lock lock|unlock|retry`: a "sent" line, then the confirmed
  state or what went wrong and what to do; exit 3 when the device does not do it.
- `ls`, `sensors`, `car`: readable listings with level bars and attention flags.
- `dash`: a live full-screen dashboard (rooms, thermostat, locks, vehicles, irrigation, recent events)
  with keyboard control; `dash --once` prints a single frame.
- In the dashboard, an entity's detail view shows its history (last hour, 24 hours, or 7 days): a bar
  chart for numeric sensors and thermostats, a bar colored by state for lights, switches, locks,
  covers, and binary sensors, and a bar colored by named state for word-valued sensors such as a
  car's state. A vehicle's card is selectable and opens its state history.
- TeslaMate: tire pressures and warnings, charging state, charger voltage and current, ideal range,
  elevation, each door and the charge port, preconditioning, climate keeper, update version, and
  route destination are now entities; the location's attributes include the heading.
- In the dashboard, a car's detail view lists every reading the car reports, with its position.
- `server.units` (`metric` or `imperial`, default `metric`) sets the unit system for the whole house.
  Readings are stored as devices report them and converted when shown: temperatures, distances,
  speeds, pressures. The server reports the setting in `auth_ok` and `get_status`; the dashboard
  follows a change live, and in imperial the thermostat steps one degree Fahrenheit.
- `device set <device> [--name] [--area]` renames a device or moves it to an area, by id or name.
- `get_history` takes `includePrevious` to also return the last record before the range.
- The dashboard takes the mouse: click a row to select it, click it again to toggle it, right-click
  for its detail, wheel to move. Locks are never changed by a click. `--no-mouse` turns it off.
- Colors follow the terminal's background: the dashboard asks the terminal (OSC 11) and uses a dark
  or light palette; `--theme` or `CASITA_THEME` overrides; when unknown, the terminal's own sixteen
  colors are used.
- `get_entities` now also returns `effectiveAreaId` and `controllable`.
- Not built, because nothing in the core backs them yet: scenes, the alarm, weather, and the
  appliance cards (espresso, laundry, air quality) from the design.

## Cloud integrations: Rachio and Tesla

- `integrations/rachio`: zones as switches, standby switch, rain-delay sensor, `run_zone`, `stop_water`,
  and `rain_delay` actions, polling sized to Rachio's daily request limit.
- `integrations/tesla`: read-only vehicle state through the Fleet API, with the OAuth flow run through
  integration actions. Commands are not implemented.
- `integrations/teslamate`: read-only vehicle state from TeslaMate's MQTT topics; the shared MQTT layer
  gained `caFile`, `certFile`, and `keyFile` for brokers behind TLS or mutual TLS.
- Rachio has been run against a real controller; Tesla and TeslaMate against fakes only.
- The spec lists cloud integrations as out of scope for
  milestone 1; these were added on request.

## Step 12 — hardening

- A client that stops reading is terminated once its send buffer passes the limit (4 MB by default).
- `tests/hardening.test.ts` runs the real entrypoint with all integrations against fakes: boot,
  `casita watch`, `casita cmd --confirm`, memory under 200 MB, clean SIGTERM exit.
- `bun scripts/soak.ts [minutes]` samples RSS under steady traffic; the one-hour run is still to do.
- README per package, `CONTRIBUTING.md` checklist.

## Step 11 — remaining API and CLI surface

- OIDC login (Authorization Code with PKCE, discovery from the issuer) behind `[[auth.oidc]]`.
- `casita repl` with tab completion; `casita backup`, rename, areas, metadata, and config landed earlier.

## Step 10 — Z-Wave JS

- WebSocket client for zwave-js-server (schema 35): node dump mapping, value updates, `node.set_value`,
  node dead/alive/ready/removed, Central Scene buttons, inclusion/exclusion/heal actions.

## Step 9 — ESPHome native API

- Plaintext and Noise-encrypted connections, generated protobuf types (`proto/README.md`), light,
  switch, sensor, binary sensor, cover, button; reconnect with backoff; mDNS discovery.
- The Noise handshake is checked against the published cacophony test vector.
- mDNS browsing has parser tests only; it has not been run against real devices.

## Step 8 — automation engine

- `automations/*.ts` loaded at start and hot-reloaded on change; `get_automations`,
  `reload_automation`, `casita automations`; two samples (`*.sample.ts`, copy to enable).

## Step 7 — zigbee2mqtt

- Entities from `exposes`, state and availability topics, `/set` commands, `/get` on discovery,
  rename by IEEE address, `permit_join` through `integration_action`.

## Step 6 — recorder

- Batched history writes, `get_history` with resolutions, minute/hour/day rollups, per-entity
  retention, nightly retention at 03:00, `GET /api/history.csv`, `casita history`, `casita backup`.

## Step 5 — shared MQTT layer and generic MQTT integration

- `integrations/mqtt-shared`: MQTT.js wrapper with reconnect, per-filter handlers, publish, connection changes.
- `integrations/mqtt`: discovery under `<prefix>/<component>/[<node>/]<object>/config` for light, switch,
  sensor, binary_sensor, cover, button; `{{ value_json.<path> }}` templates; availability topics.
- `integrations/testing`: a stand-in `IntegrationContext` for integration unit tests.
- End-to-end tests against aedes: discover, control, observe, lose and recover the broker, restart.
- Not yet run against a real Tasmota or Shelly device.

## Step 4a — users, roles, grants

- Local users (argon2id), sessions and API tokens, the three fixed roles, scoped grants, audit log.
- Enforced in the API read filter and in `requirePermission`, the first router policy.
- CLI: `login`, `logout`, `whoami`, `user`, `grant`, `token`, `audit`.
- OIDC is not implemented yet (step 11); the `IdentityProvider` interface and `[[auth.oidc]]` config exist.

## Step 4 — API server and CLI

- WebSocket protocol with auth, envelope, subscribe with snapshot, and the request types that do not
  depend on later steps; HTTP `/health`, `/api/auth/login`, `/api/auth/logout`, `/api/schema`.
- `casita` CLI over the WebSocket API. `history`, `automations`, `backup`, and `repl` come with their steps.

## Step 3 — config store, integration host, demo integration

- `config.toml` validated with Zod; `set` rewrites the file atomically and emits `config_changed`.
- Host lifecycle with backoff, reload, teardown timeout, multiple instances, integration actions.
- Scheduler (`every`, `after`, `cron` in `server.timezone`) tied to each instance's AbortSignal.

## Step 2 — event bus, registry, state store

- SQLite migrations, registry with uniqueId re-attachment, rename aliases, orphaning, areas.
- State store with ownership checks, heartbeats, and the `last_states` restore path.

## Step 1 — repo scaffold

- Workspace, Biome, base tsconfig, `bun test`, import-boundary check.
- `core/types.ts` and `core/router.ts` moved into `packages/core` with `uniqueId`, `button`,
  `attributes`, `signal` on `AutomationApi`, `registerAction`, and the new `CommandSource`.

## Where the implementation departs from the spec (`docs/core-spec.md`)

- `weather` is a domain the spec does not list. It has state and no commands, so the router and
  `commandSchema` are unchanged.

- `get_history` returns `{ resolution, records }` rather than a bare array, so it can name the tier
  it actually used.
- Rollup day buckets are aligned to UTC, not `server.timezone`.
- Command history holds one row when a command is issued and another if it fails; commands rejected
  before dispatch (forbidden, invalid) are not recorded.
- ESPHome uses `@noble/ciphers` for ChaCha20-Poly1305 because Bun's `node:crypto` lacks it, and
  generates trimmed TypeScript types plus a protobufjs descriptor rather than a full `pbjs` module.
- An unreachable ESPHome device does not put the instance in `error`; each device retries on its own.
- OIDC ID tokens are validated by claims (issuer, audience, expiry, nonce) but not by signature,
  relying on TLS to the token endpoint as OIDC Core 3.1.3.7 permits. The callback answers with JSON.
- Z-Wave maps the command classes the spec lists plus Meter and Battery (added for the headless setup).
- zigbee2mqtt lights accept RGB commands but do not report RGB state (the bridge reports xy).
- A slow client is terminated without a close code, since a close frame would queue behind the backlog.
- `delete_entity`, `delete_device`, `update_area`, `delete_area` take `entityId` / `deviceId` / `areaId`
  rather than `id`, which is the envelope's request id.
- Config blocks are `[[integration]]` with `type` and an optional `name` (default `main`); the spec's
  `[[integration.esphome.devices]]` form does not fit that shape.
- JSON Schema comes from Zod 4's built-in `z.toJSONSchema`; `zod-to-json-schema` does not support Zod 4.
- `CommandErrorCode`, `CommandResult`, and `SendOptions` moved from `router.ts` to `types.ts` so
  `AutomationApi.command` can return a result and take `confirm`.
- `get_status` was added for `casita status`.
- A change in attributes alone emits `state_changed` (so a moving car's coordinates stream live) without
  moving `changedAt`; history keeps at most one such change per entity per
  `server.history.attributesMinIntervalMs` (default one minute).
- A user who cannot read an entity gets `not_found` for it, not `forbidden`, so its existence is not leaked.
- MQTT entities with no observable state (a switch with no `state_topic`) are skipped, since state is
  never guessed. JSON-schema lights are not supported yet.
