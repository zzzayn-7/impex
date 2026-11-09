"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { NAV_GROUPS, unreadText, type NavKey } from "@/lib/portal-nav";
import Icon from "./icons";
import { Tooltip } from "./ui/tooltip";

// The Super Admin Portal's navigation, built exactly like the Organization Portal's: on a desktop a fixed 76px glass icon rail that EXPANDS OVER
// the page (the page itself never moves) when the pointer is over it or keyboard focus is inside it, or when the toggle has pinned it open.
// Below the `lg` breakpoint it is an off-canvas drawer opened from the header's menu button, so nothing depends on hover. Escape closes whichever is
// open. The expanding is plain CSS (group-hover / group-focus-within): no flicker, no layout shift, no hydration difference.
// There are no per-item tooltips on purpose: hovering or focusing any icon expands the rail, which shows the labels themselves.

type NavState = { mobileOpen: boolean; setMobileOpen: (open: boolean) => void; pinned: boolean; setPinned: (pinned: boolean) => void };
const NavContext = createContext<NavState | null>(null);

function useNav(): NavState {
  const value = useContext(NavContext);
  if (!value) throw new Error("NavProvider is missing");
  return value;
}

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const value = useMemo(() => ({ mobileOpen, setMobileOpen, pinned, setPinned }), [mobileOpen, pinned]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/** The header's menu button: opens the drawer on small screens only. */
export function MenuButton() {
  const { mobileOpen, setMobileOpen } = useNav();
  return (
    <button
      type="button"
      onClick={() => setMobileOpen(!mobileOpen)}
      aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
      aria-expanded={mobileOpen}
      aria-controls="sa-sidebar"
      className="grid h-11 w-11 place-items-center rounded-2xl border border-ix-mist/15 bg-ix-mist/10 text-ix-text transition duration-200 hover:bg-ix-mist/15 lg:hidden"
    >
      <Icon name={mobileOpen ? "close" : "menu"} />
    </button>
  );
}

const label = "sa-nav-label whitespace-nowrap text-sm font-medium opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[pinned=true]:opacity-100 max-lg:opacity-100";

export function Sidebar({ current, supportUnread = 0 }: { current: NavKey; supportUnread?: number }) {
  const { mobileOpen, setMobileOpen, pinned, setPinned } = useNav();
  const ref = useRef<HTMLElement>(null);

  const dismiss = useCallback(() => {
    setPinned(false);
    setMobileOpen(false);
    const active = document.activeElement;
    if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur(); // focus-within would otherwise keep the rail open
  }, [setMobileOpen, setPinned]);

  // Escape closes the drawer from anywhere on the page (the rail handles it itself, below).
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, setMobileOpen]);

  return (
    <>
      {mobileOpen && <button type="button" aria-label="Close navigation" tabIndex={-1} onClick={() => setMobileOpen(false)} className="fixed inset-0 z-30 bg-ix-deep/60 lg:hidden" />}
      <aside
        id="sa-sidebar"
        ref={ref}
        aria-label="Primary"
        data-pinned={pinned}
        data-mobile-open={mobileOpen}
        onKeyDown={(event) => {
          if (event.key === "Escape") dismiss();
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
        }}
        className={[
          "ix-glass group fixed z-40 flex flex-col overflow-clip print:hidden",
          // desktop: an icon rail inset from the edges that grows over the page
          "lg:inset-y-3 lg:left-3 lg:w-[76px] lg:translate-x-0 lg:visible lg:hover:w-[256px] lg:focus-within:w-[256px] lg:data-[pinned=true]:w-[256px] lg:transition-[width,box-shadow] lg:duration-200 lg:ease-out",
          "lg:hover:shadow-[0_24px_48px_-20px_rgb(var(--ix-shadow-rgb)/0.8)] lg:focus-within:shadow-[0_24px_48px_-20px_rgb(var(--ix-shadow-rgb)/0.8)]",
          // below lg: an off-canvas drawer (invisible, so unreachable by Tab, while closed)
          "max-lg:inset-y-3 max-lg:left-3 max-lg:w-[286px] max-lg:max-w-[calc(100vw-24px)] max-lg:transition-transform max-lg:duration-200",
          mobileOpen ? "max-lg:translate-x-0 max-lg:visible" : "max-lg:-translate-x-[110%] max-lg:invisible",
        ].join(" ")}
      >
        <div className="flex h-[68px] shrink-0 items-center px-3">
          <span className="grid h-[52px] w-[50px] shrink-0 place-items-center" aria-hidden="true">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-ix-butter text-sm font-bold text-ix-on-accent">IX</span>
          </span>
          <span className={`${label} ml-1 tracking-wide text-ix-text`}>Impex</span>
          <Tooltip label={pinned ? "Collapse navigation" : "Pin navigation open"} side="bottom">
            <button
              type="button"
              onClick={(event) => {
                // unpinning with the mouse must let the rail collapse when the pointer leaves: focus-within would otherwise hold it open
                if (pinned && event.detail > 0) event.currentTarget.blur();
                setPinned(!pinned);
              }}
              aria-pressed={pinned}
              aria-label={pinned ? "Collapse navigation" : "Expand navigation"}
              className="ml-auto hidden h-9 w-9 shrink-0 place-items-center rounded-xl text-ix-muted opacity-0 transition duration-200 hover:bg-ix-mist/10 hover:text-ix-accent-text focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[pinned=true]:opacity-100 lg:grid"
            >
              <Icon name={pinned ? "chevronLeft" : "chevronRight"} className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <nav aria-label="Main" className="ix-scroll flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} data-nav-group={group.id} role="group" aria-label={group.label}>
              <div className="relative h-7" aria-hidden="true">
                <span className="absolute inset-x-3 top-1/2 h-px bg-ix-mist/10 transition-opacity duration-200 group-hover:opacity-0 group-focus-within:opacity-0 group-data-[pinned=true]:opacity-0 max-lg:opacity-0" />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] text-ix-muted/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[pinned=true]:opacity-100 max-lg:opacity-100">
                  {group.label}
                </span>
              </div>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active = item.key === current;
                  const unread = item.key === "support" ? supportUnread : 0;
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={`relative flex h-11 items-center rounded-2xl transition-colors duration-200 ${active ? "bg-ix-accent-text/10 text-ix-text shadow-[inset_0_0_0_1px_rgb(var(--ix-accent-text-rgb)/0.3)]" : "text-ix-muted hover:bg-ix-mist/10 hover:text-ix-text"}`}
                      >
                        {active && <span aria-hidden="true" className="absolute -left-3 top-2.5 h-6 w-1 rounded-r-full bg-ix-accent-text" />}
                        {/* the icon box is exactly as wide as the collapsed pill (rail 76px - 1px borders - 2 x 12px padding = 50px), so the icon sits dead centre in the selected pill */}
                        <span className={`relative grid h-11 w-[50px] shrink-0 place-items-center ${active ? "text-ix-accent-text" : ""}`}>
                          <Icon name={item.icon} />
                          {/* collapsed rail: a small pale-yellow dot says "something is waiting"; the count itself shows once expanded */}
                          {unread > 0 && <span aria-hidden="true" className="absolute right-[11px] top-[10px] h-2 w-2 rounded-full bg-ix-accent-text ring-2 ring-[rgb(var(--ix-deep-rgb))] transition-opacity duration-200 group-hover:opacity-0 group-focus-within:opacity-0 group-data-[pinned=true]:opacity-0 max-lg:opacity-0" />}
                        </span>
                        <span className={label}>{item.label}</span>
                        {unread > 0 && (
                          <span aria-label={`${unread} unread`} className={`${label} ml-auto mr-3 rounded-full bg-ix-butter px-1.5 py-0.5 text-[11px] font-semibold leading-none text-ix-on-accent`}>
                            {unreadText(unread)}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
