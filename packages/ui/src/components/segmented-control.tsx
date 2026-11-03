import { useState } from "react";
import { cx } from "../util.ts";

export interface SegmentedControlProps {
  options: { value: string; label: string }[];
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  className?: string;
}

export function SegmentedControl({
  options,
  label,
  value,
  defaultValue,
  onChange,
  className,
}: SegmentedControlProps) {
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value);
  const current = value ?? own;
  return (
    <div className={cx("ca-seg", className)} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const on = option.value === current;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled buttons acting as radios, as the design system draws them
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={cx("ca-seg-opt", on && "ca-seg-on")}
            onClick={() => {
              setOwn(option.value);
              onChange?.(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
