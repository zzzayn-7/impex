// The home page's widget arrangement: ONE definition of the types and the rules, shared by both portals (an identical copy lives in each: they share no
// package, by design). The Organization Portal and the Super Admin Portal each have their OWN widget registry (src/lib/dashboard-widgets.ts); everything
// else (how a layout is read, changed, validated and merged) is here.
//
// What is stored for a person is only widget IDENTIFIERS: the visible widgets in order and the hidden ones (plus a schema version and a revision the Auth
// Service counts). Never HTML, CSS or a component: what a widget looks like is the portal's code. A widget the person may not use (its module is off) is
// never listed or shown, but what the person chose for it is kept in the saved document so it comes back as it was when access returns.

export type WidgetSize = "small" | "medium" | "half" | "full";
export type WidgetIcon =
  | "home" | "box" | "cart" | "receipt" | "wallet" | "trend" | "pie" | "activity" | "list" | "ledger" | "grid" | "bolt" | "building"
  | "users" | "gauge" | "server" | "terminal" | "book" | "clock" | "check";

/** What a widget IS (data only). Its content is rendered by the page from this id. `size` is how much of the grid it takes; it is never saved. */
export type WidgetMeta = { id: string; name: string; description: string; size: WidgetSize; icon: WidgetIcon };

/** The Auth Service's document, as the portals receive it. */
export type StoredLayout = { version: number; revision: number; order: string[]; hidden: string[] };
/** A layout resolved against the widgets a person may use right now. `order` = the visible widgets, in order. */
export type Layout = { order: string[]; hidden: string[]; revision: number };

export const LAYOUT_VERSION = 1;
export const MAX_LAYOUT_WIDGETS = 64;

const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The saved document if it has the expected shape, otherwise null (a missing, older or damaged document reads as "never customised"). */
export function parseStored(value: unknown): StoredLayout | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isIdList(v.order) || !isIdList(v.hidden)) return null;
  return { version: typeof v.version === "number" ? v.version : LAYOUT_VERSION, revision: typeof v.revision === "number" && v.revision >= 0 ? v.revision : 0, order: v.order, hidden: v.hidden };
}

/**
 * What the home page should show, given the widgets this person may use (in their default order) and what they saved.
 *  - nothing saved: every widget, in the default order;
 *  - an identifier that is not (or no longer) available is ignored, repeats are ignored, and a hidden widget stays hidden;
 *  - a widget the saved document has never heard of (a new one, or one whose module just came back) is added at the END, visible.
 */
export function resolveLayout(widgets: readonly WidgetMeta[], saved: unknown): Layout {
  const available = new Set(widgets.map((w) => w.id));
  const stored = parseStored(saved);
  const hidden: string[] = [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of stored?.hidden ?? []) if (available.has(id) && !seen.has(id)) { seen.add(id); hidden.push(id); }
  for (const id of stored?.order ?? []) if (available.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  for (const w of widgets) if (!seen.has(w.id)) { seen.add(w.id); order.push(w.id); }
  return { order, hidden, revision: stored?.revision ?? 0 };
}

export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** `order` with `id` moved to `to` (clamped). */
export function moveTo(order: readonly string[], id: string, to: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const next = order.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
}

/** Removing a widget from the page: it leaves the order and joins the hidden ones. Nothing else changes. */
export function hideOne(layout: Layout, id: string): Layout {
  if (!layout.order.includes(id)) return layout;
  return { ...layout, order: layout.order.filter((x) => x !== id), hidden: [...layout.hidden, id] };
}

/** Adding a hidden widget back: it goes to the END of the page (once, never twice). */
export function showOne(layout: Layout, id: string): Layout {
  if (!layout.hidden.includes(id)) return layout;
  return { ...layout, order: [...layout.order.filter((x) => x !== id), id], hidden: layout.hidden.filter((x) => x !== id) };
}

/** Restore All: every hidden widget goes to the end, in the default order. */
export function showEvery(widgets: readonly WidgetMeta[], layout: Layout): Layout {
  const back = widgets.map((w) => w.id).filter((id) => layout.hidden.includes(id));
  return { ...layout, order: [...layout.order, ...back], hidden: [] };
}

/** Reset Layout: the visible widgets in their default order. Hidden ones stay hidden. */
export function defaultOrderOf(widgets: readonly WidgetMeta[], hidden: readonly string[]): string[] {
  return widgets.map((w) => w.id).filter((id) => !hidden.includes(id));
}

export type Submission = { ok: true; order: string[]; hidden: string[] } | { ok: false };

/** What a browser may send: two lists of known, distinct, available identifiers, none both shown and hidden. Anything else is refused outright. */
export function readSubmission(body: unknown, available: readonly string[]): Submission {
  if (!body || typeof body !== "object") return { ok: false };
  const { order, hidden, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isIdList(order) || !isIdList(hidden)) return { ok: false };
  if (order.length + hidden.length > MAX_LAYOUT_WIDGETS) return { ok: false };
  const all = [...order, ...hidden];
  if (new Set(all).size !== all.length || !all.every((id) => available.includes(id))) return { ok: false };
  return { ok: true, order, hidden };
}

/**
 * What goes to the Auth Service when the person saves: their choices for the widgets they may use now, plus (at the end) whatever the saved document
 * holds for widgets they may NOT use right now, so switching a module off and on again never loses what they chose for it.
 */
export function withRetained(submission: { order: string[]; hidden: string[] }, stored: unknown, available: readonly string[]): { order: string[]; hidden: string[] } {
  const previous = parseStored(stored);
  const keep = (ids: string[] | undefined) => (ids ?? []).filter((id) => !available.includes(id));
  return { order: [...submission.order, ...keep(previous?.order)], hidden: [...submission.hidden, ...keep(previous?.hidden)] };
}
