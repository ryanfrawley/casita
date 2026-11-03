import { useLayoutEffect, useRef, useState } from "react";
import { clampZoom, osmPageUrl, osmTileUrl, type Tile, tilesFor } from "../map-math.ts";
import { cx } from "../util.ts";

export interface MapViewProps {
  /** The centre of the view; without both, the map says it has no location. */
  latitude?: number;
  longitude?: number;
  /** 0 (the world) to 19 (a street); 15 is a neighbourhood. */
  zoom?: number;
  /** In px; the width is the container's. */
  height?: number;
  /** A pin at the centre. */
  marker?: boolean;
  /** Degrees clockwise from north: the pin points that way. */
  heading?: number;
  /** What a screen reader calls the map. */
  label: string;
  /** Tiles darkened to sit in a dark theme. */
  dark?: boolean;
  /** Where each tile is fetched from; OpenStreetMap's standard tiles unless given. */
  tileUrl?: (tile: Tile) => string;
  className?: string;
}

/** The width drawn for before the container has been measured (and where it cannot be). */
const UNMEASURED = 400;

/**
 * A still map of one place: the tiles that cover the view, a pin, and the attribution the tile
 * server requires. It does not pan or zoom; the attribution opens the place on OpenStreetMap.
 */
export function MapView({
  latitude,
  longitude,
  zoom,
  height = 200,
  marker = true,
  heading,
  label,
  dark,
  tileUrl = osmTileUrl,
  className,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(UNMEASURED);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const located =
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude);
  const z = clampZoom(zoom);
  const tiles = located ? tilesFor(latitude, longitude, z, width, height) : [];
  return (
    <div
      ref={ref}
      className={cx("ca-map", dark && "ca-map-dark", !located && "ca-map-empty", className)}
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {located ? (
        <>
          <div className="ca-map-tiles">
            {tiles.map((tile) => (
              <img
                key={`${tile.z}/${tile.x}/${tile.y}/${tile.left}`}
                className="ca-map-tile"
                src={tileUrl(tile)}
                alt=""
                draggable={false}
                decoding="async"
                // The page sends no referrer off the site; OpenStreetMap refuses a tile without one.
                referrerPolicy="strict-origin-when-cross-origin"
                style={{ left: `calc(50% + ${tile.left}px)`, top: `calc(50% + ${tile.top}px)` }}
              />
            ))}
          </div>
          {marker ? (
            <span
              className={cx("ca-map-pin", typeof heading === "number" && "ca-map-pin-heading")}
              style={
                typeof heading === "number" ? { transform: `rotate(${heading}deg)` } : undefined
              }
            />
          ) : null}
          <a
            className="ca-map-credit"
            href={osmPageUrl(latitude, longitude, z)}
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap
          </a>
        </>
      ) : (
        <span className="ca-map-none">No location</span>
      )}
    </div>
  );
}
