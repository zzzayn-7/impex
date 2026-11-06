import type { InboxFilters } from "@/lib/support";
import { CATEGORIES, PRIORITIES, STATUSES } from "@/lib/support-labels";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const pick = <T extends string>(value: string, allowed: readonly T[]): T | "" => ((allowed as readonly string[]).includes(value) ? (value as T) : "");

/** Only known filter names and values reach the Support Service; anything else in the address is ignored. */
export function parseFilters(searchParams: SearchParams): InboxFilters {
  const page = Number.parseInt(one(searchParams.page), 10);
  return {
    q: one(searchParams.q).trim().slice(0, 100),
    status: pick(one(searchParams.status), STATUSES),
    category: pick(one(searchParams.category), CATEGORIES),
    priority: pick(one(searchParams.priority), PRIORITIES),
    unread: one(searchParams.unread) === "true",
    page: Number.isFinite(page) && page >= 1 && page <= 10000 ? page : 1,
  };
}
