"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DISPATCH_STATUS_LABELS, DISPATCH_STATUS_STYLE, STATUS_LABELS } from "@/lib/sales-browser";
import type { Client, DeliveryListSummary, DispatchFilters, DispatchStatus, DispatchSummary, Paged } from "@/lib/sales";

const selectClass = "mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function DispatchIndex({ list, filters, clients, dispatchable }: { list: Paged<DispatchSummary>; filters: DispatchFilters; clients: Client[]; dispatchable: DeliveryListSummary[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState("");

  function navigate(next: Partial<DispatchFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.clientId) params.set("client", merged.clientId);
    if (merged.listId) params.set("list", merged.listId);
    if (merged.dateFrom) params.set("from", merged.dateFrom);
    if (merged.dateTo) params.set("to", merged.dateTo);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/dispatches?${query}` : "/dispatches"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.clientId || filters.listId || filters.dateFrom || filters.dateTo);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Dispatches</h2>
          <p className="text-xs text-slate-400">Goods leaving for your clients. A dispatch deducts stock only when you confirm it.</p>
        </div>
        <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">
          {creating ? "Close" : "New Dispatch"}
        </button>
      </div>

      {creating && (
        <section aria-label="New dispatch" className="space-y-3 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
          <p className="text-sm text-slate-300">A dispatch is prepared from a <strong>Ready</strong> (or Partially Dispatched) delivery list.</p>
          {dispatchable.length === 0 ? (
            <p role="status" className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
              No delivery list is ready for dispatch. Mark a list Ready in <Link href="/delivery-lists" className="text-indigo-300 hover:text-indigo-200">Delivery Lists</Link> first.
            </p>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex-1 text-xs font-medium text-slate-400">
                Delivery list
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500">
                  <option value="">Choose a delivery list…</option>
                  {dispatchable.map((l) => <option key={l.id} value={l.id}>{l.number} · {l.client.name} · {STATUS_LABELS[l.status]}</option>)}
                </select>
              </label>
              <button type="button" disabled={!chosen} onClick={() => router.push(`/delivery-lists/${chosen}/dispatch`)} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Prepare dispatch</button>
            </div>
          )}
        </section>
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Dispatch, list, tracking number or client" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as DispatchFilters["status"] })} className={selectClass}>
              <option value="">All statuses</option>
              {(Object.keys(DISPATCH_STATUS_LABELS) as DispatchStatus[]).map((s) => <option key={s} value={s}>{DISPATCH_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Client
            <select value={filters.clientId} onChange={(e) => navigate({ clientId: e.target.value })} className={selectClass}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (inactive)"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            From
            <input type="date" value={filters.dateFrom} onChange={(e) => navigate({ dateFrom: e.target.value })} className={selectClass} />
          </label>
          <label className="text-xs font-medium text-slate-400">
            To
            <input type="date" value={filters.dateTo} onChange={(e) => navigate({ dateTo: e.target.value })} className={selectClass} />
          </label>
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "", clientId: "", listId: "", dateFrom: "", dateTo: "" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so dispatches cannot be used. Please contact your platform administrator." : "Dispatches are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No dispatches match these filters." : "No dispatches yet. Open a Ready delivery list and choose Prepare dispatch."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Dispatch</th><th className="px-4 py-3 font-semibold">Delivery list</th><th className="px-4 py-3 font-semibold">Client</th>
                    <th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold text-right">Lines</th><th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <Link href={`/dispatches/${d.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{d.number}</Link>
                        {d.tracking_reference && <div className="text-xs text-slate-500">{d.tracking_reference}</div>}
                      </td>
                      <td className="px-4 py-3"><Link href={`/delivery-lists/${d.delivery_list.id}`} className="font-mono text-xs text-slate-300 hover:text-white">{d.delivery_list.number}</Link></td>
                      <td className="px-4 py-3">{d.client.name}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{d.dispatch_date}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{d.line_count}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${DISPATCH_STATUS_STYLE[d.status]}`}>{DISPATCH_STATUS_LABELS[d.status]}</span></td>
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
