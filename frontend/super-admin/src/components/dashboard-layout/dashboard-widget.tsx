"use client";

import { useSortable } from "@dnd-kit/sortable";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { WidgetMeta } from "@/lib/dashboard-layout";
import { useDashboardLayout } from "./layout-provider";

// DashboardWidget: one card of the home page, wrapped so that it can be customised without changing what is inside it.
//
//  Normal mode
//   - The card's own surface does nothing special: a click, a right-click and a long press all behave as they always did. The ONLY way to remove a card
//     or start editing is the card's three-dot button (visible on hover and on keyboard focus, and always visible on touch screens). It opens a small
//     menu: Remove from Home, Edit Layout.
//  Edit mode
//   - The card's content is inert (nothing inside it can be clicked while arranging), the card is lifted and wiggles, and a drag handle appears.
//     The handle drags with a mouse, a finger or a pen; with the keyboard the arrow keys move the card (Home and End go to the first and last place).
// This file is an identical copy in both portals.

export default function DashboardWidget({ widget, node, index, count, animateIn, onMoved }: { widget: WidgetMeta; node: ReactNode; index: number; count: number; animateIn: boolean; onMoved: (id: string, to: number) => void }) {
  const { editing, leaving, openMenu, move, menu } = useDashboardLayout();
  const { id, name, size } = widget;
  const sortable = useSortable({ id, disabled: !editing, animateLayoutChanges: () => false });
  const inner = useRef<HTMLDivElement>(null);
  const dots = useRef<HTMLButtonElement>(null);
  const handle = useRef<HTMLButtonElement | null>(null);
  const [entering] = useState(animateIn);
  const refocusHandle = useRef(false);

  // While arranging, nothing inside the card can be clicked, focused or read out as part of the page: only the handle works.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    if (editing) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); } else { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); }
  }, [editing]);

  // A keyboard move re-orders the cards, which moves this element in the document and drops its focus: put it back on the handle.
  useEffect(() => {
    if (refocusHandle.current) { refocusHandle.current = false; handle.current?.focus({ preventScroll: false }); }
  }, [index]);

  const openOptions = () => {
    const r = dots.current?.getBoundingClientRect();
    openMenu({ kind: "options", id, x: r ? r.right - 200 : 0, y: r ? r.bottom + 6 : 0, origin: dots.current });
  };

  const onHandleKey = (event: React.KeyboardEvent) => {
    const to = event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? index + 1
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = Math.max(0, Math.min(count - 1, to));
    if (target === index) return;
    refocusHandle.current = true;
    move(id, target);
    onMoved(id, target);
  };

  const dragging = sortable.isDragging;
  return (
    <div
      ref={sortable.setNodeRef}
      data-widget-id={id}
      data-size={size}
      data-editing={editing ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-leaving={leaving === id ? "true" : undefined}
      data-entering={entering ? "true" : undefined}
      className="ix-widget"
      style={{ ["--ix-jiggle-delay" as string]: `${-((index * 97) % 460) / 1000}s` }}
    >
      <div ref={inner} className="ix-widget-inner">{node}</div>
      {!editing && (
        <button
          ref={dots}
          type="button"
          aria-label={`Options for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === id && menu.kind === "options"}
          onClick={openOptions}
          className="ix-widget-dots"
          data-widget-interactive
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
        </button>
      )}
      {editing && (
        <button
          ref={(el) => { handle.current = el; sortable.setActivatorNodeRef(el); }}
          type="button"
          aria-label={`Move ${name}. Use the arrow keys to change its place, or drag.`}
          title={`Drag to move ${name}`}
          {...sortable.attributes}
          {...sortable.listeners}
          onKeyDown={onHandleKey}
          className="ix-widget-handle"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
            <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
          </svg>
        </button>
      )}
    </div>
  );
}

