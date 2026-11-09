"use client";

import { useEffect, useId, useRef } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import ThemeCustomizer from "./theme-customizer";
import { useTheme } from "./theme-provider";

// The header's "Customize Theme" button (a palette icon, in the same glass style as the other header controls) and the floating panel it opens.
// Closing the panel any way other than Apply Theme (the button again, Escape, a click elsewhere) is a Cancel: the saved theme comes back.
// This file is an identical copy in both portals.

export default function ThemeButton() {
  const { open, setOpen, cancel } = useTheme();
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // a click inside ANY customizer (the one in Settings shares this one's state) is not "elsewhere"
    const away = (event: Event) => {
      const target = event.target as Element;
      if (target.closest?.("[data-theme-customizer]")) return;
      if (wrap.current && !wrap.current.contains(target)) cancel();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, cancel]);

  return (
    <div ref={wrap} className="sm:relative">
      <Tooltip label="Customize Theme" side="bottom">
        <button
          type="button"
          aria-label="Customize Theme"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? cancel() : setOpen(true))}
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 ${open ? "border-ix-accent-text/40 bg-ix-accent-text/10 text-ix-accent-text" : "border-ix-mist/15 bg-ix-mist/5 text-ix-muted hover:bg-ix-mist/10 hover:text-ix-accent-text"}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z" />
            <path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01" />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Customize Appearance"
          className="ix-menu absolute inset-x-0 top-full z-50 mt-3 max-h-[calc(100dvh-7rem)] overflow-y-auto p-4 sm:inset-x-auto sm:right-0 sm:w-[27rem] sm:p-5"
        >
          <h2 className="mb-4 flex items-center gap-2.5 text-base font-semibold tracking-tight text-ix-text">
            <span aria-hidden="true" className="h-4 w-1 rounded-full bg-ix-accent-text" />
            Customize Appearance
          </h2>
          <ThemeCustomizer variant="popover" />
        </div>
      )}
    </div>
  );
}
