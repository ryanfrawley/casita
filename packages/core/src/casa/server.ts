// casa/server.ts
// The parts of Casa only the server runs: pages in SQLite, handlers on the bus, and the
// generator that seeds Home. Exported from the core's main entry, not from `./casa`.

export {
  AUTOMATION_ID,
  type AutomationRecord,
  AutomationStore,
  type AutomationStoreDeps,
  type AutomationSummary,
  type AutomationVersion,
  type SaveAutomationResult,
} from "./automations.ts";
export {
  SENSOR_INTEGRATION,
  type SensorInfo,
  SensorRuntime,
  type SensorRuntimeDeps,
} from "./derived.ts";
export { EMPTY_HOUSE_HINT, stockHome } from "./stock.ts";
export {
  type HandlerStatus,
  PageRuntime,
  type PageRuntimeDeps,
  type RegisteredInfo,
  type RunEntry,
} from "./runtime.ts";
export {
  type SaveSensorResult,
  SENSOR_ID,
  type SensorRecord,
  SensorStore,
  type SensorStoreDeps,
  type SensorSummary,
  type SensorVersion,
} from "./sensors.ts";
export {
  type ComponentsRecord,
  type PageRecord,
  PageStore,
  type PageStoreDeps,
  type PageSummary,
  type PageVersion,
  type SaveComponentsResult,
  type SaveResult,
  type ThemeRecord,
  themeSource,
} from "./store.ts";
