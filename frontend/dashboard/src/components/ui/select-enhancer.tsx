"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// EVERY dropdown of the portal is a compact, searchable one: a search box on top, and the list shows five options at a time (the rest scrolls). The pages keep writing an
// ordinary <select>; this component, mounted once, finds each of them, hides it (it stays in the page, is still what the form and the page's state read) and draws the
// dropdown in its place. Choosing an option sets the real <select> and fires its `change` event, so every handler, validation and test of the page works as before.
// A select with `data-native` (or `multiple`) is left alone.

const ROW = 40; // px: five rows are visible at a time
const VISIBLE = 5;

type Option = { index: number; value: string; label: string; disabled: boolean };
type Enhanced = { select: HTMLSelectElement; host: HTMLElement };

const LAYOUT = /^(?:[a-z0-9-]+:)*(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-|col-span-|row-span-|self-|order-|mt-|mb-|ml-|mr-|mx-|my-|m-)/;
const DROP = /^(?:[a-z0-9-]+:)*(?:block|inline-block|flex|appearance-none|pr-\d+|w-full|w-auto)$/;

/** The classes of the real select, split: where it sits (width, margins ...) goes to the wrapper, how it looks (border, colours, padding ...) to the button. */
export function splitClasses(className: string): { layout: string; look: string } {
  const layout: string[] = [];
  const look: string[] = [];
  for (const cls of className.split(/\s+/).filter(Boolean)) {
    if (DROP.test(cls)) continue;
    (LAYOUT.test(cls) ? layout : look).push(cls);
  }
  return { layout: layout.join(" "), look: look.join(" ") };
}

/** React marks every DOM node it owns once it has hydrated it. A select it has not reached yet is left alone: putting a node next to it now would make the server HTML and the client tree disagree (hydration errors). */
function hydrated(select: HTMLSelectElement): boolean {
  const owned = (el: Element | null) => !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  return owned(select) && owned(select.parentElement) && owned(select.parentElement!.lastElementChild);
}

function optionsOf(select: HTMLSelectElement): Option[] {
  return Array.from(select.options).map((o, index) => ({ index, value: o.value, label: o.text.trim(), disabled: o.disabled }));
}

function nameOf(select: HTMLSelectElement): string {
  const own = select.getAttribute("aria-label");
  if (own) return own;
  const escaped = select.id ? (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(select.id) : select.id) : "";
  const byFor = escaped ? document.querySelector<HTMLLabelElement>(`label[for="${escaped}"]`) : null;
  const wrapper = select.closest("label");
  const text = (byFor ?? wrapper)?.childNodes;
  if (!text) return "Choose";
  for (const node of Array.from(text)) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return node.textContent.trim();
  return (byFor ?? wrapper)?.textContent?.trim().slice(0, 40) || "Choose";
}

function Dropdown({ select }: { select: HTMLSelectElement }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const [, tick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  // what the page does to the real select (a controlled value, a reset, new options, disabled) is mirrored on a short interval: React sets those as properties, which nothing observes
  useEffect(() => {
    const handle = setInterval(() => tick((n) => n + 1), 150);
    return () => clearInterval(handle);
  }, []);

  const options = optionsOf(select);
  const selected = select.selectedIndex >= 0 ? options[select.selectedIndex] : undefined;
  const shown = options.filter((o) => !query.trim() || o.label.toLowerCase().includes(query.trim().toLowerCase()));
  const { layout, look } = splitClasses(select.className);
  const disabled = select.disabled;

  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);

  useEffect(() => {
    if (open) {
      const rect = root.current?.getBoundingClientRect();
      setUp(Boolean(rect && rect.bottom + VISIBLE * ROW + 70 > window.innerHeight && rect.top > VISIBLE * ROW + 70));
      setActive(Math.max(0, shown.findIndex((o) => o.index === select.selectedIndex)));
      requestAnimationFrame(() => search.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.children[active]?.scrollIntoView?.({ block: "nearest" }); }, [active, open]);

  function choose(option: Option) {
    if (option.disabled) return;
    select.selectedIndex = option.index;
    select.dispatchEvent(new Event("change", { bubbles: true })); // the page's own onChange runs exactly as it did for the native control
    close();
    root.current?.querySelector("button")?.focus();
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.stopPropagation(); close(); root.current?.querySelector("button")?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (event.key === "Tab") close();
  }

  const name = nameOf(select);
  return (
    <div ref={root} className={`relative ${layout}`} data-ix-dropdown="">
      <button
        type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={name} aria-controls={open ? `${id}-list` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); } }}
        className={`${look} flex w-full items-center justify-between gap-2 text-left`}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? ""}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 text-ix-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div
          onKeyDown={onKey}
          className={`absolute left-0 z-50 w-full min-w-[12rem] rounded-xl border border-ix-mist/20 bg-ix-deep p-1.5 text-ix-text shadow-xl shadow-black/30 ${up ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          <input
            ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label={`Search ${name}`} autoComplete="off" spellCheck={false}
            className="mb-1.5 block w-full rounded-lg border border-ix-mist/15 bg-ix-mist/5 px-3 py-2 text-sm text-ix-text placeholder:text-ix-muted/60 outline-none focus:border-ix-accent/70"
          />
          <ul id={`${id}-list`} ref={list} role="listbox" aria-label={name} className="overflow-y-auto overscroll-contain" style={{ maxHeight: VISIBLE * ROW }} data-visible-rows={VISIBLE}>
            {shown.length === 0 && <li role="presentation" className="px-3 py-2 text-sm text-ix-muted" style={{ height: ROW }}>No matches</li>}
            {shown.map((o, i) => (
              <li
                key={o.index} role="option" aria-selected={o.index === select.selectedIndex} aria-disabled={o.disabled || undefined}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} style={{ height: ROW }}
                className={`flex cursor-pointer items-center truncate rounded-lg px-3 text-sm ${i === active ? "bg-ix-mist/15" : ""} ${o.index === select.selectedIndex ? "font-semibold text-ix-accent" : ""} ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <span className="truncate">{o.label || " "}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Mount ONCE (the root layout does). Finds every <select> now and whenever the page changes. */
export default function SelectEnhancer() {
  const [items, setItems] = useState<Enhanced[]>([]);
  const known = useRef(new Map<HTMLSelectElement, HTMLElement>());
  const counter = useRef(0);

  useEffect(() => {
    const scan = () => {
      let changed = false;
      for (const [select, host] of Array.from(known.current)) {
        if (!select.isConnected) { host.remove(); known.current.delete(select); changed = true; }
      }
      for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>("select"))) {
        if (select.multiple || select.size > 1 || select.hasAttribute("data-native") || known.current.has(select)) continue;
        if (!hydrated(select)) continue; // picked up by a later scan, once React has finished with it
        const host = document.createElement("div");
        host.style.display = "contents";
        host.dataset.ixId = String(counter.current++);
        select.after(host);
        select.setAttribute("data-ix-enhanced", "1");
        select.setAttribute("aria-hidden", "true");
        select.tabIndex = -1;
        known.current.set(select, host);
        changed = true;
      }
      if (changed) setItems(Array.from(known.current, ([select, host]) => ({ select, host })));
    };
    scan();
    let pending = 0;
    const observer = new MutationObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true });
    const handle = setInterval(scan, 700); // a safety net: pages that swap their content without a mutation we can see
    return () => { observer.disconnect(); clearInterval(handle); cancelAnimationFrame(pending); };
  }, []);

  return <>{items.map(({ select, host }) => createPortal(<Dropdown select={select} />, host, host.dataset.ixId))}</>;
}
