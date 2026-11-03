// The arithmetic behind the map, apart from React so it can be tested as plain functions.
// Positions are Web Mercator pixels at a zoom, the scheme every slippy-map tile server uses.

/** The side of one tile, in px. */
export const TILE_SIZE = 256;
/** OpenStreetMap's standard tiles go no deeper. */
export const MAX_ZOOM = 19;
/** Mercator runs out short of the poles; a latitude past this is drawn at it. */
const MAX_LATITUDE = 85.05112878;

export interface Tile {
  /** The tile's place in the scheme; `x` is already wrapped onto the world. */
  z: number;
  x: number;
  y: number;
  /** Its top-left corner, in px from the centre of the view. */
  left: number;
  top: number;
}

/** A zoom the tile server has: a whole number from 0 to `MAX_ZOOM`, 15 when not a number. */
export const clampZoom = (zoom: number | undefined): number =>
  typeof zoom === "number" && Number.isFinite(zoom)
    ? Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)))
    : 15;

/** Where a latitude and longitude fall on the world at `zoom`, in px from its top-left corner. */
export function project(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const world = TILE_SIZE * 2 ** zoom;
  const lat = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * Math.PI) / 180;
  const x = ((longitude + 180) / 360) * world;
  const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * world;
  return { x, y };
}

/**
 * The tiles that cover a `width` by `height` view centred on a point, and only those: the tile
 * server's policy asks that nothing out of sight be fetched. Across the antimeridian the world
 * repeats; above and below it, there are no tiles.
 */
export function tilesFor(
  latitude: number,
  longitude: number,
  zoom: number,
  width: number,
  height: number,
): Tile[] {
  const z = clampZoom(zoom);
  const count = 2 ** z;
  const centre = project(latitude, longitude, z);
  const first = (px: number) => Math.floor(px / TILE_SIZE);
  const tiles: Tile[] = [];
  for (let ty = first(centre.y - height / 2); ty <= first(centre.y + height / 2 - 1e-9); ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = first(centre.x - width / 2); tx <= first(centre.x + width / 2 - 1e-9); tx++) {
      tiles.push({
        z,
        x: ((tx % count) + count) % count,
        y: ty,
        left: tx * TILE_SIZE - centre.x,
        top: ty * TILE_SIZE - centre.y,
      });
    }
  }
  return tiles;
}

/** OpenStreetMap's standard tile for a place in the scheme. */
export const osmTileUrl = ({ z, x, y }: { z: number; x: number; y: number }): string =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

/** The same view on openstreetmap.org, with a marker at the point. */
export const osmPageUrl = (latitude: number, longitude: number, zoom: number): string => {
  const lat = latitude.toFixed(5);
  const lon = longitude.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${clampZoom(zoom)}/${lat}/${lon}`;
};
