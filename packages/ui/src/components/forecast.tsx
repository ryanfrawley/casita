import { Icon, WEATHER_ICON, type WeatherCondition } from "../icon.tsx";
import { cx } from "../util.ts";
import { RangeBar } from "./range-bar.tsx";
import { WeatherEffect, type WeatherEffectProps, weatherHost } from "./weather-effect.tsx";

export interface ForecastDay {
  label: string;
  condition: WeatherCondition;
  low: number;
  high: number;
  /** Chance of precipitation, percent. */
  precip?: number;
  /** Overrides the condition's word: "Light rain". */
  word?: string;
}
export interface ForecastProps {
  days: ForecastDay[];
  current?: {
    temperature: number;
    condition: WeatherCondition;
    word?: string;
    high?: number;
    low?: number;
  };
  title?: string;
  /** Default "°C". */
  unit?: string;
  /** Draws the current weather over the card, faintly: rain falls, snow drifts. `true` for the usual. */
  effect?: boolean | Pick<WeatherEffectProps, "intensity" | "tint">;
  className?: string;
}

const WEATHER_WORD: Record<WeatherCondition, string> = {
  clear: "Clear",
  "clear-night": "Clear",
  "partly-cloudy": "Partly cloudy",
  "partly-cloudy-night": "Partly cloudy",
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

/** A condition the map does not know still draws: as a plain cloud, under its own name. */
const icon = (condition: string) =>
  Object.hasOwn(WEATHER_ICON, condition) ? WEATHER_ICON[condition as WeatherCondition] : "cloud";
const word = (condition: string) =>
  Object.hasOwn(WEATHER_WORD, condition) ? WEATHER_WORD[condition as WeatherCondition] : condition;
const degrees = (value: number) => `${Math.round(value)}°`;

/** Today and the days ahead. An exemplar, built from Icon and RangeBar. */
export function Forecast({ days, current, title, unit = "°C", effect, className }: ForecastProps) {
  const low = Math.min(...days.map((day) => day.low));
  const high = Math.max(...days.map((day) => day.high));
  return (
    <section
      className={cx("ca-fc", effect && current && weatherHost(current.condition), className)}
      aria-label={title ?? "Forecast"}
    >
      {effect && current ? (
        <WeatherEffect condition={current.condition} {...(effect === true ? {} : effect)} />
      ) : null}
      {title ? <div className="ca-fc-title ca-wx-near">{title}</div> : null}
      {current ? (
        <div className="ca-fc-now">
          <span className="ca-fc-now-icon">
            <Icon name={icon(current.condition)} size={32} />
          </span>
          <div>
            <div className="ca-fc-now-temp ca-wx-far">
              <span>{Math.round(current.temperature)}</span>
              <small>{unit}</small>
            </div>
            <div className="ca-fc-now-word ca-wx-near">
              {[
                current.word ?? word(current.condition),
                current.high != null && current.low != null
                  ? `H ${degrees(current.high)} L ${degrees(current.low)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      ) : null}
      <ul className="ca-fc-days ca-wx-near">
        {days.map((day) => {
          const said = day.word ?? word(day.condition);
          return (
            <li
              key={day.label}
              className="ca-fc-day"
              title={`${day.label} · ${said} · ${day.low}° to ${day.high}°`}
            >
              <span className="ca-fc-label">{day.label}</span>
              <Icon name={icon(day.condition)} size={20} title={said} className="ca-fc-icon" />
              <span className="ca-fc-precip">
                {day.precip ? (
                  <>
                    <Icon name="umbrella" size={12} />
                    {day.precip}%
                  </>
                ) : null}
              </span>
              <span className="ca-fc-lo">{degrees(day.low)}</span>
              <RangeBar
                min={low}
                max={high}
                from={day.low}
                to={day.high}
                label={`${degrees(day.low)} to ${degrees(day.high)}`}
                className="ca-fc-bar"
              />
              <span className="ca-fc-hi">{degrees(day.high)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
