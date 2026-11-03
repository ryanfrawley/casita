import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { SegmentedControl } from "./segmented-control.tsx";
import { Stepper } from "./stepper.tsx";

type Mode = "heat" | "cool" | "auto" | "off";

export interface ThermostatProps {
  name: string;
  /** The room's reading; `null` when there is none. */
  current: number | null;
  /** The confirmed set point. */
  target: number | null;
  mode: Mode;
  /**
   * What the device reports it is doing. Left out when the device does not say: the header
   * then names the mode it is set to, and claims nothing about the equipment.
   */
  action?: "heating" | "cooling" | "idle" | null;
  onTargetChange?: (next: number) => void;
  onModeChange?: (mode: string) => void;
  /** A set point sent and not yet confirmed. */
  pendingTarget?: number | null;
  /** A mode sent and not yet confirmed. */
  pendingMode?: string | null;
  humidity?: number;
  area?: string;
  /** Default "°C". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  modes?: string[];
  level?: "control" | "read";
  available?: boolean;
  /** Shown as the tooltip. */
  entityId?: string;
  className?: string;
}

const HVAC_MODE: Record<string, string> = { heat: "Heat", cool: "Cool", auto: "Auto", off: "Off" };
const modeWord = (mode: string) => HVAC_MODE[mode] ?? mode;
const degrees = (value: number) => `${Number(value.toFixed(1))}°`;

interface Action {
  icon: string;
  tone: "pending" | "off" | "heat" | "cool" | "idle";
  text: string;
  spin?: boolean;
}

/**
 * A climate entity: the room's reading, what it's doing, the target and the mode. An exemplar,
 * built from Icon, Stepper and SegmentedControl.
 */
export function Thermostat({
  name,
  current,
  target,
  mode = "off",
  action: doing,
  onTargetChange,
  onModeChange,
  pendingTarget,
  pendingMode,
  humidity,
  area,
  unit = "°C",
  min = 7,
  max = 30,
  step = 0.5,
  modes = ["heat", "cool", "auto", "off"],
  level,
  available,
  entityId,
  className,
}: ThermostatProps) {
  const readOnly = level === "read";
  const unavailable = available === false;
  const sending = pendingTarget != null;
  // The header says what the device reports it is doing, in one word; the target number
  // appears once, in the target row.
  const action: Action = pendingMode
    ? {
        icon: "loader-circle",
        spin: true,
        tone: "pending",
        text: `Switching to ${modeWord(pendingMode).toLowerCase()}…`,
      }
    : unavailable
      ? { icon: "wifi-off", tone: "off", text: "Unavailable" }
      : mode === "off"
        ? { icon: "power", tone: "off", text: "Off" }
        : doing === "heating"
          ? { icon: "flame", tone: "heat", text: "Heating" }
          : doing === "cooling"
            ? { icon: "snowflake", tone: "cool", text: "Cooling" }
            : doing === "idle"
              ? { icon: "check", tone: "idle", text: "Idle" }
              : mode === "heat"
                ? { icon: "flame", tone: "idle", text: "Heat" }
                : mode === "cool"
                  ? { icon: "snowflake", tone: "idle", text: "Cool" }
                  : { icon: "check", tone: "idle", text: modeWord(mode) };
  const caption = [
    unavailable ? (current == null ? "Unavailable" : "Unavailable · last reading") : "Inside now",
    humidity != null && !unavailable ? `${humidity}% humidity` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      className={cx("ca-thermo", `ca-thermo-${action.tone}`, className)}
      aria-label={name}
      title={entityId}
    >
      <header className="ca-thermo-head">
        <div>
          <div className="ca-thermo-name">{name}</div>
          {area ? <div className="ca-thermo-area">{area}</div> : null}
        </div>
        <span className="ca-thermo-action">
          <Icon name={action.icon} size={16} spin={action.spin} />
          {action.text}
        </span>
      </header>
      <div className="ca-thermo-reading">
        <div className="ca-thermo-now">
          <span>{current == null ? "—" : current.toFixed(1)}</span>
          <span className="ca-thermo-unit">{unit}</span>
        </div>
        <div className="ca-thermo-caption">{caption}</div>
      </div>
      <div className="ca-thermo-row">
        <span className={cx("ca-thermo-label", sending && "ca-thermo-sending")}>
          Target
          {sending ? (
            <span className="ca-thermo-sendword" role="status">
              <Icon name="loader-circle" size={12} spin />
              Sending…
            </span>
          ) : null}
        </span>
        {mode === "off" || target == null ? (
          <span className="ca-thermo-none">{mode === "off" ? "No target" : "—"}</span>
        ) : readOnly || unavailable ? (
          <span className="ca-thermo-static">{degrees(target)}</span>
        ) : (
          <Stepper
            label={`${name || "Thermostat"} target`}
            value={target}
            pendingValue={pendingTarget}
            pending={sending}
            showSpinner={false}
            min={min}
            max={max}
            step={step}
            formatValue={degrees}
            onChange={onTargetChange}
          />
        )}
      </div>
      {readOnly ? (
        <div className="ca-thermo-foot">
          <Icon name="lock" size={14} />
          View only · {modeWord(mode)} mode
        </div>
      ) : (
        <SegmentedControl
          label="Mode"
          options={modes.map((value) => ({ value, label: modeWord(value) }))}
          value={pendingMode ?? mode}
          onChange={onModeChange}
          className="ca-thermo-modes"
        />
      )}
    </section>
  );
}
