"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { DEFAULT_THEME, encodeThemeCookie, isAccentId, isBackgroundId, sameTheme, themeAttributes, type ThemeChoice } from "@/lib/theme";

// The state of the theme customizer, shared by every place that shows it (the header popover, Settings, a profile card entry): ONE saved theme and ONE
// draft, so a choice made in one place is what the others show. A choice is previewed on the whole page at once (data attributes on <html>, see
// lib/theme.ts); only Apply saves it (to the person's own record in the Auth Service, through this portal's /api/theme). Cancel, Escape and a click
// elsewhere put the saved theme back. This file is an identical copy in both portals.
//
// A saved theme reaches EVERY page without a refresh:
//  - the saved theme is remembered in the browser tab (`memory`, below), so each page's own provider starts from what was last applied here rather than
//    from the (possibly cached, older) copy the server sent with that page;
//  - after Apply the client router cache is invalidated, so the next page comes from the server with the new choice;
//  - every other open tab of this portal is told through a BroadcastChannel, and re-reads the shared cookie when it becomes visible again.
// The change itself is one attribute swap on <html>, wrapped in a View Transition where the browser has one so the whole page cross-fades instead of snapping.

type ThemeState = {
  /** What is saved for this person. */
  saved: ThemeChoice;
  /** What is being previewed right now (equal to `saved` unless the person is choosing). */
  draft: ThemeChoice;
  dirty: boolean;
  open: boolean;
  busy: boolean;
  error: string | null;
  setOpen: (open: boolean) => void;
  preview: (change: Partial<ThemeChoice>) => void;
  apply: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
/** For components that can also be shown without a provider (a standalone card in a test, a login page). */
export const useThemeOptional = () => useContext(ThemeContext);

// ---- what this browser tab knows about the saved theme. It outlives a page (every page mounts its own provider), so a page rendered from the router's
// cache, which carries an OLDER copy of the user's theme, can never repaint an old colour scheme over a newer one.
type Memory = { current: ThemeChoice; history: Set<string> };
const memory = new Map<string, Memory>();
const code = encodeThemeCookie;

/** Tests (and nothing else) start each case from a blank memory. */
export function forgetSavedTheme() { memory.clear(); }

/** What this tab should treat as the saved theme, given the copy the server sent with the page: the server's copy is taken when it is new information
 *  (the first page of the tab, or a change made elsewhere), and ignored when it is one this tab has already moved past (a stale cached page). */
function settle(key: string, fromServer: ThemeChoice): ThemeChoice {
  if (typeof window === "undefined") return fromServer; // server render: nothing is remembered between requests
  const known = memory.get(key);
  if (!known) { memory.set(key, { current: fromServer, history: new Set([code(fromServer)]) }); return fromServer; }
  if (known.history.has(code(fromServer))) return known.current;
  known.current = fromServer;
  known.history.add(code(fromServer));
  return fromServer;
}

function remember(key: string, theme: ThemeChoice) {
  const known = memory.get(key);
  if (known) { known.current = theme; known.history.add(code(theme)); } else memory.set(key, { current: theme, history: new Set([code(theme)]) });
}

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/** The colours change by swapping three attributes on <html>; the browser cross-fades old and new when it can, and just swaps when it can not (or the
 *  person asked for reduced motion). `animate` is false for the very first paint of a page, which must not fade. */
function paint(theme: ThemeChoice, animate = true) {
  const swap = () => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(themeAttributes(theme))) root.setAttribute(name, value);
  };
  const doc = document as TransitionDocument;
  const motion = typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (animate && motion && typeof doc.startViewTransition === "function") doc.startViewTransition(swap);
  else swap();
}

function setCookie(cookieName: string, theme: ThemeChoice) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${cookieName}=${encodeThemeCookie(theme)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

function readCookie(cookieName: string): ThemeChoice | null {
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(`${cookieName}=`));
  const parts = (match ? match.slice(cookieName.length + 1) : "").split(".");
  return parts.length === 2 && isBackgroundId(parts[0]) && isAccentId(parts[1]) ? { background: parts[0], accent: parts[1] } : null;
}

export function ThemeProvider({ saved: fromServer, cookieName, userId = "", children }: { saved: ThemeChoice; cookieName: string; userId?: string; children: ReactNode }) {
  const router = useRouter();
  const key = `${cookieName}:${userId}`;
  const [initial] = useState(() => settle(key, fromServer));
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  savedRef.current = saved;
  draftRef.current = draft;
  const first = useRef(true);

  /** Another page, another tab or the server says the saved theme is now `next`. A preview in progress here is left alone. */
  const adopt = useCallback((next: ThemeChoice, animate: boolean) => {
    const wasPreviewing = !sameTheme(draftRef.current, savedRef.current);
    setSaved(next);
    savedRef.current = next;
    if (!wasPreviewing) {
      setDraft(next);
      draftRef.current = next;
      paint(next, animate);
    }
  }, []);

  // The server painted the colours from the cookie; this makes the record the authority on a page's first paint (a stale cookie is corrected once) and
  // keeps the cookie in line. After that, a newer copy from the server (router.refresh after Apply, or a change made on another device) is adopted,
  // an older cached one is not.
  useEffect(() => {
    const next = settle(key, fromServer);
    if (first.current) {
      first.current = false;
      paint(next, false);
      setCookie(cookieName, next);
      setSaved(next);
      setDraft(next);
      return;
    }
    if (!sameTheme(next, savedRef.current)) { adopt(next, true); setCookie(cookieName, next); }
  }, [fromServer.background, fromServer.accent, key, cookieName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Other tabs of this portal: told at once through the channel, and (for a tab that was asleep or a browser without channels) through the shared cookie
  // as soon as the tab is looked at again.
  useEffect(() => {
    const take = (next: ThemeChoice) => { if (!sameTheme(next, savedRef.current)) { remember(key, next); adopt(next, true); } };
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(`impex-theme:${key}`);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as Partial<ThemeChoice> | null;
        if (data && isBackgroundId(data.background) && isAccentId(data.accent)) take({ background: data.background, accent: data.accent });
      };
    }
    const look = () => {
      if (document.visibilityState === "hidden") return;
      const fromCookie = readCookie(cookieName);
      if (fromCookie) take(fromCookie);
    };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
      channel?.close();
    };
  }, [key, cookieName, adopt]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const preview = useCallback((change: Partial<ThemeChoice>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    setError(null);
    paint(next);
  }, [draft]);

  const cancel = useCallback(() => {
    setDraft(saved);
    setError(null);
    setOpen(false);
    paint(saved);
  }, [saved]);

  const reset = useCallback(() => {
    setDraft(DEFAULT_THEME);
    setError(null);
    paint(DEFAULT_THEME); // only previewed: it is saved when Apply Theme is pressed
  }, []);

  const apply = useCallback(async () => {
    if (busy) return;
    if (sameTheme(draft, saved)) { setOpen(false); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/theme", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), cache: "no-store" });
      if (res.status === 401) { window.location.assign("/login"); return; }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(typeof data?.error === "string" ? data.error : "The theme could not be saved. Please try again.");
        return;
      }
      remember(key, draft);
      setSaved(draft);
      setCookie(cookieName, draft);
      try {
        const channel = new BroadcastChannel(`impex-theme:${key}`);
        channel.postMessage(draft);
        channel.close();
      } catch { /* no channel: other tabs pick the cookie up when they are looked at */ }
      startTransition(() => router.refresh()); // drops the client router cache, so no page is shown from a copy that still carries the old choice
      setOpen(false);
      setMessage("Theme saved.");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), 3500);
    } catch {
      setError("The theme could not be saved. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, draft, saved, cookieName, key, router]);

  const value = useMemo<ThemeState>(
    () => ({ saved, draft, dirty: !sameTheme(draft, saved), open, busy, error, setOpen, preview, apply, cancel, reset }),
    [saved, draft, open, busy, error, preview, apply, cancel, reset],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
      {message && (
        <div role="status" className="ix-menu pointer-events-none fixed bottom-5 right-5 z-[80] flex items-center gap-2 px-4 py-2.5 text-sm font-medium print:hidden">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-ix-accent-text" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          {message}
        </div>
      )}
    </ThemeContext.Provider>
  );
}
