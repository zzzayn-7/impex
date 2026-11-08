"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// The portals' one tooltip: dark slate-glass, a thin border, a soft shadow and a small pale-yellow indicator (the look is .ix-tip in globals.css).
//   * It is rendered into <body>, so no card's overflow, backdrop-filter or transform can clip or hide it, and it is repositioned to stay inside the
//     viewport (flipping above/below, or left/right, when there is no room).
//   * It never takes pointer events, so it can never block a click. It appears after a short delay, fades out, and is dismissed by Escape, a
//     press, a scroll or a resize.
//   * It opens on hover (mouse only) and on KEYBOARD focus, never from a touch tap. It is a description, not the control's name: pass
//     `describe` only when the control has no visible text of its own; icon-only controls must carry their own aria-label.
// Wrap exactly one control. The wrapper is `display: contents`, so it does not change the layout.

type Side = "top" | "bottom" | "left" | "right";

const GAP = 10;
const EDGE = 8;

export function Tooltip({ label, children, side = "top", delay = 320, describe = false, disabled = false }: {
  label: ReactNode;
  children: ReactNode;
  side?: Side;
  delay?: number;
  /** Also expose the tooltip as the control's accessible description. */
  describe?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const [mounted, setMounted] = useState(false); // in the DOM
  const [shown, setShown] = useState(false); // faded in

  const anchor = () => wrapRef.current?.firstElementChild as HTMLElement | null;

  const hide = useCallback(() => {
    clearTimeout(showTimer.current);
    setShown(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setMounted(false), 170);
  }, []);

  const show = useCallback((wait: number) => {
    clearTimeout(hideTimer.current);
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      setMounted(true);
      requestAnimationFrame(() => setShown(true));
    }, wait);
  }, []);

  useEffect(() => () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current); }, []);

  // Place the tooltip next to its control, inside the viewport.
  useLayoutEffect(() => {
    if (!mounted) return;
    const el = anchor();
    const tip = tipRef.current;
    if (!el || !tip) return;
    const a = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let s: Side = side;
    if (s === "top" && a.top - t.height - GAP < EDGE) s = "bottom";
    else if (s === "bottom" && a.bottom + t.height + GAP > vh - EDGE) s = "top";
    else if (s === "left" && a.left - t.width - GAP < EDGE) s = "right";
    else if (s === "right" && a.right + t.width + GAP > vw - EDGE) s = "left";
    let top: number;
    let left: number;
    if (s === "top" || s === "bottom") {
      top = s === "top" ? a.top - t.height - GAP : a.bottom + GAP;
      left = a.left + a.width / 2 - t.width / 2;
    } else {
      left = s === "left" ? a.left - t.width - GAP : a.right + GAP;
      top = a.top + a.height / 2 - t.height / 2;
    }
    tip.style.left = `${Math.round(Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - t.width - EDGE)))}px`;
    tip.style.top = `${Math.round(Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - t.height - EDGE)))}px`;
  }, [mounted, side, label]);

  // While open: Escape, scrolling and resizing dismiss it; the control gets aria-describedby when asked.
  useEffect(() => {
    if (!mounted) return;
    const el = anchor();
    if (describe && el) el.setAttribute("aria-describedby", id);
    const dismiss = () => hide();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      if (describe && el) el.removeAttribute("aria-describedby");
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [mounted, describe, id, hide]);

  if (disabled || !label) return <>{children}</>;

  return (
    <>
      <span
        ref={wrapRef}
        className="contents"
        onMouseEnter={(e) => { if ((e as unknown as PointerEvent).pointerType !== "touch") show(delay); }}
        onMouseLeave={hide}
        onMouseDown={hide}
        onFocus={(e) => { if (e.target.matches?.(":focus-visible")) show(0); }}
        onBlur={hide}
      >
        {children}
      </span>
      {mounted && typeof document !== "undefined" && createPortal(
        <div ref={tipRef} id={id} role="tooltip" className="ix-tip" data-open={shown ? "true" : "false"} style={{ left: 0, top: 0 }}>{label}</div>,
        document.body,
      )}
    </>
  );
}
