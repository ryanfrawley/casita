import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setupDom } from "../test-dom.ts";
import { WeatherEffect } from "./weather-effect.tsx";

const dom = setupDom();

/** A root of the test's own, so it can be unmounted mid-test. */
const mount = async (node: ReactNode) => {
  // Required here, not imported: the harness loads the client renderer once there is a DOM.
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await dom.act(() => root.render(node));
  return {
    container,
    update: (next: ReactNode) => dom.act(() => root.render(next)),
    unmount: () => dom.act(() => root.unmount()),
  };
};

// happy-dom has no 2D context, so the effect stops before it draws; these check only that
// mounting, changing and unmounting never throw, and what the canvas is classed.
describe("WeatherEffect", () => {
  test("mounts and unmounts quietly, whatever the sky", async () => {
    for (const condition of [
      "rain",
      "snow",
      "thunderstorm",
      "clear-night",
      "fog",
      "meteor shower",
    ]) {
      const { container, unmount } = await mount(<WeatherEffect condition={condition} />);
      expect(container.querySelector("canvas.ca-wx")).not.toBeNull();
      await unmount();
      expect(container.querySelector("canvas")).toBeNull();
    }
  });

  test("survives a change of condition and intensity while mounted", async () => {
    const { container, update, unmount } = await mount(<WeatherEffect condition="rain" />);
    expect(container.querySelector("canvas")?.className).toBe("ca-wx ca-wx-sky ca-wx-back");
    await update(<WeatherEffect condition="snow" intensity={2} />);
    expect(container.querySelector("canvas")?.className).toBe("ca-wx ca-wx-back");
    await unmount();
  });
});

describe("WeatherEffect's markup", () => {
  test("is two canvases classed ca-wx, one behind the words and one in front", () => {
    expect(renderToStaticMarkup(<WeatherEffect condition="snow" />)).toBe(
      '<canvas class="ca-wx ca-wx-back"></canvas><canvas class="ca-wx ca-wx-front"></canvas>',
    );
  });

  test("rain under the default tint borrows the sky accent", () => {
    expect(renderToStaticMarkup(<WeatherEffect condition="rain" />)).toBe(
      '<canvas class="ca-wx ca-wx-sky ca-wx-back"></canvas><canvas class="ca-wx ca-wx-sky ca-wx-front"></canvas>',
    );
  });

  test("a tint given outright wins over the condition's own", () => {
    expect(renderToStaticMarkup(<WeatherEffect condition="snow" tint="sky" />)).toBe(
      '<canvas class="ca-wx ca-wx-sky ca-wx-back"></canvas><canvas class="ca-wx ca-wx-sky ca-wx-front"></canvas>',
    );
    expect(renderToStaticMarkup(<WeatherEffect condition="rain" tint="ink" />)).toBe(
      '<canvas class="ca-wx ca-wx-back"></canvas><canvas class="ca-wx ca-wx-front"></canvas>',
    );
  });

  test("an unknown condition is still a plain pair of canvases", () => {
    expect(renderToStaticMarkup(<WeatherEffect condition="meteor shower" />)).toBe(
      '<canvas class="ca-wx ca-wx-back"></canvas><canvas class="ca-wx ca-wx-front"></canvas>',
    );
  });

  test("a className passes through after its own", () => {
    expect(renderToStaticMarkup(<WeatherEffect condition="rain" className="here" />)).toBe(
      '<canvas class="ca-wx ca-wx-sky here ca-wx-back"></canvas><canvas class="ca-wx ca-wx-sky here ca-wx-front"></canvas>',
    );
  });
});
