"use client";

import { useEffect } from "react";

// THE VISIBLE PART OF THE SCREEN, for pop-ups.
//
// On a phone the browser's address bar and toolbars, and the on-screen keyboard, cover part of the page. CSS `vh` is the height WITHOUT them (iPhone Safari counts the
// area behind its bars), so a pop-up sized to "90vh" is taller than what the person can see: its title and close button, or its buttons at the bottom, end up under the
// bars and cannot be reached. `dvh` helps but does not follow the keyboard, and older iPhones do not know it.
//
// So while a pop-up is open this keeps two CSS variables on <html> up to date from the browser's visual viewport (the part of the page that is really visible):
//   --ix-vv-h    the visible height, in px
//   --ix-vv-top  how far the visible part is from the top of the page (the keyboard or a toolbar can move it)
// A pop-up centres itself in that area and never grows beyond it (see components/ui/modal.tsx). Where the variables are not set the CSS falls back to 100dvh.
// While the person has pinched the page larger the layout viewport is used instead, so a pop-up does not shrink and jump around under their fingers.

let users = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let frame = 0;

  const apply = () => {
    const zoomed = vv ? vv.scale > 1.01 : false;
    const height = vv && !zoomed ? vv.height : window.innerHeight;
    const top = vv && !zoomed ? vv.offsetTop : 0;
    root.style.setProperty("--ix-vv-h", `${Math.round(height)}px`);
    root.style.setProperty("--ix-vv-top", `${Math.round(top)}px`);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  };

  apply();
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  return () => {
    cancelAnimationFrame(frame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    root.style.removeProperty("--ix-vv-h");
    root.style.removeProperty("--ix-vv-top");
  };
}

/** Keep --ix-vv-h / --ix-vv-top current while `active` (every pop-up that is open shares the one set of listeners). */
export function useVisibleViewport(active = true): void {
  useEffect(() => {
    if (!active) return;
    if (users++ === 0) stop = start();
    return () => {
      if (--users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, [active]);
}
