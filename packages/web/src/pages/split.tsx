// The editors' two panes, source and preview, with a handle between them to move the line.
// Where the line sits is remembered by this browser, for every editor alike.

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const KEY = "casita.editor-split";
/** The source pane's share of the width when nothing is remembered. */
export const DEFAULT_SPLIT = 0.45;
/** Neither pane narrower than this, in pixels, while the line moves. */
const MIN_SOURCE = 280;
const MIN_PREVIEW = 320;
const STEP = 0.02;

/** A share kept between its bounds; with `width`, also so that both panes keep their minimum. */
export function clampSplit(share: number, width?: number): number {
  let low = 0.15;
  let high = 0.85;
  if (width && width > MIN_SOURCE + MIN_PREVIEW) {
    low = Math.max(low, MIN_SOURCE / width);
    high = Math.min(high, 1 - MIN_PREVIEW / width);
  }
  const wanted = Number.isFinite(share) ? share : DEFAULT_SPLIT;
  return Math.min(high, Math.max(low, wanted));
}

function saved(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return value ? clampSplit(value) : DEFAULT_SPLIT;
  } catch {
    return DEFAULT_SPLIT;
  }
}

function remember(share: number) {
  try {
    localStorage.setItem(KEY, String(share));
  } catch {
    // A browser that keeps nothing still moves the line; it just forgets it.
  }
}

/**
 * The panes' ref and style, and the handle that goes between the two panes: drag it, or focus it
 * and use the arrow keys; a double-click puts it back.
 */
export function useSplit(): {
  ref: (element: HTMLDivElement | null) => void;
  style: CSSProperties;
  handle: ReactNode;
} {
  const [ref, width, panes] = useWidth<HTMLDivElement>();
  const [share, setShare] = useState(saved);
  const dragging = useRef(false);

  const set = useCallback(
    (next: number) => {
      const value = clampSplit(next, panes.current?.clientWidth);
      setShare(value);
      remember(value);
    },
    [panes],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = panes.current?.getBoundingClientRect();
    if (!dragging.current || !box?.width) return;
    set((event.clientX - box.left) / box.width);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: share - STEP,
      ArrowRight: share + STEP,
      Home: 0,
      End: 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next);
  };

  // A narrower window can leave a remembered share too wide for the preview's minimum.
  useEffect(() => {
    if (width) setShare((current) => clampSplit(current, width));
  }, [width]);

  const handle = (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA window splitter; <hr> can't take focus or keys
    <div
      className="app-casa-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the source and preview"
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => set(DEFAULT_SPLIT)}
    />
  );
  return {
    ref,
    style: { "--app-casa-source": `${(share * 100).toFixed(2)}%` } as CSSProperties,
    handle,
  };
}

/**
 * A ref for an element, and its laid-out width followed as it changes (undefined until it is
 * mounted). A callback ref, so an element that appears after a loading state is still measured.
 */
export function useWidth<T extends HTMLElement>(): [
  (element: T | null) => void,
  number | undefined,
  RefObject<T | null>,
] {
  const [width, setWidth] = useState<number>();
  const element = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const ref = useCallback((next: T | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    element.current = next;
    if (!next) return;
    setWidth(next.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => setWidth(next.clientWidth));
    observer.current.observe(next);
  }, []);
  return [ref, width, element];
}

/** Holds the Casa store's width at the preview's while an editor is open; lets go on leaving. */
export function usePinnedWidth(
  casa: { pinWidth: (width: number | undefined) => void },
  width: number | undefined,
): void {
  useEffect(() => {
    if (width) casa.pinWidth(width);
  }, [casa, width]);
  useEffect(() => () => casa.pinWidth(undefined), [casa]);
}
