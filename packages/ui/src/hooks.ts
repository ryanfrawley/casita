// What the overlays, menus and fields share.

import { type MutableRefObject, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** A ref that always holds the latest value, for callbacks read inside long-lived effects. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Calls `fn` on a press anywhere outside `ref`, while `active`. */
export function useOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  fn: (event: Event) => void,
): void {
  const callback = useLatest(fn);
  useEffect(() => {
    if (!active) return;
    const down = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) callback.current(event);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
    };
  }, [active, ref, callback]);
}

export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The overlays open right now, in the order they opened. Escape, pressed anywhere on the
 * page, closes the last of them: a sheet need not hold focus to be dismissed, and a sheet
 * over another closes first. A key an editor or a list has already used is left alone.
 */
const openOverlays: { close: MutableRefObject<(() => void) | undefined> }[] = [];
const closeTopOverlay = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = openOverlays.at(-1);
  if (!top) return;
  event.preventDefault();
  top.close.current?.();
};

/**
 * While `open`: moves focus into the overlay (to `[data-autofocus]` if there is one), closes
 * on Escape pressed anywhere, keeps Tab inside when `trap` is set, and gives focus back on
 * the way out.
 */
export function useOverlay(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: (() => void) | undefined,
  trap: boolean,
): void {
  const close = useLatest(onClose);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
      first.focus({ preventScroll: true });
    }
    const entry = { close };
    if (openOverlays.length === 0) document.addEventListener("keydown", closeTopOverlay);
    openOverlays.push(entry);
    const key = (event: KeyboardEvent) => {
      if (!trap || event.key !== "Tab" || !el) return;
      const focusable = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.getClientRects().length,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === el)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    el?.addEventListener("keydown", key);
    return () => {
      el?.removeEventListener("keydown", key);
      openOverlays.splice(openOverlays.indexOf(entry), 1);
      if (openOverlays.length === 0) document.removeEventListener("keydown", closeTopOverlay);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, ref, close, trap]);
}

export interface OverlayPlacement {
  /** Position inside the nearest positioned parent instead of the viewport. */
  contained?: boolean;
  /** Render into this element instead of in place. */
  container?: Element | null;
}

/** Overlays render in place so they keep the theme of the page around them, unless given a container. */
export const mount = (placement: OverlayPlacement, node: ReactNode): ReactNode =>
  placement.container ? createPortal(node, placement.container) : node;

/** The grid: a block is `GRID_UNIT` tall, with a `GRID_STEP` gutter between blocks. */
export const GRID_UNIT = 56;
export const GRID_STEP = 16;

/**
 * A height rounded up to whole grid units: n units are n pitches (unit and gutter) less a
 * gutter, so 150 becomes 200 and 200 stays. Nothing stays nothing.
 */
export function gridHeight(height: number, unit = GRID_UNIT, step = GRID_STEP): number {
  if (height <= 0) return 0;
  const pitch = unit + step;
  return Math.ceil((height + step) / pitch) * pitch - step;
}

/**
 * Keeps every card under `root` on the page's grid: each element the selector matches is
 * given a `min-height` of the whole number of units its content needs, a unit being `unit`
 * tall with a `step` gutter between units (so n units are n pitches less a gutter), so a
 * card whose blocks are not units themselves (a paragraph, a chart) still ends on a unit,
 * and the cards beside it line up. The natural height is read with the floor cleared, so a
 * card that shrinks is let down again.
 */
export function useGridSnap(
  root: RefObject<HTMLElement | null>,
  selector: string,
  unit = GRID_UNIT,
  step = GRID_STEP,
): void {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const watched = new WeakSet<Element>();
    const lay = () => {
      frame = 0;
      const items = [...el.querySelectorAll<HTMLElement>(selector)];
      for (const item of items) item.style.minHeight = "";
      const heights = items.map((item) => item.getBoundingClientRect().height);
      items.forEach((item, i) => {
        const height = heights[i] ?? 0;
        const snapped = gridHeight(height, unit, step);
        item.style.minHeight = snapped > height ? `${snapped}px` : "";
        if (!watched.has(item)) {
          watched.add(item);
          resize.observe(item);
        }
      });
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(lay);
    };
    const resize = new ResizeObserver(queue);
    const mutation = new MutationObserver(queue);
    mutation.observe(el, { childList: true, subtree: true });
    resize.observe(el);
    lay();
    return () => {
      mutation.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [root, selector, unit, step]);
}
