// The sun's height above the horizon, apart from React so it can be tested as plain functions.
// The position is the US Naval Observatory's low-precision one: good to a few hundredths of a
// degree in declination, far finer than a curve a hundred pixels tall can show.

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** The Julian date of the Unix epoch, and of J2000.0, the epoch the formulas count from. */
const JD_UNIX = 2440587.5;
const JD_2000 = 2451545.0;

/**
 * Where the sun's centre is at the official sunrise and sunset: refraction lifts it into sight
 * from 34′ below the horizon, and its upper edge shows 16′ before its centre would.
 */
export const SUNRISE_ELEVATION = -0.833;

/** The sun's elevation at a moment, seen from a place: degrees above the horizon, negative below. */
export function solarElevation(ms: number, latitude: number, longitude: number): number {
  const d = ms / DAY_MS + JD_UNIX - JD_2000;
  const anomaly = (357.529 + 0.98560028 * d) * RAD;
  const meanLongitude = 280.459 + 0.98564736 * d;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const siderealHours = 18.697374558 + 24.06570982441908 * d + longitude / 15;
  const hourAngle = siderealHours * 15 * RAD - rightAscension;
  const lat = latitude * RAD;
  const sine =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sine))) / RAD;
}

/**
 * A stand-in for the sun's height when the place is not known: a cosine through the day that
 * crosses the horizon at sunrise and sunset and peaks between them, the sun's own shape. `t`,
 * `riseAt` and `setAt` are shares of the day; the result is in degrees, scaled to read like a
 * mid-latitude day. It is not an angle to show anyone.
 */
export function modelElevation(t: number, riseAt: number, setAt: number): number {
  const noon = (riseAt + setAt) / 2;
  const edge = Math.cos(Math.PI * (setAt - riseAt));
  const height = Math.cos(2 * Math.PI * (t - noon)) - edge;
  return (height / Math.max(0.05, 1 - edge)) * 40 + SUNRISE_ELEVATION;
}

/**
 * The height a curve gives an elevation: degrees above the horizon as they are, and below it
 * eased toward `depth`, so a night 60° deep does not dwarf a day 30° high. The easing has the
 * same slope as the day at the horizon, so the curve runs on through it without a corner.
 */
export function eased(elevation: number, depth = 30): number {
  const above = elevation - SUNRISE_ELEVATION;
  return above >= 0 ? above : depth * Math.tanh(above / depth);
}
