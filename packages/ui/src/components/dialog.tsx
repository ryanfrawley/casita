import { type ReactNode, useId, useRef } from "react";
import { mount, type OverlayPlacement, useOverlay } from "../hooks.ts";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";

export interface DialogProps extends OverlayPlacement {
  open: boolean;
  onClose?: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** `danger` is for destructive confirmations; it is announced as an alert. */
  tone?: "neutral" | "danger";
  size?: "sm" | "md";
  /** Default true: a press on the scrim closes it. */
  dismissable?: boolean;
  className?: string;
}

/** A modal question: confirm a destructive action, or a short form that has to finish before going on. */
export function Dialog(props: DialogProps) {
  const { open, onClose, title, description, children, actions, size = "sm", className } = props;
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useOverlay(ref, open, onClose, true);
  if (!open) return null;
  const danger = props.tone === "danger";
  return mount(
    props,
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim is not a control; Escape is the keyboard's way out
    <div
      className={cx("ca-scrim", props.contained && "ca-contained")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && props.dismissable !== false) onClose?.();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: both roles this takes support aria-modal */}
      <div
        ref={ref}
        role={danger ? "alertdialog" : "dialog"}
        aria-modal
        aria-labelledby={`${id}-t`}
        aria-describedby={description ? `${id}-d` : undefined}
        tabIndex={-1}
        className={cx("ca-dialog", `ca-dialog-${size}`, danger && "ca-dialog-danger", className)}
      >
        <div className="ca-dialog-head">
          {danger ? <Icon name="triangle-alert" size={22} className="ca-dialog-icon" /> : null}
          <h2 id={`${id}-t`} className="ca-dialog-title">
            {title}
          </h2>
        </div>
        {description ? (
          <p id={`${id}-d`} className="ca-dialog-desc">
            {description}
          </p>
        ) : null}
        {children ? <div className="ca-dialog-body">{children}</div> : null}
        {actions ? <div className="ca-dialog-actions">{actions}</div> : null}
      </div>
    </div>,
  );
}
