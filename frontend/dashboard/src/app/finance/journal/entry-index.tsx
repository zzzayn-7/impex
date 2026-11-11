"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ENTRY_STATUS_LABELS, ENTRY_STATUS_STYLE, money, SOURCE_LABELS } from "@/lib/finance-browser";
import type { Account, EntryFilters, EntrySource, EntryStatus, EntrySummary, Paged } from "@/lib/finance";
import { fieldClass, Pill, primaryButton, selectClass, Unavailable } from "../ui";

export default function EntryIndex({ list, filters, accounts }: { list: Paged<EntrySummary>; filters: EntryFilters; accounts: Account[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<EntryFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.source) params.set("source", merged.source);
    if (merged.currency) params.set("currency", merged.currency);
    if (merged.accountId) params.set("account", merged.accountId);
    if (merged.dateFrom) params.set("from", merged.dateFrom);
    if (merged.dateTo) params.set("to", merged.dateTo);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/finance/journal?${query}` : "/finance/journal"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.source || filters.currency || filters.accountId || filters.dateFrom || filters.dateTo);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Journal Entries</h2>
          <p className="text-xs text-slate-400">Every entry balances: debits equal credits, in one currency. Posted entries are permanent; corrections are made by reversing them.</p>
        </div>
        <Link href="/finance/journal/new" className={primaryButton}>New Journal Entry</Link>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, description or reference" maxLength={100} className={fieldClass} />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as EntryStatus | "" })} className={selectClass}>
              <option value="">All statuses</option>
              {(Object.keys(ENTRY_STATUS_LABELS) as EntryStatus[]).map((s) => <option key={s} value={s}>{ENTRY_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">Source
            <select value={filters.source} onChange={(e) => navigate({ source: e.target.value as EntrySource | "" })} className={selectClass}>
              <option value="">All sources</option>
              {(Object.keys(SOURCE_LABELS) as EntrySource[]).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">Account
            <select value={filters.accountId} onChange={(e) => navigate({ accountId: e.target.value })} className={selectClass}>
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">Currency
            <input value={filters.currency} onChange={(e) => e.target.value.length === 0 || e.target.value.length === 3 ? navigate({ currency: e.target.value.toUpperCase() }) : undefined} maxLength={3} placeholder="Any" className={`${selectClass} w-24 uppercase`} />
          </label>
          <label className="text-xs font-medium text-slate-400">From
            <input type="date" value={filters.dateFrom} onChange={(e) => navigate({ dateFrom: e.target.value })} className={selectClass} />
          </label>
          <label className="text-xs font-medium text-slate-400">To
            <input type="date" value={filters.dateTo} onChange={(e) => navigate({ dateTo: e.target.value })} className={selectClass} />
          </label>
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <Unavailable reason={list.reason} what="the journal" />
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No journal entries match these filters." : "No journal entries yet. Choose New Journal Entry, or issue an invoice in Sales: it is posted here automatically."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Entry</th><th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold">Description</th>
                    <th className="px-4 py-3 font-semibold">Source</th><th className="px-4 py-3 text-right font-semibold">Total</th><th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3"><Link href={`/finance/journal/${e.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{e.entry_number ?? "Draft"}</Link></td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{e.entry_date}</td>
                      <td className="px-4 py-3">
                        <div>{e.description}</div>
                        {e.source_summary && <div className="text-xs text-slate-500">{e.source_summary}</div>}
                        {e.reversed_by_entry_id && <div className="text-xs text-amber-300">Reversed</div>}
                      </td>
                      <td className="px-4 py-3 text-xs">{SOURCE_LABELS[e.source_type]}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{e.total ? <>{money(e.total)} <span className="text-slate-500">{e.currency_code}</span></> : <span className="text-slate-500">—</span>}</td>
                      <td className="px-4 py-3"><Pill style={ENTRY_STATUS_STYLE[e.status]}>{ENTRY_STATUS_LABELS[e.status]}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
