import { type InputHTMLAttributes, useId } from "react";
import { cx } from "../util.ts";
import { describedBy, FieldFoot } from "./field.tsx";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  /** The label is for assistive technology only, where a row beside the field already names it. */
  hideLabel?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  mono,
  hideLabel,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className={cx("ca-field", error && "ca-field-invalid", className)}>
      <label
        htmlFor={fieldId}
        className={cx("ca-field-label", hideLabel && "ca-field-label-hidden")}
      >
        {label}
      </label>
      <input
        id={fieldId}
        className={cx("ca-input", mono && "ca-mono")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fieldId, error, hint)}
        {...rest}
      />
      <FieldFoot id={fieldId} error={error} hint={hint} />
    </div>
  );
}
