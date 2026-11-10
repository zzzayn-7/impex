import { parseStored, type Layout } from "@/lib/dashboard-layout";

// DashboardLayoutStorage: how the browser keeps the home-page arrangement in step with the person's saved record (the Auth Service is the record).
//
//  * save() sends the two lists of widget identifiers to this portal's /api/dashboard-layout, which validates them again against what the person may use
//    and forwards them to the Auth Service for the signed-in person alone. The answer is the layout that was actually saved.
//  * The saved layout is also remembered in this browser tab (`memory`). Every navigation mounts a fresh provider, and the router may serve the home page
//    from its cache with an OLDER copy of the layout; the revision the Auth Service counts decides which copy is newer, so a cached page can never put
//    back a card the person just removed.
// This file is an identical copy in both portals.

const memory = new Map<string, Layout>();

/** Tests (and nothing else) start each case from a blank memory. */
export function forgetSavedLayouts() { memory.clear(); }

/** The layout this tab should start from: the server's copy, unless this tab has already saved a newer one. */
export function settleLayout(key: string, fromServer: Layout): Layout {
  if (typeof window === "undefined") return fromServer; // a server render remembers nothing between requests
  const known = memory.get(key);
  if (known && known.revision > fromServer.revision) return known;
  memory.set(key, fromServer);
  return fromServer;
}

export function rememberLayout(key: string, layout: Layout) { if (typeof window !== "undefined") memory.set(key, layout); }

export type SaveResult = { ok: true; layout: Layout } | { ok: false; error: string };

export async function saveLayout(endpoint: string, order: readonly string[], hidden: readonly string[]): Promise<SaveResult> {
  try {
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, hidden }),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; layout?: unknown };
    if (!response.ok) return { ok: false, error: typeof body.error === "string" ? body.error : "Your layout could not be saved. Please try again." };
    const stored = parseStored(body.layout);
    if (!stored) return { ok: false, error: "Your layout could not be saved. Please try again." };
    return { ok: true, layout: { order: [...order], hidden: [...hidden], revision: stored.revision } };
  } catch {
    return { ok: false, error: "Your layout could not be saved just now. Please check your connection and try again." };
  }
}
