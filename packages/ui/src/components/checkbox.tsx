import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "type" | "checked"> {
  checked?: boolean;
  onChange?: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
  label?: ReactNode;
  hint?: string;
  indeterminate?: boolean;
}

/** A checkbox: one boolean in a form, or one row picked out of many. Native input underneath. */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  indeterminate,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <span className={cx("ca-cb-field", rest.disabled && "ca-cb-disabled", className)}>
      <span className="ca-cb">
        <input
          ref={ref}
          id={fieldId}
          type="checkbox"
          className="ca-cb-input"
          checked={checked}
          aria-describedby={hint ? `${fieldId}-h` : undefined}
          onChange={(event) => onChange?.(event.target.checked, event)}
          {...rest}
        />
        <span className="ca-cb-box" aria-hidden>
          <Icon name="check" size={14} className="ca-cb-check" />
          <Icon name="minus" size={14} className="ca-cb-dash" />
        </span>
      </span>
      {label ? (
        <span className="ca-cb-text">
          <label htmlFor={fieldId} className="ca-cb-label">
            {label}
          </label>
          {hint ? (
            <span id={`${fieldId}-h`} className="ca-cb-hint">
              {hint}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
