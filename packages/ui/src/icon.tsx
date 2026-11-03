import { EXTRA_ICON_PATHS } from "./icon-paths.extra.gen.ts";
import { ICON_PATHS as BUNDLE_ICON_PATHS } from "./icon-paths.gen.ts";
import { cx } from "./util.ts";

/** The design system's bundle, and the Lucide icons added beyond it for naming a house. */
export const ICON_PATHS = { ...BUNDLE_ICON_PATHS, ...EXTRA_ICON_PATHS };
export type IconName = keyof typeof ICON_PATHS;
export type Domain =
  | "light"
  | "switch"
  | "sensor"
  | "binary_sensor"
  | "climate"
  | "cover"
  | "lock"
  | "button";
export type DeviceKind =
  | "heater"
  | "air_conditioner"
  | "fan"
  | "humidifier"
  | "garage_door"
  | "car"
  | "irrigation"
  | "valve";
export type WeatherCondition =
  | "clear"
  | "clear-night"
  | "partly-cloudy"
  | "partly-cloudy-night"
  | "cloudy"
  | "overcast"
  | "fog"
  | "haze"
  | "drizzle"
  | "rain"
  | "pouring"
  | "snow"
  | "hail"
  | "thunderstorm"
  | "windy"
  | "tornado";

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

// Icons that draw the UI's own controls and states, which nothing in the house should be named by.
const CHROME_ICONS = new Set<IconName>([
  "check",
  "loader-circle",
  "wifi-off",
  "triangle-alert",
  "shield",
  "user",
  "eye",
  "search",
  "plus",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "ellipsis",
  "x",
  "minus",
  "copy",
  "info",
  "circle-check",
  "pencil",
  "trash-2",
  "refresh-cw",
  "layout-grid",
  "workflow",
  "history",
  "users",
  "settings",
  "sliders-horizontal",
]);

/** The icons a person may choose for an entity, a device or an area. */
export const PICKABLE_ICONS: IconName[] = ICON_NAMES.filter((name) => !CHROME_ICONS.has(name));

/** Each domain has exactly one icon. */
export const DOMAIN_ICON: Record<Domain, IconName> = {
  light: "lightbulb",
  switch: "toggle-right",
  sensor: "gauge",
  binary_sensor: "activity",
  climate: "thermometer",
  cover: "blinds",
  lock: "lock",
  button: "circle-dot",
};

/** Device kinds that share a domain but deserve their own icon. */
export const DEVICE_ICON: Record<DeviceKind, IconName> = {
  heater: "heater",
  air_conditioner: "air-vent",
  fan: "fan",
  humidifier: "droplets",
  garage_door: "warehouse",
  car: "car",
  irrigation: "sprout",
  valve: "shower-head",
};

/** Weather `condition` values → icon; fall back to `cloud` for anything unknown. */
export const WEATHER_ICON: Record<WeatherCondition, IconName> = {
  clear: "sun",
  "clear-night": "moon",
  "partly-cloudy": "cloud-sun",
  "partly-cloudy-night": "cloud-moon",
  cloudy: "cloudy",
  overcast: "cloud",
  fog: "cloud-fog",
  haze: "haze",
  drizzle: "cloud-drizzle",
  rain: "cloud-rain",
  pouring: "cloud-rain-wind",
  snow: "cloud-snow",
  hail: "cloud-hail",
  thunderstorm: "cloud-lightning",
  windy: "wind",
  tornado: "tornado",
};

const has = <T extends object>(map: T, key: string): key is keyof T & string =>
  Object.hasOwn(map, key);

/** The icon a name stands for: an icon name itself, a domain, or a device kind. */
export function resolveIcon(name: string): IconName | undefined {
  if (has(DOMAIN_ICON, name)) return DOMAIN_ICON[name];
  if (has(DEVICE_ICON, name)) return DEVICE_ICON[name];
  return has(ICON_PATHS, name) ? name : undefined;
}

export interface IconProps {
  /** An icon name, a domain such as `light`, or a device kind such as `garage_door`. */
  name: string;
  size?: number;
  /** Only when the icon stands alone and means something. */
  title?: string;
  spin?: boolean;
  className?: string;
}

/** Lucide outline icon at a 1.5 stroke, drawn in currentColor. */
export function Icon({ name, size = 20, title, spin, className }: IconProps) {
  const icon = resolveIcon(name);
  return (
    <svg
      className={cx("ca-icon", spin && "ca-spin", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the paths are constants in this package
      dangerouslySetInnerHTML={{ __html: icon ? ICON_PATHS[icon] : "" }}
    />
  );
}
