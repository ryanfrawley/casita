import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icon.tsx";
import { cx } from "../util.ts";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";

type Tone = "neutral" | "ok" | "pending" | "error";

export interface ToastProps {
  message?: ReactNode;
  children?: ReactNode;
  tone?: Tone;
  title?: string;
  icon?: string;
  action?: { label: string; onClick?: () => void };
  onDismiss?: () => void;
  className?: string;
}

const TOAST_ICON: Record<Tone, string> = {
  neutral: "info",
  ok: "circle-check",
  pending: "loader-circle",
  error: "triangle-alert",
};

/** A short note that something happened: "Saved", "Guests set to Read". */
export function Toast({
  message,
  children,
  tone = "neutral",
  title,
  icon,
  action,
  onDismiss,
  className,
}: ToastProps) {
  return (
    <div
      className={cx("ca-toast", `ca-toast-${tone}`, className)}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon
        name={icon ?? TOAST_ICON[tone]}
        size={18}
        spin={tone === "pending" && !icon}
        className="ca-toast-icon"
      />
      <div className="ca-toast-text">
        {title ? <strong>{title}</strong> : null}
        <span>{message ?? children}</span>
      </div>
      {action ? (
        <Button variant="quiet" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {onDismiss ? <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} /> : null}
    </div>
  );
}

export interface ToastItem extends ToastProps {
  id: string;
  /** Milliseconds before it leaves; 0 keeps it until dismissed or replaced. */
  duration?: number;
}
export interface ToastRegionProps {
  toasts: ToastItem[];
  onDismiss?: (id: string) => void;
  placement?: "bottom-end" | "bottom-start" | "top-end";
  contained?: boolean;
  className?: string;
}

/** Where toasts stack: bottom-right of the viewport, or of a `contained` positioned parent. */
export function ToastRegion({
  toasts,
  onDismiss,
  placement = "bottom-end",
  contained,
  className,
}: ToastRegionProps) {
  return (
    <div
      className={cx("ca-toasts", `ca-toasts-${placement}`, contained && "ca-contained", className)}
      aria-live="polite"
    >
      {toasts.map(({ id, duration: _, ...toast }) => (
        <Toast key={id} {...toast} onDismiss={onDismiss ? () => onDismiss(id) : toast.onDismiss} />
      ))}
    </div>
  );
}

export type NewToast = Omit<ToastItem, "id"> & { id?: string };

/** How long a toast stays: errors and pending ones until dismissed or replaced, others 4s. */
export const toastDuration = (toast: NewToast, fallback = 4000): number =>
  toast.duration ?? (toast.tone === "error" || toast.tone === "pending" ? 0 : fallback);

/** The list after pushing `toast`: one with the same id is replaced in place; the oldest fall off past `max`. */
export function pushToast(list: ToastItem[], toast: ToastItem, max = 3): ToastItem[] {
  const at = list.findIndex((existing) => existing.id === toast.id);
  const next = at >= 0 ? list.with(at, toast) : [...list, toast];
  return next.slice(-max);
}

let nextToast = 0;

/**
 * State for a ToastRegion. `push` returns the toast's id; pushing the same id again replaces
 * that toast (pending → ok).
 */
export function useToasts(options: { duration?: number; max?: number } = {}): {
  toasts: ToastItem[];
  push: (toast: NewToast) => string;
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { duration, max } = options;

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: NewToast) => {
      const id = toast.id ?? `ca-t${++nextToast}`;
      setToasts((list) => pushToast(list, { ...toast, id }, max));
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const stay = toastDuration(toast, duration);
      if (stay)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), stay),
        );
      return id;
    },
    [dismiss, duration, max],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  return { toasts, push, dismiss };
}
