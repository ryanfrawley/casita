import { useEffect, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface ButtonGroupItem {
  key: string;
  label: string;
  icon?: string;
  /** Drawn lit: the thing it stands for is on, or open. */
  active?: boolean;
  /** Something is under way: a ring and a spinner, still pressable unless also disabled. */
  pending?: boolean;
  disabled?: boolean;
  /**
   * Set, the first press arms the segment and shows these words in place of its label; only a
   * second press, before `armedMs` runs out, calls `onPress`.
   */
  confirm?: string;
  onPress: () => void;
}

export interface ButtonGroupProps {
  items: ButtonGroupItem[];
  label: string;
  /** How long an armed segment waits for its second press. */
  armedMs?: number;
  className?: string;
}

/**
 * A row of independent buttons in one track, each lit on its own: unlike SegmentedControl,
 * any number may be on at once, and a press acts rather than chooses.
 */
export function ButtonGroup({ items, label, armedMs = 4000, className }: ButtonGroupProps) {
  // What was asked as well as where: a door that changed under the question is asked anew.
  const [armed, setArmed] = useState<{ key: string; confirm: string } | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), armedMs);
    return () => clearTimeout(timer);
  }, [armed, armedMs]);
  // A segment since disabled, or whose question changed or went, is disarmed for good, so it
  // never comes back armed when it is enabled again.
  const current = armed && items.find((item) => item.key === armed.key);
  const live =
    current && !current.disabled && current.confirm === armed?.confirm ? current.key : null;
  useEffect(() => {
    if (armed !== null && live === null) setArmed(null);
  }, [armed, live]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset's border and legend are not this track
    <div
      className={cx("ca-bgroup", className)}
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape" && live !== null) setArmed(null);
      }}
    >
      {items.map((item) => {
        const isArmed = item.key === live;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={Boolean(item.active)}
            aria-busy={item.pending || undefined}
            aria-label={isArmed ? `${item.confirm} ${item.label}` : undefined}
            disabled={item.disabled}
            className={cx(
              "ca-bgroup-opt",
              item.active && "ca-bgroup-on",
              item.pending && "ca-bgroup-pending",
              isArmed && "ca-bgroup-armed",
            )}
            onClick={() => {
              if (item.confirm && !isArmed) {
                setArmed({ key: item.key, confirm: item.confirm });
                return;
              }
              setArmed(null);
              item.onPress();
            }}
          >
            {item.pending ? (
              <Icon name="loader-circle" size={14} spin />
            ) : item.icon ? (
              <Icon name={item.icon} size={14} />
            ) : null}
            <span className="ca-bgroup-label">{isArmed ? item.confirm : item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
