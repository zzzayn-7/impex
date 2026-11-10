"use client";

import { useEffect, useId, useRef } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import "./dashboard-layout.css";
import { useDashboardLayoutOptional } from "./layout-provider";
import WidgetIconGlyph, { LayoutGridIcon } from "./widget-icons";

// The header's "Add Widgets" button and the panel it opens ("Your Widgets"): the cards the person removed from Home, each with an Add Widget button, and
// Restore All Widgets. It is shown only on the home page (the layout provider exists only there), looks like Customize Theme, and sits right before it.
// Only widgets this person may use are listed; adding one puts it at the END of the page, once. Nothing is ever deleted: a removed card is only hidden.
// This file is an identical copy in both portals.

export default function AddWidgetsButton() {
  const layout = useDashboardLayoutOptional();
  const panelId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const open = layout?.panelOpen ?? false;
  const setOpen = layout?.setPanelOpen;

  useEffect(() => {
    if (!open || !setOpen) return;
    const away = (event: Event) => { if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);

  if (!layout) return null;
  const { hiddenWidgets, show, showAll, startEdit, order, editing } = layout;

  return (
    <div ref={wrap} className="sm:relative">
      <Tooltip label="Add Widgets" side="bottom">
        <button
          type="button"
          aria-label="Add Widgets"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={editing}
          onClick={() => setOpen?.(!open)}
          className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ix-accent/60 disabled:cursor-not-allowed disabled:opacity-50 ${open ? "border-ix-accent-text/40 bg-ix-accent-text/10 text-ix-accent-text" : "border-ix-mist/15 bg-ix-mist/5 text-ix-muted hover:bg-ix-mist/10 hover:text-ix-accent-text"}`}
        >
          <LayoutGridIcon />
          {hiddenWidgets.length > 0 && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-ix-accent-text ring-2 ring-[color:var(--ix-deep)]" />}
        </button>
      </Tooltip>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Your Widgets"
          className="ix-menu absolute inset-x-0 top-full z-50 mt-3 max-h-[calc(100dvh-7rem)] overflow-y-auto p-4 sm:inset-x-auto sm:right-0 sm:w-[27rem] sm:p-5"
        >
          <h2 className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-ix-text">
            <span aria-hidden="true" className="h-4 w-1 rounded-full bg-ix-accent-text" />
            Your Widgets
          </h2>
          <p className="mb-4 mt-1 text-xs leading-relaxed text-ix-muted">Add previously removed widgets back to your dashboard.</p>

          {hiddenWidgets.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ix-mist/20 px-4 py-7 text-center">
              <span className="ix-widget-well mx-auto"><WidgetIconGlyph name="check" /></span>
              <p className="mt-3 text-sm font-medium text-ix-text">All widgets are on your dashboard.</p>
              <p className="mt-1 text-xs text-ix-muted">Remove a dashboard card to see it here.</p>
            </div>
          ) : (
            <ul aria-label="Removed widgets">
              {hiddenWidgets.map((widget) => (
                <li key={widget.id} className="ix-widget-row" data-widget-row={widget.id}>
                  <span className="ix-widget-well"><WidgetIconGlyph name={widget.icon} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ix-text">{widget.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ix-muted">{widget.description}</p>
                  </div>
                  <button type="button" aria-label={`Add Widget: ${widget.name}`} onClick={() => show(widget.id)} className="ix-bar-button !min-h-9 shrink-0 !px-3 !text-xs" data-primary="true">Add Widget</button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-ix-mist/10 pt-3.5">
            <button type="button" onClick={() => { setOpen?.(false); startEdit(); }} disabled={order.length < 2} className="ix-bar-button !min-h-9 !px-3 !text-xs">Edit Layout</button>
            {hiddenWidgets.length > 0 && <button type="button" onClick={showAll} className="ix-bar-button !min-h-9 !px-3 !text-xs">Restore All Widgets</button>}
          </div>
        </div>
      )}
    </div>
  );
}
