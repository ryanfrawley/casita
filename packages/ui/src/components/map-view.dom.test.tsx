// MapView: a still map of one place. The DOM measures nothing, so the view is drawn at the width
// it uses before it has been measured, 400px.

import { describe, expect, test } from "bun:test";
import { tilesFor } from "../map-math.ts";
import { setupDom } from "../test-dom.ts";
import { MapView } from "./map-view.tsx";

const dom = setupDom();

const HOME = { latitude: 37.7749, longitude: -122.4194 };
const tiles = (el: HTMLElement) => [...el.querySelectorAll<HTMLImageElement>("img.ca-map-tile")];
const map = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-map");
const pin = (el: HTMLElement) => el.querySelector<HTMLElement>(".ca-map-pin");

describe("MapView", () => {
  test("draws the tiles that cover the view from OpenStreetMap, sending the site as referrer", async () => {
    const el = await dom.render(<MapView {...HOME} zoom={15} label="Home" />);
    const expected = tilesFor(HOME.latitude, HOME.longitude, 15, 400, 200);
    expect(tiles(el).map((img) => img.getAttribute("src"))).toEqual(
      expected.map(({ z, x, y }) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`),
    );
    for (const img of tiles(el)) {
      expect(img.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
      expect(img.getAttribute("alt")).toBe("");
    }
    // Each tile is placed from the middle of the view.
    const [first] = expected;
    expect(tiles(el)[0]?.getAttribute("style")).toContain(`left: calc(50% + ${first?.left}px)`);
    expect(tiles(el)[0]?.getAttribute("style")).toContain(`top: calc(50% + ${first?.top}px)`);
  });

  test("is one labelled image, as tall as its height", async () => {
    const el = await dom.render(<MapView {...HOME} height={240} label="Car" />);
    expect(map(el)?.getAttribute("role")).toBe("img");
    expect(map(el)?.getAttribute("aria-label")).toBe("Car");
    expect(map(el)?.getAttribute("style")).toBe("height: 240px;");
    expect(map(el)?.className).toBe("ca-map");
  });

  test("is 200px tall, three grid units, when no height is given", async () => {
    const el = await dom.render(<MapView {...HOME} label="Home" />);
    expect(map(el)?.getAttribute("style")).toBe("height: 200px;");
  });

  test("has a pin at the centre unless marker is false", async () => {
    const pinned = await dom.render(<MapView {...HOME} label="Home" />);
    expect(pin(pinned)?.className).toBe("ca-map-pin");
    expect(pin(pinned)?.getAttribute("style")).toBeNull();
    const bare = await dom.render(<MapView {...HOME} marker={false} label="Home" />);
    expect(pin(bare)).toBeNull();
    expect(tiles(bare).length).toBeGreaterThan(0);
  });

  test("a heading turns the pin to point that way", async () => {
    const el = await dom.render(<MapView {...HOME} heading={135} label="Car" />);
    expect(pin(el)?.className).toBe("ca-map-pin ca-map-pin-heading");
    expect(pin(el)?.getAttribute("style")).toBe("transform: rotate(135deg);");
    // Due north is a heading too.
    const north = await dom.render(<MapView {...HOME} heading={0} label="Car" />);
    expect(pin(north)?.getAttribute("style")).toBe("transform: rotate(0deg);");
  });

  test("credits OpenStreetMap with a link that opens the place there, in a new tab", async () => {
    const el = await dom.render(<MapView latitude={51.5} longitude={-0.1} zoom={12} label="L" />);
    const link = el.querySelector("a.ca-map-credit");
    expect(link?.textContent).toBe("© OpenStreetMap");
    expect(link?.getAttribute("href")).toBe(
      "https://www.openstreetmap.org/?mlat=51.50000&mlon=-0.10000#map=12/51.50000/-0.10000",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  test("without both a latitude and a longitude it says so, and fetches nothing", async () => {
    for (const place of [
      {},
      { latitude: 1 },
      { longitude: 1 },
      { latitude: Number.NaN, longitude: 1 },
    ]) {
      const el = await dom.render(<MapView {...place} label="Car" />);
      expect(el.querySelector(".ca-map-none")?.textContent).toBe("No location");
      expect(map(el)?.className).toBe("ca-map ca-map-empty");
      expect(map(el)?.getAttribute("aria-label")).toBe("Car");
      expect(tiles(el)).toHaveLength(0);
      expect(pin(el)).toBeNull();
      expect(el.querySelector("a")).toBeNull();
    }
  });

  test("dark darkens the tiles, and className is added", async () => {
    const el = await dom.render(<MapView {...HOME} dark className="wide" label="Home" />);
    expect(map(el)?.className).toBe("ca-map ca-map-dark wide");
  });

  test("tileUrl says where each tile is fetched from", async () => {
    const el = await dom.render(
      <MapView
        {...HOME}
        zoom={15}
        label="Home"
        tileUrl={({ z, x, y }) => `/tiles/${z}-${x}-${y}`}
      />,
    );
    const expected = tilesFor(HOME.latitude, HOME.longitude, 15, 400, 200);
    expect(tiles(el).map((img) => img.getAttribute("src"))).toEqual(
      expected.map(({ z, x, y }) => `/tiles/${z}-${x}-${y}`),
    );
  });
});
