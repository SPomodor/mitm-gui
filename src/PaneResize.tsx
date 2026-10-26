import { t, useLocale } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const HANDLE = 6;
type Options = {
  initial: number;
  min: number;
  otherMin: number;
  max?: number;
  axis?: "x" | "y";
  ratio?: boolean;
};
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function usePaneResize(
  key: string,
  {
    initial,
    min,
    otherMin,
    max = Infinity,
    axis = "x",
    ratio = false,
  }: Options,
) {
  const storageKey = `chls-layout-${key}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved > 0 && saved < (ratio ? 1 : 5000)
        ? saved
        : initial;
    } catch {
      return initial;
    }
  });
  const [extent, setExtent] = useState(0);
  const drag = useRef<{
    offset: number;
    value: number;
    start: number;
    frame: number;
    element: HTMLElement;
    pointer: number;
  } | null>(null);
  const available = Math.max(0, extent - HANDLE);
  // Preserve usable panes when the window becomes smaller than their preferred widths.
  const shrink = available ? Math.min(1, available / (min + otherMin)) : 1;
  const lower = min * shrink;
  const upper = Math.max(
    lower,
    Math.min(max, available ? available - otherMin * shrink : max),
  );
  const size = clamp(
    ratio ? preferred * (available || 1000) : preferred,
    lower,
    upper,
  );
  const save = (value: number) => {
    setPreferred(value);
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      /* Layout remains usable if storage is unavailable. */
    }
  };
  const finish = (value?: number) => {
    const current = drag.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    drag.current = null;
    document.documentElement.removeAttribute("data-resize-axis");
    if (current.element.hasPointerCapture(current.pointer))
      current.element.releasePointerCapture(current.pointer);
    save(value ?? current.value);
  };
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next =
        axis === "x" ? entry.contentRect.width : entry.contentRect.height;
      if (next > 0) setExtent(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [axis]);
  useEffect(() => {
    const blur = () => finish();
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      if (drag.current) {
        cancelAnimationFrame(drag.current.frame);
        drag.current = null;
        document.documentElement.removeAttribute("data-resize-axis");
      }
    };
  }, [storageKey]);
  const fromPoint = (event: PointerEvent<HTMLElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return preferred;
    const pixels = clamp(
      (axis === "x" ? event.clientX - rect.left : event.clientY - rect.top) -
        (drag.current?.offset ?? 0),
      lower,
      upper,
    );
    return ratio ? pixels / Math.max(1, available) : pixels;
  };
  const reset = () => {
    setPreferred(initial);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Optional persistence. */
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      !available ||
      document.documentElement.dataset.resizeAxis
    )
      return;
    event.preventDefault();
    event.currentTarget.focus();
    const rect = containerRef.current!.getBoundingClientRect();
    drag.current = {
      offset:
        (axis === "x" ? event.clientX - rect.left : event.clientY - rect.top) -
        size,
      value: preferred,
      start: preferred,
      frame: 0,
      element: event.currentTarget,
      pointer: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.dataset.resizeAxis = axis;
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    current.value = fromPoint(event);
    if (!current.frame)
      current.frame = requestAnimationFrame(() => {
        current.frame = 0;
        setPreferred(current.value);
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp",
      increase = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      finish(drag.current.start);
      return;
    }
    if (![decrease, increase, "Home", "End", "Enter"].includes(event.key))
      return;
    if (!available && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") return reset();
    const pixels =
      event.key === "Home"
        ? lower
        : event.key === "End"
          ? upper
          : clamp(
              size +
                (event.key === increase ? 1 : -1) * (event.shiftKey ? 48 : 16),
              lower,
              upper,
            );
    save(ratio ? pixels / Math.max(1, available) : pixels);
  };
  return {
    containerRef,
    size,
    separator: {
      axis,
      size,
      lower,
      upper: Number.isFinite(upper) ? upper : size,
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: PointerEvent<HTMLElement>) => finish(fromPoint(e)),
      onPointerCancel: () => finish(),
      onLostPointerCapture: () => finish(),
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}

export function PaneSeparator({
  label,
  pane,
}: {
  label: string;
  pane: ReturnType<typeof usePaneResize>;
}) {
  useLocale();
  const { axis, size, lower, upper, ...events } = pane.separator;
  return (
    <div
      {...events}
      className={`pane-separator pane-separator-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(lower)}
      aria-valuemax={Math.round(upper)}
      aria-valuenow={Math.round(size)}
      title={t(
        "{0}. Потяните разделитель или используйте стрелки. Двойной щелчок — сброс размера.",
        [label],
      )}
    />
  );
}
