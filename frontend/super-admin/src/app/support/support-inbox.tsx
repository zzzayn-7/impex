"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Tooltip } from "@/components/ui/tooltip";
import type { InboxFilters, InboxPage } from "@/lib/support";
import { CATEGORIES, CATEGORY_LABELS, PRIORITIES, PRIORITY_LABELS, PRIORITY_STYLE, STATUSES, STATUS_LABELS, STATUS_STYLE, stamp } from "@/lib/support-labels";

const selectClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500 sm:max-w-[13rem]";

/** The Support Inbox: every organization's requests, newest activity first. Filters live in the address (shareable, back button works). */
export default function SupportInbox({ list, filters }: { list: InboxPage; filters: InboxFilters }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<InboxFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.category) params.set("category", merged.category);
    if (merged.priority) params.set("priority", merged.priority);
    if (merged.unread) params.set("unread", "true");
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/support?${query}` : "/support"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.category || filters.priority || filters.unread);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Support Inbox</h2>
        <p className="text-xs text-slate-400">Requests from every organization. Replies are sent from here, and the requester is emailed.</p>
      </div>

      {list.ok && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" role="group" aria-label="Tickets by status">
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => navigate({ status: filters.status === s ? "" : s })} aria-pressed={filters.status === s}
              className={`rounded-xl border px-4 py-3 text-left transition ${filters.status === s ? "border-indigo-500/60 bg-indigo-500/10" : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/40"}`}>
              <span className="block text-xs text-slate-400">{STATUS_LABELS[s]}</span>
              <span className="mt-1 block text-xl font-semibold text-white">{list.counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticket number, subject, organization or requester" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="w-full text-xs font-medium text-slate-400 sm:w-auto">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as InboxFilters["status"] })} className={selectClass}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="w-full text-xs font-medium text-slate-400 sm:w-auto">
            Category
            <select value={filters.category} onChange={(e) => navigate({ category: e.target.value as InboxFilters["category"] })} className={selectClass}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="w-full text-xs font-medium text-slate-400 sm:w-auto">
            Priority
            <select value={filters.priority} onChange={(e) => navigate({ priority: e.target.value as InboxFilters["priority"] })} className={selectClass}>
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
            </select>
          </label>
          <label className="flex min-h-10 items-center gap-2 text-xs font-medium text-slate-300">
            <input type="checkbox" checked={filters.unread} onChange={(e) => navigate({ unread: e.target.checked })} className="h-4 w-4 rounded border-slate-700 bg-slate-950" />
            Unread only
          </label>
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "", category: "", priority: "", unread: false }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden"
                ? "Only a Super Admin can use the Support Inbox."
                : "The Support Inbox is temporarily unavailable. Nothing was lost; please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No tickets match these filters." : "No support requests yet. When an organization writes to Help & Support, it appears here."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-2 py-2 font-medium">Ticket</th>
                    <th scope="col" className="px-2 py-2 font-medium">Organization</th>
                    <th scope="col" className="px-2 py-2 font-medium">Requester</th>
                    <th scope="col" className="px-2 py-2 font-medium">Subject</th>
                    <th scope="col" className="px-2 py-2 font-medium">Category</th>
                    <th scope="col" className="px-2 py-2 font-medium">Priority</th>
                    <th scope="col" className="px-2 py-2 font-medium">Status</th>
                    <th scope="col" className="px-2 py-2 font-medium">Submitted</th>
                    <th scope="col" className="px-2 py-2 font-medium">Latest activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((t) => (
                    <tr key={t.id} className={`hover:bg-slate-800/30 ${t.unread ? "bg-ix-butter/5" : ""}`}>
                      <td className="px-2 py-3 align-top">
                        <Link href={`/support/${t.id}`} className="inline-flex items-center gap-2 font-mono font-semibold text-indigo-300 hover:text-indigo-200">
                          {t.unread && <Tooltip label="Unread"><span role="img" aria-label="Unread" className="inline-block h-2 w-2 rounded-full bg-ix-butter" /></Tooltip>}
                          {t.ticket_number}
                        </Link>
                      </td>
                      <td className="px-2 py-3 align-top text-slate-200">{t.organization_name}</td>
                      <td className="px-2 py-3 align-top text-slate-300">{t.requester_name}</td>
                      <td className="max-w-[16rem] px-2 py-3 align-top">
                        <Link href={`/support/${t.id}`} className={`block truncate hover:text-white ${t.unread ? "font-semibold text-white" : "text-slate-200"}`}>{t.subject}</Link>
                        {t.awaiting_staff && <span className="mt-0.5 block text-[11px] text-ix-accent-text">Awaiting your reply</span>}
                      </td>
                      <td className="px-2 py-3 align-top text-slate-300">{CATEGORY_LABELS[t.category]}</td>
                      <td className="px-2 py-3 align-top"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[t.priority]}`}>{PRIORITY_LABELS[t.priority]}</span></td>
                      <td className="px-2 py-3 align-top"><span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[t.status]}`}>{STATUS_LABELS[t.status]}</span></td>
                      <td className="whitespace-nowrap px-2 py-3 align-top text-xs text-slate-400">{stamp(t.created_at)}</td>
                      <td className="whitespace-nowrap px-2 py-3 align-top text-xs text-slate-400">{stamp(t.last_reply_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {list.ok && total > 0 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Showing {first}–{last} of {total}{list.unread > 0 ? ` · ${list.unread} unread` : ""}</span>
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
