"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { defaultOrderOf, hideOne, resolveLayout, sameList, showEvery, showOne, moveTo as moveInList, type Layout, type WidgetMeta } from "@/lib/dashboard-layout";
import { rememberLayout, saveLayout, settleLayout } from "./layout-storage";

// DashboardLayoutProvider: the state of the home page's customization, shared by the cards, the header's Add Widgets button and the layout editor.
//
//  * `committed` is the arrangement that is saved for this person (the Auth Service is the record). Removing a card, adding one back and Restore All are
//    saved at once; moving cards is a DRAFT (`draft`) until Save Layout, and Cancel throws it away.
//  * Saving is optimistic: the page changes first, the request follows, and if it fails the page goes back to what is saved and says so. Requests are
//    sent one after another, each carrying the complete arrangement, so the record always ends up as the last thing the person did.
// This file is an identical copy in both portals.

export type MenuKind = "options";
export type MenuState = { kind: MenuKind; id: string; x: number; y: number; origin: HTMLElement | null };
export type Notice = { tone: "info" | "error"; text: string };

type LayoutState = {
  widgets: WidgetMeta[];
  byId: (id: string) => WidgetMeta | undefined;
  /** The widgets on the page, in order (the draft while editing). */
  order: string[];
  hiddenWidgets: WidgetMeta[];
  editing: boolean;
  dirty: boolean;
  confirmingExit: boolean;
  leaving: string | null;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  menu: MenuState | null;
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  notice: Notice | null;
  hide: (id: string) => void;
  show: (id: string) => void;
  showAll: () => void;
  startEdit: () => void;
  setDraft: (order: string[]) => void;
  move: (id: string, to: number) => void;
  save: () => void;
  cancel: () => void;
  requestExit: () => void;
  keepEditing: () => void;
  resetDraft: () => void;
};

const LayoutContext = createContext<LayoutState | null>(null);

export function useDashboardLayout(): LayoutState {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useDashboardLayout must be used inside <DashboardLayoutProvider>");
  return value;
}
/** For parts that can also be shown without the provider (a page in a test, any page that is not the home page). */
export const useDashboardLayoutOptional = () => useContext(LayoutContext);

/** Motion is for people who have not asked for less of it. Without matchMedia (a test) nothing waits for an animation. */
export function motionAllowed(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const LEAVE_MS = 220;

export function DashboardLayoutProvider({
  widgets, saved, storageKey, endpoint, children,
}: {
  /** The widgets this person may use right now, in the default order. */
  widgets: WidgetMeta[];
  /** The saved document from the Auth Service (null when never customised). */
  saved: unknown;
  /** Who and which portal this is: the in-tab memory is kept per person per portal. */
  storageKey: string;
  endpoint: string;
  children: ReactNode;
}) {
  const fromServer = useMemo(() => resolveLayout(widgets, saved), [widgets, saved]);
  const [committed, setCommitted] = useState<Layout>(() => settleLayout(storageKey, fromServer));
  const [draft, setDraftState] = useState<string[] | null>(null);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [panelOpen, setPanelOpenState] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const committedRef = useRef(committed);
  committedRef.current = committed;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sequence = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A newer copy from the server (another device saved, or a module was switched on or off) replaces what this page holds, unless the person is in the
  // middle of editing; an older cached one never does.
  useEffect(() => {
    if (draftRef.current) return;
    const next = settleLayout(storageKey, fromServer);
    const current = committedRef.current;
    const members = (layout: Layout) => [...layout.order, ...layout.hidden].sort();
    // newer by revision, or the same revision but a different set of widgets (a module was switched on or off)
    if (next.revision > current.revision || (next.revision === current.revision && !sameList(members(next), members(current)))) {
      committedRef.current = next;
      setCommitted(next);
    }
  }, [fromServer, storageKey]);

  const say = useCallback((next: Notice | null) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next) noticeTimer.current = setTimeout(() => setNotice(null), next.tone === "error" ? 7000 : 4500);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const byId = useCallback((id: string) => widgets.find((w) => w.id === id), [widgets]);

  /** The page changes now; the record follows. A failure puts back what was saved before (unless the person has already done something newer). */
  const commit = useCallback((next: Layout, message?: string) => {
    const previous = committedRef.current;
    const mine = ++sequence.current;
    committedRef.current = next;
    setCommitted(next);
    rememberLayout(storageKey, next);
    queue.current = queue.current.then(async () => {
      const result = await saveLayout(endpoint, next.order, next.hidden);
      if (result.ok) {
        const settled = { ...committedRef.current, revision: Math.max(result.layout.revision, committedRef.current.revision) };
        committedRef.current = settled;
        setCommitted(settled);
        rememberLayout(storageKey, settled);
        if (message && mine === sequence.current) say({ tone: "info", text: message });
      } else {
        if (mine === sequence.current) {
          committedRef.current = previous;
          setCommitted(previous);
          rememberLayout(storageKey, previous);
        }
        say({ tone: "error", text: result.error });
      }
    });
  }, [endpoint, say, storageKey]);

  const hide = useCallback((id: string) => {
    const finish = () => {
      setLeaving(null);
      const name = widgets.find((w) => w.id === id)?.name ?? "The widget";
      commit(hideOne(committedRef.current, id), `${name} was removed from Home. Add it back any time from Add Widgets.`);
    };
    if (!committedRef.current.order.includes(id)) return;
    if (!motionAllowed()) { finish(); return; }
    setLeaving(id);
    setTimeout(finish, LEAVE_MS);
  }, [commit, widgets]);

  const show = useCallback((id: string) => {
    const name = widgets.find((w) => w.id === id)?.name ?? "The widget";
    commit(showOne(committedRef.current, id), `${name} was added back to your dashboard.`);
  }, [commit, widgets]);

  const showAll = useCallback(() => {
    if (committedRef.current.hidden.length === 0) return;
    commit(showEvery(widgets, committedRef.current), "All widgets are back on your dashboard.");
  }, [commit, widgets]);

  const startEdit = useCallback(() => {
    setMenu(null);
    setPanelOpenState(false);
    setConfirmingExit(false);
    setDraftState([...committedRef.current.order]);
  }, []);

  const finishEditing = useCallback(() => { setDraftState(null); setConfirmingExit(false); }, []);

  const save = useCallback(() => {
    const order = draftRef.current;
    if (!order) return;
    finishEditing();
    if (!sameList(order, committedRef.current.order)) commit({ ...committedRef.current, order }, "Your layout was saved.");
  }, [commit, finishEditing]);

  const cancel = useCallback(() => finishEditing(), [finishEditing]);

  const dirty = draft !== null && !sameList(draft, committed.order);

  const requestExit = useCallback(() => {
    const order = draftRef.current;
    if (!order) return;
    if (sameList(order, committedRef.current.order)) finishEditing();
    else setConfirmingExit(true);
  }, [finishEditing]);

  const keepEditing = useCallback(() => setConfirmingExit(false), []);
  const setDraft = useCallback((order: string[]) => setDraftState(order), []);
  const move = useCallback((id: string, to: number) => setDraftState((current) => (current ? moveInList(current, id, to) : current)), []);
  const resetDraft = useCallback(() => setDraftState(defaultOrderOf(widgets, committedRef.current.hidden)), [widgets]);

  const setPanelOpen = useCallback((open: boolean) => { setPanelOpenState(open); if (open) setMenu(null); }, []);
  const openMenu = useCallback((next: MenuState) => { setPanelOpenState(false); setMenu(next); }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Escape leaves the editor (asking first when there is something to lose); a second Escape on the question goes back to editing.
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmingExit) setConfirmingExit(false);
      else requestExit();
    };
    const onLeave = (event: BeforeUnloadEvent) => { if (!sameList(draftRef.current ?? [], committedRef.current.order)) { event.preventDefault(); event.returnValue = ""; } };
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onLeave); };
  }, [editing, confirmingExit, requestExit]);

  const hiddenWidgets = useMemo(() => committed.hidden.map((id) => widgets.find((w) => w.id === id)).filter((w): w is WidgetMeta => Boolean(w)), [committed.hidden, widgets]);

  const value: LayoutState = {
    widgets, byId, order: draft ?? committed.order, hiddenWidgets, editing, dirty, confirmingExit, leaving, panelOpen, setPanelOpen, menu, openMenu, closeMenu,
    notice, hide, show, showAll, startEdit, setDraft, move, save, cancel, requestExit, keepEditing, resetDraft,
  };
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}
