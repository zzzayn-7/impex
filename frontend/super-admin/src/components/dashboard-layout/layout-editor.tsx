"use client";

import {
  DndContext, DragOverlay, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { moveTo } from "@/lib/dashboard-layout";
import "./dashboard-layout.css";
import DashboardWidget from "./dashboard-widget";
import { motionAllowed, useDashboardLayout } from "./layout-provider";
import WidgetContextMenu from "./widget-context-menu";
import WidgetIconGlyph from "./widget-icons";

// DashboardLayoutEditor: the home page's grid of cards, and everything that arranges them.
//
//  - It shows the cards the person has not removed, in their order; every card is the page's own content (`nodes`, built on the server from the real
//    figures), only wrapped. A card with no content right now (its service has nothing to show) is skipped.
//  - Edit Layout: the page behind dims and blurs, the cards lift and wiggle, and a floating bar offers Save Layout, Cancel and Reset Layout. Cards move by
//    dragging their handle (mouse, finger or pen: the card follows the pointer, a dashed slot shows where it will land and the others make room) or by the
//    arrow keys on the handle. Nothing is saved until Save Layout; Escape asks before throwing changes away.
//  - If every card has been removed it shows an empty state with an Add Widgets action instead of a blank page.
// This file is an identical copy in both portals.

/** The card under the pointer wins; between cards, the nearest one does. */
const collision: CollisionDetection = (args) => {
  const inside = pointerWithin(args);
  return inside.length > 0 ? inside : closestCenter(args);
};

export default function DashboardLayoutEditor({ nodes }: { nodes: Record<string, ReactNode> }) {
  const layout = useDashboardLayout();
  const { order, editing, setDraft, byId, setPanelOpen } = layout;
  const visible = order.filter((id) => byId(id) && nodes[id] !== undefined);
  const gridRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const startOrder = useRef<string[]>([]); // the whole order when a drag began, to put back on Escape
  const lastSwap = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  useEffect(() => setMounted(true), []);

  // ---- animated reflow (FLIP): when the order or the set of cards changes, every card that moved slides from where it was to where it is now ----------
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const lastKey = useRef("");
  const measure = useCallback(() => {
    const next = new Map<string, { x: number; y: number }>();
    gridRef.current?.querySelectorAll<HTMLElement>(":scope > [data-widget-id]").forEach((el) => next.set(el.dataset.widgetId!, { x: el.offsetLeft, y: el.offsetTop }));
    return next;
  }, []);
  const key = visible.join("|");
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const now = measure();
    if (lastKey.current !== "" && lastKey.current !== key && motionAllowed()) {
      grid.querySelectorAll<HTMLElement>(":scope > [data-widget-id]").forEach((el) => {
        const before = positions.current.get(el.dataset.widgetId!);
        const after = now.get(el.dataset.widgetId!);
        if (!before || !after || (before.x === after.x && before.y === after.y) || typeof el.animate !== "function") return;
        el.animate([{ transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)` }, { transform: "translate(0, 0)" }], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      });
    }
    positions.current = now;
    lastKey.current = key;
  }, [key, measure]);
  // a resize re-flows the grid by itself: remember the new places without animating them
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => { positions.current = measure(); });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [measure]);

  // ---- dragging ---------------------------------------------------------------------------------------------------------------------------------
  const onDragStart = (event: DragStartEvent) => {
    startOrder.current = order;
    setActiveId(String(event.active.id));
  };
  const onDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const now = Date.now();
    if (now - lastSwap.current < 90) return; // settle after each step so cards of different sizes cannot flip back and forth
    const to = visible.indexOf(String(over.id));
    if (to < 0) return;
    lastSwap.current = now;
    setDraft(moveTo(order, String(active.id), order.indexOf(String(over.id))));
  };
  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const name = byId(String(event.active.id))?.name;
    const place = visible.indexOf(String(event.active.id)) + 1;
    if (name && place > 0) setAnnouncement(`${name} dropped at position ${place} of ${visible.length}.`);
  };
  const onDragCancel = () => {
    setActiveId(null);
    setDraft(startOrder.current);
  };

  const onMoved = (id: string, to: number) => {
    const name = byId(id)?.name;
    if (name) setAnnouncement(`${name} moved to position ${to + 1} of ${visible.length}.`);
  };

  if (visible.length === 0 && !editing) {
    return (
      <>
        <section aria-labelledby="empty-dashboard-heading" className="ix-glass relative flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="ix-widget-well h-12 w-12"><WidgetIconGlyph name="grid" className="h-6 w-6" /></span>
          <h2 id="empty-dashboard-heading" className="text-lg font-semibold tracking-tight text-ix-text">Your dashboard is empty</h2>
          <p className="max-w-md text-sm leading-relaxed text-ix-muted">You have removed every widget from Home. Nothing was deleted: add the ones you want back whenever you like.</p>
          <button type="button" onClick={() => setPanelOpen(true)} className="ix-bar-button mt-1" data-primary="true">Add Widgets</button>
        </section>
        <Toast />
      </>
    );
  }

  const active = activeId ? byId(activeId) : undefined;
  return (
    <>
      {editing && <div className="ix-edit-backdrop" aria-hidden="true" />}
      <DndContext id="impex-dashboard-layout" sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        <SortableContext items={visible} strategy={() => null}>
          <div ref={gridRef} className="ix-widget-grid" data-editing={editing ? "true" : undefined}>
            {visible.map((id, index) => <DashboardWidget key={id} widget={byId(id)!} node={nodes[id]} index={index} count={visible.length} animateIn={mounted} onMoved={onMoved} />)}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }} zIndex={80}>
          {active && nodes[active.id] !== undefined ? <div className="ix-widget-overlay" aria-hidden="true">{nodes[active.id]}</div> : null}
        </DragOverlay>
      </DndContext>
      <WidgetContextMenu />
      {editing && <EditBar />}
      <div role="status" aria-live="polite" data-layout-announcer className="sr-only">{announcement}</div>
      {!editing && <Toast />}
    </>
  );
}

function Toast() {
  const { notice } = useDashboardLayout();
  if (!notice) return null;
  return <div role={notice.tone === "error" ? "alert" : "status"} data-tone={notice.tone} className="ix-layout-toast">{notice.text}</div>;
}

/** The floating controls of the editor. */
function EditBar() {
  const { save, cancel, resetDraft, requestExit, keepEditing, confirmingExit, dirty } = useDashboardLayout();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmingExit) keep.current?.focus(); }, [confirmingExit]);

  if (confirmingExit) {
    return (
      <div role="alertdialog" aria-label="Discard layout changes?" aria-describedby="discard-copy" className="ix-edit-bar">
        <p id="discard-copy" className="text-sm font-medium text-ix-text">Discard your unsaved layout changes?</p>
        <div className="ix-edit-bar-actions">
          <button ref={keep} type="button" onClick={keepEditing} className="ix-bar-button">Keep editing</button>
          <button type="button" onClick={cancel} className="ix-bar-button" data-primary="true">Discard changes</button>
        </div>
      </div>
    );
  }
  return (
    <div role="toolbar" aria-label="Edit layout" className="ix-edit-bar">
      <p className="ix-edit-bar-hint">Drag a card by its handle to move it.<span className="hidden sm:inline"> Esc to cancel.</span></p>
      <div className="ix-edit-bar-actions">
        <button type="button" onClick={resetDraft} className="ix-bar-button">Reset Layout</button>
        <button type="button" onClick={requestExit} className="ix-bar-button">Cancel</button>
        <button type="button" onClick={save} className="ix-bar-button" data-primary="true" disabled={!dirty} title={dirty ? undefined : "Move a card first"}>Save Layout</button>
      </div>
    </div>
  );
}
