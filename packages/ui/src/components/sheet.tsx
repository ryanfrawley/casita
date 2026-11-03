import { type ReactNode, useId, useRef } from "react";
import { mount, type OverlayPlacement, useOverlay } from "../hooks.ts";
import { cx } from "../util.ts";
import { IconButton } from "./icon-button.tsx";

export interface SheetProps extends OverlayPlacement {
  open: boolean;
  onClose?: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  /** Dims the page and traps focus. Without it the list behind stays usable. */
  modal?: boolean;
  closeLabel?: string;
  className?: string;
}

/** A panel from the right edge for detail and editing, so the list it came from stays in view. */
export function Sheet(props: SheetProps) {
  const { open, onClose, title, subtitle, actions, children, footer, width, modal } = props;
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  useOverlay(ref, open, onClose, Boolean(modal));
  if (!open) return null;
  const panel = (
    <aside
      ref={ref}
      role="dialog"
      aria-modal={modal ? true : undefined}
      aria-labelledby={`${id}-t`}
      tabIndex={-1}
      className={cx("ca-sheet", props.contained && "ca-contained", props.className)}
      style={width ? { width } : undefined}
    >
      <header className="ca-sheet-head">
        <div className="ca-sheet-titles">
          <h2 id={`${id}-t`} className="ca-sheet-title">
            {title}
          </h2>
          {subtitle ? <div className="ca-sheet-sub">{subtitle}</div> : null}
        </div>
        {actions ? <div className="ca-sheet-actions">{actions}</div> : null}
        <IconButton icon="x" label={props.closeLabel ?? "Close"} onClick={onClose} />
      </header>
      <div className="ca-sheet-body">{children}</div>
      {footer ? <footer className="ca-sheet-foot">{footer}</footer> : null}
    </aside>
  );
  return mount(
    props,
    modal ? (
      // biome-ignore lint/a11y/noStaticElementInteractions: the scrim is not a control; Escape is the keyboard's way out
      <div
        className={cx("ca-scrim", "ca-scrim-sheet", props.contained && "ca-contained")}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose?.();
        }}
      >
        {panel}
      </div>
    ) : (
      panel
    ),
  );
}
