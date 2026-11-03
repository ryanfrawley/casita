// Addresses with a part that names a thing: `/edit/:id`. Pure, so a page's path can be
// tested without a browser.

/**
 * The parameters when `path` fits `pattern`, else undefined. A `:name` segment takes one
 * segment of the path, decoded; every other segment must match exactly. A trailing slash
 * is tolerated, nothing else is.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const wanted = segments(pattern);
  const given = segments(path);
  if (wanted.length !== given.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of wanted.entries()) {
    const actual = given[i] ?? "";
    if (part.startsWith(":")) {
      if (!actual) return undefined;
      try {
        params[part.slice(1)] = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
    } else if (part !== actual) {
      return undefined;
    }
  }
  return params;
}

const segments = (path: string) => path.replace(/\/+$/, "").split("/").slice(1);

/** Where a device's settings are changed. */
export const DEVICE_SETTINGS_PATH = "/devices/:id/settings";
export const deviceSettingsPath = (deviceId: string): string =>
  `/devices/${encodeURIComponent(deviceId)}/settings`;

/** Where a Casa page is edited. */
export const editPagePath = (pageId: string): string => `/edit/${encodeURIComponent(pageId)}`;

/** Where a theme is edited. */
export const editThemePath = (themeId: string): string =>
  `/edit/theme/${encodeURIComponent(themeId)}`;
/** Where the house's shared components are edited. */
export const EDIT_COMPONENTS_PATH = "/edit/components";
/** Where an automation is edited. */
export const editAutomationPath = (automationId: string): string =>
  `/automations/edit/${encodeURIComponent(automationId)}`;

/** Where a derived sensor is edited. */
export const editSensorPath = (sensorId: string): string =>
  `/automations/sensor/${encodeURIComponent(sensorId)}`;
