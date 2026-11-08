"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { TicketFilters, TicketPage } from "@/lib/support";
import { CATEGORIES, CATEGORY_LABELS, PRIORITY_LABELS, PRIORITY_STYLE, STATUSES, STATUS_LABELS, STATUS_STYLE, stamp } from "@/lib/support-labels";

const selectClass = "mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function SupportIndex({ list, filters }: { list: TicketPage; filters: TicketFilters }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<TicketFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.category) params.set("category", merged.category);
    if (merged.unread) params.set("unread", "true");
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/support?${query}` : "/support"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.category || filters.unread);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Help &amp; Support</h2>
          <p className="text-xs text-slate-400">Ask a question, report a problem or request a change. The Impex team answers here, and you get an email when they do.</p>
        </div>
        <Link href="/support/new" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">New request</Link>
      </div>

      {list.ok && list.unread > 0 && (
        <p role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
          Impex Support replied to {list.unread} {list.unread === 1 ? "request" : "requests"}.{" "}
          <button type="button" onClick={() => navigate({ unread: true })} className="font-medium underline hover:text-white">Show {list.unread === 1 ? "it" : "them"}</button>
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticket number or subject" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as TicketFilters["status"] })} className={selectClass}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}{list.ok ? ` (${list.counts[s] ?? 0})` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Category
            <select value={filters.category} onChange={(e) => navigate({ category: e.target.value as TicketFilters["category"] })} className={selectClass}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="flex min-h-10 items-center gap-2 text-xs font-medium text-slate-300">
            <input type="checkbox" checked={filters.unread} onChange={(e) => navigate({ unread: e.target.checked })} className="h-4 w-4 rounded border-slate-700 bg-slate-950" />
            New replies only
          </label>
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "", category: "", unread: false }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so Help & Support cannot be used. Please contact your platform administrator."
                : "Help & Support is temporarily unavailable. Nothing was lost; please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No requests match these filters." : (
                <>
                  <p>You have not sent any request yet.</p>
                  <p className="mt-1">Something not working, or want something changed? <Link href="/support/new" className="text-indigo-300 hover:text-indigo-200">Send a request</Link>.</p>
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/60" aria-label="Your requests">
              {list.items.map((t) => (
                <li key={t.id}>
                  <Link href={`/support/${t.id}`} className="flex flex-wrap items-start justify-between gap-3 px-2 py-3.5 hover:bg-slate-800/30">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-indigo-300">{t.ticket_number}</span>
                        {t.unread && <span className="rounded-full bg-ix-butter px-2 py-0.5 text-[11px] font-semibold text-ix-deep">New reply</span>}
                      </div>
                      <p className={`mt-0.5 truncate text-sm ${t.unread ? "font-semibold text-white" : "text-slate-200"}`}>{t.subject}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {CATEGORY_LABELS[t.category]} · opened {stamp(t.created_at)} · last activity {stamp(t.last_reply_at)} · {t.message_count} {t.message_count === 1 ? "message" : "messages"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[t.priority]}`}>{PRIORITY_LABELS[t.priority]}</span>
                      <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[t.status]}`}>{STATUS_LABELS[t.status]}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {list.ok && total > 0 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Showing {first}–{last} of {total}</span>
            <div className="flex gap-2">
              <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
              <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
