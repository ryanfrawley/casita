# @casita/integration-open-meteo

Weather for one place from [Open-Meteo](https://open-meteo.com): no account, no key.

## Owns

- `src/api.ts`: the forecast and air-quality requests, read into plain values.
- `src/condition.ts`: WMO weather codes as the core's weather conditions.
- One `weather` entity: the condition, temperature, feels-like, humidity and wind now. Its
  attributes carry `daily` (seven days, today first) and `hourly` (the next 48 hours), and
  `conditionNext12h`: the most severe condition from now through the next twelve hours
  (clear now with rain this afternoon is `rain`), which an automation can trigger on with
  `on weather.<id>#conditionNext12h changed`.
- Sensors: temperature, feels like, humidity, wind speed, wind gusts, pressure, UV index,
  precipitation in the last 24 hours and expected in the next 24, and the highest chance of
  precipitation in the next 24.
- `sunrise` and `sunset` sensors (a clock time at the place; `at` in the attributes is the
  instant) and a `daytime` binary sensor that turns when the sun does, not at the next poll.
- With `airQuality` (the default): an air quality index (US or European, by `aqi`), PM2.5 and PM10.
- Actions: `refresh`, `status`.

## Notes

- Everything is reported in metric (°C, km/h, mm, hPa); `server.units` decides how it is shown.
- One request per poll, two with air quality: about 200 a day at the default fifteen minutes,
  against Open-Meteo's free allowance of 10,000. The free API is for non-commercial use.
- Needs internet access. After three failed polls in a row the entities go unavailable; air
  quality fails on its own and does not take the weather with it.
- The data is CC BY 4.0, which asks that Open-Meteo be credited where its data is shown. The
  weather entity's `attribution` attribute carries the credit; the web app does not show it, so
  that is for whoever puts the forecast in front of other people to decide.
- For a second place, add a second block with its own `name` and `label`.

## Must not import

- Anything from the core except `@casita/core/types`.
