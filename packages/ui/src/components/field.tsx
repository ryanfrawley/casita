import type { ReactNode } from "react";
import { Icon } from "../icon.tsx";

/** The line under a field: its error if it has one, else its hint. Its id is `${id}-d`. */
export function FieldFoot({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (error) {
    return (
      <div id={`${id}-d`} className="ca-field-error">
        <Icon name="triangle-alert" size={14} />
        {error}
      </div>
    );
  }
  return hint ? (
    <div id={`${id}-d`} className="ca-field-hint">
      {hint}
    </div>
  ) : null;
}

export const describedBy = (id: string, error?: ReactNode, hint?: ReactNode): string | undefined =>
  error || hint ? `${id}-d` : undefined;
