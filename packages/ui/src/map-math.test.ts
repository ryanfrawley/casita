import { expect, test } from "bun:test";
import { clampZoom, osmPageUrl, osmTileUrl, project, TILE_SIZE, tilesFor } from "./map-math.ts";

/** Where the world's latitude runs out: the top edge of the top row of tiles. */
const EDGE = 85.05112878;
/** The latitude an eighth of the world's height above the equator: mid-row at zoom 2. */
const MID_ROW = (Math.atan(Math.sinh(Math.PI / 4)) * 180) / Math.PI;

test.each([
  [2.4, 2],
  [2.5, 3],
  [0, 0],
  [-3, 0],
  [19, 19],
  [25, 19],
])("a zoom of %p is drawn at %p", (zoom, expected) => {
  expect(clampZoom(zoom)).toBe(expected);
});

test("a zoom that is not a number is 15", () => {
  expect(clampZoom(undefined)).toBe(15);
  expect(clampZoom(Number.NaN)).toBe(15);
  expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(15);
});

test("the equator at the prime meridian is the centre of the world", () => {
  expect(project(0, 0, 0)).toEqual({ x: TILE_SIZE / 2, y: TILE_SIZE / 2 });
  expect(project(0, 0, 3)).toEqual({ x: 4 * TILE_SIZE, y: 4 * TILE_SIZE });
});

test("longitude -180 is the world's left edge and 180 its right", () => {
  expect(project(0, -180, 2).x).toBe(0);
  expect(project(0, 180, 2).x).toBe(4 * TILE_SIZE);
  expect(project(0, 90, 0).x).toBe(TILE_SIZE * 0.75);
});

test("a latitude past where Mercator runs out is drawn at the world's top or bottom edge", () => {
  expect(project(EDGE, 0, 0).y).toBeCloseTo(0, 6);
  expect(project(-EDGE, 0, 0).y).toBeCloseTo(TILE_SIZE, 6);
  expect(project(90, 0, 0).y).toBe(project(EDGE, 0, 0).y);
  expect(project(-90, 0, 0).y).toBe(project(-EDGE, 0, 0).y);
  expect(project(89, 0, 0).y).toBe(project(EDGE, 0, 0).y);
  // A northern latitude is above the equator, a southern one below.
  expect(project(45, 0, 0).y).toBeLessThan(TILE_SIZE / 2);
  expect(project(-45, 0, 0).y).toBeGreaterThan(TILE_SIZE / 2);
});

test("a view centred on a tile corner takes the four tiles that meet there", () => {
  const tiles = tilesFor(0, 0, 1, 256, 256);
  expect(tiles).toEqual([
    { z: 1, x: 0, y: 0, left: -256, top: -256 },
    { z: 1, x: 1, y: 0, left: 0, top: -256 },
    { z: 1, x: 0, y: 1, left: -256, top: 0 },
    { z: 1, x: 1, y: 1, left: 0, top: 0 },
  ]);
});

test("a view centred mid-tile takes only the tiles it overlaps", () => {
  // At zoom 2 longitude -45 is the middle of column 1, and MID_ROW the middle of row 1.
  expect(tilesFor(MID_ROW, -45, 2, 200, 200).map(({ x, y }) => `${x}/${y}`)).toEqual(["1/1"]);
  // 300 wide reaches 22px into the tiles either side; 100 high stays in its row.
  const wide = tilesFor(MID_ROW, -45, 2, 300, 100);
  expect(wide.map(({ x, y }) => `${x}/${y}`)).toEqual(["0/1", "1/1", "2/1"]);
  expect(wide.map((tile) => tile.left)).toEqual([-384, -128, 128]);
  for (const tile of wide) expect(tile.top).toBeCloseTo(-128, 6);
});

test("every tile drawn overlaps the view, and together they cover it", () => {
  const width = 640;
  const height = 300;
  const tiles = tilesFor(37.7749, -122.4194, 15, width, height);
  for (const tile of tiles) {
    expect(tile.left).toBeLessThan(width / 2);
    expect(tile.left + TILE_SIZE).toBeGreaterThan(-width / 2);
    expect(tile.top).toBeLessThan(height / 2);
    expect(tile.top + TILE_SIZE).toBeGreaterThan(-height / 2);
  }
  const lefts = tiles.map((tile) => tile.left);
  const tops = tiles.map((tile) => tile.top);
  expect(Math.min(...lefts)).toBeLessThanOrEqual(-width / 2);
  expect(Math.max(...lefts) + TILE_SIZE).toBeGreaterThanOrEqual(width / 2);
  expect(Math.min(...tops)).toBeLessThanOrEqual(-height / 2);
  expect(Math.max(...tops) + TILE_SIZE).toBeGreaterThanOrEqual(height / 2);
  expect(new Set(tiles.map(({ x, y }) => `${x}/${y}`)).size).toBe(tiles.length);
});

test("across the antimeridian the columns wrap onto the world, and keep their place in the view", () => {
  const east = tilesFor(MID_ROW, 180, 1, 256, 1);
  expect(east.map(({ x, left }) => [x, left])).toEqual([
    [1, -256],
    [0, 0],
  ]);
  const west = tilesFor(MID_ROW, -180, 1, 256, 1);
  expect(west.map(({ x, left }) => [x, left])).toEqual([
    [1, -256],
    [0, 0],
  ]);
});

test("rows above the top of the world and below its bottom are not fetched", () => {
  const top = tilesFor(EDGE, 0, 1, 256, 256);
  expect(top.map(({ x, y }) => `${x}/${y}`)).toEqual(["0/0", "1/0"]);
  const bottom = tilesFor(-EDGE, 0, 1, 256, 256);
  expect(bottom.map(({ x, y }) => `${x}/${y}`)).toEqual(["0/1", "1/1"]);
});

test("at zoom 0 the whole world is one tile", () => {
  expect(tilesFor(0, 0, 0, 256, 256)).toEqual([{ z: 0, x: 0, y: 0, left: -128, top: -128 }]);
  // Wider than the world, the one tile repeats either side.
  const wide = tilesFor(0, 0, 0, 600, 256);
  expect(wide.map(({ x, y }) => `${x}/${y}`)).toEqual(["0/0", "0/0", "0/0"]);
  expect(wide.map((tile) => tile.left)).toEqual([-384, -128, 128]);
});

test("tiles are taken at the zoom the server has", () => {
  expect(tilesFor(0, 0, 0.4, 256, 256)[0]?.z).toBe(0);
  expect(tilesFor(0, 0, 30, 256, 256)[0]?.z).toBe(19);
});

test("a tile is fetched from OpenStreetMap's standard tiles", () => {
  expect(osmTileUrl({ z: 15, x: 5241, y: 12665 })).toBe(
    "https://tile.openstreetmap.org/15/5241/12665.png",
  );
});

test("the page on openstreetmap.org marks the point and opens at the zoom drawn", () => {
  expect(osmPageUrl(51.5, -0.12345678, 15.6)).toBe(
    "https://www.openstreetmap.org/?mlat=51.50000&mlon=-0.12346#map=16/51.50000/-0.12346",
  );
  expect(osmPageUrl(0, 0, Number.NaN)).toBe(
    "https://www.openstreetmap.org/?mlat=0.00000&mlon=0.00000#map=15/0.00000/0.00000",
  );
});
