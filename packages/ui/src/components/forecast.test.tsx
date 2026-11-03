import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon, type WeatherCondition } from "../icon.tsx";
import { Forecast, type ForecastDay } from "./forecast.tsx";

const days: ForecastDay[] = [
  { label: "Today", condition: "rain", low: 10, high: 20, precip: 80 },
  { label: "Sat", condition: "clear", low: 5, high: 25, precip: 0 },
  { label: "Sun", condition: "partly-cloudy", low: 12.4, high: 17.6, word: "Bright spells" },
];
const dayItems = (html: string) => html.split('<li class="ca-fc-day"').slice(1);

describe("Forecast", () => {
  test("a section named Forecast, or by its title", () => {
    expect(renderToStaticMarkup(<Forecast days={days} />)).toMatch(
      /^<section class="ca-fc" aria-label="Forecast"><ul class="ca-fc-days ca-wx-near">/,
    );
    const titled = renderToStaticMarkup(<Forecast days={days} title="This week" className="x" />);
    expect(titled).toMatch(/^<section class="ca-fc x" aria-label="This week">/);
    expect(titled).toContain('<div class="ca-fc-title ca-wx-near">This week</div>');
  });

  test("each day: label, icon named by its word, rounded low and high, and a tooltip", () => {
    const [, , sun] = dayItems(renderToStaticMarkup(<Forecast days={days} />));
    expect(sun).toContain('title="Sun · Bright spells · 12.4° to 17.6°"');
    expect(sun).toContain('<span class="ca-fc-label">Sun</span>');
    expect(sun).toContain(
      renderToStaticMarkup(
        <Icon name="cloud-sun" size={20} title="Bright spells" className="ca-fc-icon" />,
      ),
    );
    expect(sun).toContain('<span class="ca-fc-lo">12°</span>');
    expect(sun).toContain('<span class="ca-fc-hi">18°</span>');
    expect(sun).toContain('aria-label="12° to 18°"');
  });

  test("a condition's own word is used when the day gives none", () => {
    const [today] = dayItems(renderToStaticMarkup(<Forecast days={days} />));
    expect(today).toContain('title="Today · Rain · 10° to 20°"');
    expect(today).toContain('aria-label="Rain"');
  });

  test("every bar is on one scale, from the lowest low to the highest high", () => {
    const items = dayItems(renderToStaticMarkup(<Forecast days={days} />));
    const fills = items.map((item) => item.match(/class="ca-rangebar-fill" style="([^"]+)"/)?.[1]);
    // Scale 5 to 25: 10–20 is 25% to 75%, 5–25 the whole bar.
    expect(fills[0]).toBe("left:25%;width:50%");
    expect(fills[1]).toBe("left:0%;width:100%");
  });

  test("precipitation only when there is a chance of it", () => {
    const [today, sat, sun] = dayItems(renderToStaticMarkup(<Forecast days={days} />));
    expect(today).toContain(
      `<span class="ca-fc-precip">${renderToStaticMarkup(<Icon name="umbrella" size={12} />)}80%</span>`,
    );
    // Zero and absent both leave the column empty, so the rows still line up.
    expect(sat).toContain('<span class="ca-fc-precip"></span>');
    expect(sun).toContain('<span class="ca-fc-precip"></span>');
  });

  test("the weather is drawn over the card only when asked, and only with a current sky", () => {
    const plain = renderToStaticMarkup(
      <Forecast days={days} current={{ temperature: 1, condition: "rain" }} />,
    );
    expect(plain).not.toContain("ca-wx-host");
    expect(plain).not.toContain("<canvas");
    const noSky = renderToStaticMarkup(<Forecast days={days} effect />);
    expect(noSky).not.toContain("ca-wx-host");
    expect(noSky).not.toContain("<canvas");
    const rained = renderToStaticMarkup(
      <Forecast days={days} effect current={{ temperature: 1, condition: "rain" }} />,
    );
    expect(rained).toMatch(
      /^<section class="ca-fc ca-wx-host ca-wx-of-rain" aria-label="Forecast"><canvas class="ca-wx ca-wx-sky ca-wx-back"><\/canvas><canvas class="ca-wx ca-wx-sky ca-wx-front"><\/canvas>/,
    );
    // The words say how far off they are, so fog can soften the large ones more than the small.
    expect(rained).toContain('<div class="ca-fc-now-temp ca-wx-far">');
    expect(rained).toContain('<div class="ca-fc-now-word ca-wx-near">');
    const fogged = renderToStaticMarkup(
      <Forecast days={days} effect current={{ temperature: 1, condition: "fog" }} />,
    );
    expect(fogged).toMatch(/^<section class="ca-fc ca-wx-host ca-wx-of-fog"/);
    const tinted = renderToStaticMarkup(
      <Forecast
        days={days}
        effect={{ tint: "sky" }}
        current={{ temperature: 1, condition: "snow" }}
      />,
    );
    expect(tinted).toContain('<canvas class="ca-wx ca-wx-sky ca-wx-back"></canvas>');
  });

  test("no current block unless given", () => {
    expect(renderToStaticMarkup(<Forecast days={days} />)).not.toContain("ca-fc-now");
  });

  test("the current block: icon, rounded temperature, unit, word, and today's high and low", () => {
    const html = renderToStaticMarkup(
      <Forecast
        days={days}
        unit="°F"
        current={{ temperature: 18.6, condition: "cloudy", high: 20.4, low: 9.5 }}
      />,
    );
    expect(html).toContain(
      `<span class="ca-fc-now-icon">${renderToStaticMarkup(<Icon name="cloudy" size={32} />)}</span>`,
    );
    expect(html).toContain(
      '<div class="ca-fc-now-temp ca-wx-far"><span>19</span><small>°F</small></div>',
    );
    expect(html).toContain('<div class="ca-fc-now-word ca-wx-near">Cloudy · H 20° L 10°</div>');
  });

  test("the current block's own word, and no high and low unless both are known", () => {
    const html = renderToStaticMarkup(
      <Forecast days={days} current={{ temperature: 18, condition: "rain", word: "Showers" }} />,
    );
    expect(html).toContain('<div class="ca-fc-now-word ca-wx-near">Showers</div>');
    expect(html).toContain("<small>°C</small>");
  });

  test("an unknown condition draws a cloud, under its own name", () => {
    const sandstorm = "sandstorm" as WeatherCondition;
    const html = renderToStaticMarkup(
      <Forecast
        days={[{ label: "Mon", condition: sandstorm, low: 20, high: 30 }]}
        current={{ temperature: 28, condition: sandstorm }}
      />,
    );
    expect(html).toContain(
      renderToStaticMarkup(
        <Icon name="cloud" size={20} title="sandstorm" className="ca-fc-icon" />,
      ),
    );
    expect(html).toContain('title="Mon · sandstorm · 20° to 30°"');
    expect(html).toContain(renderToStaticMarkup(<Icon name="cloud" size={32} />));
    expect(html).toContain('<div class="ca-fc-now-word ca-wx-near">sandstorm</div>');
  });

  test("a condition named like an Object property is still unknown", () => {
    const html = renderToStaticMarkup(
      <Forecast
        days={[{ label: "Mon", condition: "toString" as WeatherCondition, low: 1, high: 2 }]}
      />,
    );
    expect(html).toContain('aria-label="toString"');
    expect(html).toContain(
      renderToStaticMarkup(<Icon name="cloud" size={20} title="toString" className="ca-fc-icon" />),
    );
  });
});
