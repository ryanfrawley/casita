// Weather effects, every way they might be shown, side by side: pick a condition, a place, a
// colour and a strength, and see each sky at once.

import { type CSSProperties, useState } from "react";
import {
  Badge,
  Forecast,
  Icon,
  SegmentedControl,
  Select,
  WEATHER_ICON,
  type WeatherCondition,
  WeatherEffect,
  weatherHost,
} from "../src/index.ts";
import { Demo } from "./section.tsx";

const CONDITIONS = Object.keys(WEATHER_ICON) as WeatherCondition[];
const WORD: Record<WeatherCondition, string> = {
  clear: "Clear",
  "clear-night": "Clear night",
  "partly-cloudy": "Partly cloudy",
  "partly-cloudy-night": "Partly cloudy night",
  cloudy: "Cloudy",
  overcast: "Overcast",
  fog: "Fog",
  haze: "Haze",
  drizzle: "Drizzle",
  rain: "Rain",
  pouring: "Heavy rain",
  snow: "Snow",
  hail: "Hail",
  thunderstorm: "Thunderstorm",
  windy: "Windy",
  tornado: "Tornado",
};

type Where = "card" | "header" | "page";
type Tint = "auto" | "ink" | "sky";
type Strength = "faint" | "usual" | "bold";
const STRENGTH: Record<Strength, { opacity: number; intensity: number }> = {
  faint: { opacity: 0.35, intensity: 0.6 },
  usual: { opacity: 0.55, intensity: 1 },
  bold: { opacity: 0.8, intensity: 1.6 },
};

const DAYS = [
  { label: "Today", condition: "rain", low: 9, high: 14, precip: 80 },
  { label: "Sat", condition: "partly-cloudy", low: 7, high: 15, precip: 20 },
  { label: "Sun", condition: "clear", low: 6, high: 18 },
  { label: "Mon", condition: "snow", low: -2, high: 3, precip: 60 },
  { label: "Tue", condition: "fog", low: 2, high: 9 },
] as const;

export function Weather() {
  const [condition, setCondition] = useState<WeatherCondition>("cloudy");
  const [where, setWhere] = useState<Where>("header");
  const [tint, setTint] = useState<Tint>("auto");
  const [strength, setStrength] = useState<Strength>("usual");
  const { opacity, intensity } = STRENGTH[strength];
  const style = { "--ca-wx-opacity": opacity } as CSSProperties;
  const effect = <WeatherEffect condition={condition} intensity={intensity} tint={tint} />;

  return (
    <div className="g-tabs-pad" style={style}>
      {where === "page" ? <div className="g-wx-page">{effect}</div> : null}

      <Demo
        title="Options"
        note="Where the weather shows, what colour it borrows, and how much of it there is. Every option respects reduced motion: the picture holds still."
      >
        <div className="g-row g-wide">
          <Select
            label="Condition"
            value={condition}
            onChange={(value) => setCondition(value as WeatherCondition)}
            options={CONDITIONS.map((value) => ({ value, label: WORD[value] }))}
          />
          <SegmentedControl
            label="Where"
            value={where}
            onChange={(value) => setWhere(value as Where)}
            options={[
              { value: "card", label: "Forecast card" },
              { value: "header", label: "Greeting" },
              { value: "page", label: "Whole page" },
            ]}
          />
          <SegmentedControl
            label="Colour"
            value={tint}
            onChange={(value) => setTint(value as Tint)}
            options={[
              { value: "auto", label: "Sky for rain" },
              { value: "ink", label: "Ink" },
              { value: "sky", label: "Sky" },
            ]}
          />
          <SegmentedControl
            label="Strength"
            value={strength}
            onChange={(value) => setStrength(value as Strength)}
            options={[
              { value: "faint", label: "Faint" },
              { value: "usual", label: "Usual" },
              { value: "bold", label: "Bold" },
            ]}
          />
        </div>
      </Demo>

      <Demo
        title={
          where === "card"
            ? "On the Forecast card"
            : where === "header"
              ? "Behind the greeting"
              : "Across the page"
        }
        note={
          where === "card"
            ? "The card is the well; the weather falls in it, behind the words."
            : where === "header"
              ? "The page's head, with the outside reading at its right, becomes the sky."
              : "The page itself weathers; cards stay dry."
        }
      >
        {where === "header" ? (
          <header className={`g-wx-head g-wide ${weatherHost(condition)}`}>
            {effect}
            <div className="g-wx-greeting">
              <h1 className="ca-text-display ca-wx-far">Good evening, Ryan</h1>
              <div>
                <Badge tone="neutral" icon="umbrella" className="ca-wx-near">
                  Rain until 9 pm
                </Badge>
              </div>
            </div>
            <section className="g-wx-outside" aria-label="Weather outside">
              <div className="g-wx-outside-now">
                <Icon name={WEATHER_ICON[condition]} size={32} />
                <div>
                  <span className="g-wx-outside-temp ca-wx-far">11</span>
                  <small>°C outside</small>
                </div>
              </div>
              <span className="g-wx-outside-line ca-wx-near">{WORD[condition]} · H 14° L 9°</span>
            </section>
          </header>
        ) : (
          <div className="g-col" style={{ maxWidth: 420 }}>
            <Forecast
              title="Forecast"
              effect={where === "card" ? { intensity, tint } : false}
              current={{ temperature: 11.4, condition, high: 14, low: 9 }}
              days={DAYS.map((day) => ({ ...day }))}
            />
          </div>
        )}
      </Demo>

      <Demo
        title="Every sky"
        note="Each condition the design system knows, at the chosen colour and strength. A clear day has motes in the light; a clear night, stars."
      >
        <div className="g-wx-grid">
          {CONDITIONS.map((each) => (
            <div key={each} className={`g-wx-tile ${weatherHost(each)}`}>
              <WeatherEffect condition={each} intensity={intensity} tint={tint} />
              <Icon name={WEATHER_ICON[each]} size={24} />
              <span className="ca-wx-near">{WORD[each]}</span>
            </div>
          ))}
        </div>
      </Demo>
    </div>
  );
}
