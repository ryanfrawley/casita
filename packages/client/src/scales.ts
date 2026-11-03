// The health scales a reading is judged on: each band's upper bound and word, from the body
// that publishes it. A reading's place on a scale is drawn band by band, each band an equal
// share of the track, since the bands themselves are far from equal (PM2.5's first is 9 wide,
// its last 100).

export type ScaleName = "uv" | "pm25" | "pm10" | "aqi" | "eaqi";

export interface Band {
  /** The highest value in the band; the last band's is where its track ends. */
  upTo: number;
  label: string;
  /** 1, the best, to 6, the worst: the colour step the band is drawn in. */
  tone: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface Scale {
  /** What the scale measures, as a reading on it is named when the page names it nothing else. */
  title: string;
  /** What the bands are measured in, for the words beside the value. */
  unit: string;
  /**
   * The decimals the scale is published to: a reading is rounded to them before its band is
   * chosen, so UV 2.6 is 3, Moderate, as the WHO rounds it, and PM2.5 9.04 is 9.0, Good.
   */
  decimals: number;
  bands: readonly Band[];
}

export const SCALES: Record<ScaleName, Scale> = {
  // WHO, Global Solar UV Index.
  uv: {
    title: "UV index",
    unit: "",
    decimals: 0,
    bands: [
      { upTo: 2, label: "Low", tone: 1 },
      { upTo: 5, label: "Moderate", tone: 2 },
      { upTo: 7, label: "High", tone: 3 },
      { upTo: 10, label: "Very high", tone: 4 },
      { upTo: 14, label: "Extreme", tone: 5 },
    ],
  },
  // US EPA, 24-hour PM2.5 breakpoints as revised in 2024.
  pm25: {
    title: "PM2.5",
    unit: "µg/m³",
    decimals: 1,
    bands: [
      { upTo: 9, label: "Good", tone: 1 },
      { upTo: 35.4, label: "Moderate", tone: 2 },
      { upTo: 55.4, label: "Sensitive groups", tone: 3 },
      { upTo: 125.4, label: "Unhealthy", tone: 4 },
      { upTo: 225.4, label: "Very unhealthy", tone: 5 },
      { upTo: 325.4, label: "Hazardous", tone: 6 },
    ],
  },
  // US EPA, 24-hour PM10 breakpoints.
  pm10: {
    title: "PM10",
    unit: "µg/m³",
    decimals: 0,
    bands: [
      { upTo: 54, label: "Good", tone: 1 },
      { upTo: 154, label: "Moderate", tone: 2 },
      { upTo: 254, label: "Sensitive groups", tone: 3 },
      { upTo: 354, label: "Unhealthy", tone: 4 },
      { upTo: 424, label: "Very unhealthy", tone: 5 },
      { upTo: 604, label: "Hazardous", tone: 6 },
    ],
  },
  // US EPA, Air Quality Index.
  aqi: {
    title: "Air quality",
    unit: "",
    decimals: 0,
    bands: [
      { upTo: 50, label: "Good", tone: 1 },
      { upTo: 100, label: "Moderate", tone: 2 },
      { upTo: 150, label: "Sensitive groups", tone: 3 },
      { upTo: 200, label: "Unhealthy", tone: 4 },
      { upTo: 300, label: "Very unhealthy", tone: 5 },
      { upTo: 500, label: "Hazardous", tone: 6 },
    ],
  },
  // European Environment Agency, European Air Quality Index.
  eaqi: {
    title: "Air quality",
    unit: "",
    decimals: 0,
    bands: [
      { upTo: 20, label: "Good", tone: 1 },
      { upTo: 40, label: "Fair", tone: 2 },
      { upTo: 60, label: "Moderate", tone: 3 },
      { upTo: 80, label: "Poor", tone: 4 },
      { upTo: 100, label: "Very poor", tone: 5 },
      { upTo: 150, label: "Extremely poor", tone: 6 },
    ],
  },
};

export interface Placed {
  /** The band the value is in. */
  band: number;
  label: string;
  tone: Band["tone"];
  /** 0 to 1 along the track: the band's share, and how far into it the value is. */
  position: number;
}

/**
 * Where a value sits on a scale; past the last band it is in the last, at its end, and a value
 * that is not a number is at the start.
 */
export function placeOn(scale: Scale, reading: number): Placed {
  const { bands } = scale;
  const value = Number.isNaN(reading) ? 0 : reading;
  const rounded = Number(value.toFixed(scale.decimals));
  const found = bands.findIndex((band) => rounded <= band.upTo);
  const index = found === -1 ? bands.length - 1 : found;
  const band = bands[index] as Band;
  const from = index === 0 ? 0 : (bands[index - 1] as Band).upTo;
  const within = band.upTo > from ? (value - from) / (band.upTo - from) : 0;
  const position = (index + Math.max(0, Math.min(1, within))) / bands.length;
  return { band: index, label: band.label, tone: band.tone, position };
}
