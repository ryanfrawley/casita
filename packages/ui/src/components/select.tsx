import { type ChangeEvent, type SelectHTMLAttributes, useId } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { describedBy, FieldFoot } from "./field.tsx";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "defaultValue"> {
  options: (SelectOption | { label: string; options: SelectOption[] })[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, event: ChangeEvent<HTMLSelectElement>) => void;
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
}

const option = (o: SelectOption) => (
  <option key={o.value} value={o.value} disabled={o.disabled}>
    {o.label}
  </option>
);

/** Pick one of a short, fixed list. Native <select> underneath, styled like TextField. */
export function Select({
  options,
  value,
  defaultValue,
  onChange,
  label,
  placeholder,
  hint,
  error,
  mono,
  className,
  id,
  ...rest
}: SelectProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const control =
    value != null
      ? { value }
      : { defaultValue: defaultValue ?? (placeholder != null ? "" : undefined) };
  return (
    <div className={cx("ca-field", error && "ca-field-invalid", className)}>
      {label ? (
        <label htmlFor={fieldId} className="ca-field-label">
          {label}
        </label>
      ) : null}
      <span className="ca-select">
        <select
          id={fieldId}
          className={cx("ca-input", "ca-select-input", mono && "ca-mono")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, error, hint)}
          onChange={(event) => onChange?.(event.target.value, event)}
          {...control}
          {...rest}
        >
          {placeholder != null ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((o) =>
            "options" in o ? (
              <optgroup key={o.label} label={o.label}>
                {o.options.map(option)}
              </optgroup>
            ) : (
              option(o)
            ),
          )}
        </select>
        <Icon name="chevron-down" size={16} className="ca-select-chevron" />
      </span>
      <FieldFoot id={fieldId} error={error} hint={hint} />
    </div>
  );
}
