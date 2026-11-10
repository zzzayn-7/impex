"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useDashboardLayout, type MenuState } from "./layout-provider";

// WidgetContextMenu: the small floating glass menu that opens from a card's three-dot button: Remove from Home, Edit Layout.
// It closes on Escape (focus goes back to the button), on a click or touch anywhere else, and on scrolling or resizing (the card moves, the menu would
// not). Arrow keys move through the items. Removing a card hides it from the home page and saves the choice; nothing is deleted.
// This file is an identical copy in both portals.

const MARGIN = 8;

export default function WidgetContextMenu() {
  const { menu, closeMenu, hide, startEdit, byId, order } = useDashboardLayout();
  if (!menu) return null;
  const widget = byId(menu.id);
  if (!widget) return null;
  return <Menu key={`${menu.kind}:${menu.id}:${menu.x}:${menu.y}`} menu={menu} name={widget.name} canEdit={order.length > 1} close={closeMenu} onRemove={() => hide(menu.id)} onEdit={startEdit} />;
}

function Menu({ menu, name, canEdit, close, onRemove, onEdit }: { menu: MenuState; name: string; canEdit: boolean; close: () => void; onRemove: () => void; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Placed at the pointer (or under the three-dot button), then kept inside the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(menu.x, window.innerWidth - width - MARGIN));
    const below = menu.y + height + MARGIN <= window.innerHeight;
    setPosition({ left, top: below ? menu.y : Math.max(MARGIN, menu.y - height) });
  }, [menu.x, menu.y]);

  const items = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  useEffect(() => { items()[0]?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const away = (event: Event) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      menu.origin?.focus({ preventScroll: true });
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [close, menu.origin]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === "Tab") close();
  };

  const run = (action: () => void) => () => { close(); action(); };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} options`}
      data-widget-menu={menu.kind}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? "visible" : "hidden" }}
      className="ix-menu ix-widget-menu"
    >
      <button type="button" role="menuitem" onClick={run(onRemove)} className="ix-menu-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true"><path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12z" /><path d="M4 4l16 16" /></svg>
        Remove from Home
      </button>
      <button type="button" role="menuitem" aria-disabled={!canEdit} onClick={canEdit ? run(onEdit) : undefined} className="ix-menu-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true"><path d="M5 9l-2 3 2 3M19 9l2 3-2 3M9 5l3-2 3 2M9 19l3 2 3-2M3 12h18M12 3v18" /></svg>
        Edit Layout
      </button>
    </div>
  );
}
