"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { RECEIPT_STATUS_LABELS, RECEIPT_STATUS_STYLE } from "@/lib/purchasing-browser";
import type { Paged, ReceiptFilters, ReceiptStatus, ReceiptSummary, Supplier } from "@/lib/purchasing";

const selectClass = "mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function ReceiptIndex({ list, filters, suppliers }: { list: Paged<ReceiptSummary>; filters: ReceiptFilters; suppliers: Supplier[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<ReceiptFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.supplierId) params.set("supplier", merged.supplierId);
    if (merged.dateFrom) params.set("from", merged.dateFrom);
    if (merged.dateTo) params.set("to", merged.dateTo);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/goods-receipts?${query}` : "/goods-receipts"));
  }

  const filtered = Boolean(filters.q || filters.status || filters.supplierId || filters.dateFrom || filters.dateTo);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Goods Receipts</h2>
        <p className="text-xs text-slate-400">Goods that arrived against your purchase orders. Start a receipt from an Ordered purchase order; stock is added only when a receipt is confirmed.</p>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Receipt, PO, supplier reference or supplier" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as ReceiptFilters["status"] })} className={selectClass}>
              <option value="">All statuses</option>
              {(Object.keys(RECEIPT_STATUS_LABELS) as ReceiptStatus[]).map((s) => <option key={s} value={s}>{RECEIPT_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Supplier
            <select value={filters.supplierId} onChange={(e) => navigate({ supplierId: e.target.value })} className={selectClass}>
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? "" : " (inactive)"}</option>)}
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
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "", supplierId: "", dateFrom: "", dateTo: "" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so goods receipts cannot be used. Please contact your platform administrator." : "Goods receipts are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No goods receipts match these filters." : "No goods receipts yet. Open an Ordered purchase order and choose Receive goods."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Receipt</th><th className="px-4 py-3 font-semibold">Purchase order</th><th className="px-4 py-3 font-semibold">Supplier</th>
                    <th className="px-4 py-3 font-semibold">Received on</th><th className="px-4 py-3 font-semibold text-right">Lines</th><th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <Link href={`/goods-receipts/${r.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{r.number}</Link>
                        {r.supplier_reference && <div className="text-xs text-slate-500">{r.supplier_reference}</div>}
                      </td>
                      <td className="px-4 py-3"><Link href={`/purchase-orders/${r.purchase_order.id}`} className="font-mono text-xs text-slate-300 hover:text-white">{r.purchase_order.number}</Link></td>
                      <td className="px-4 py-3">{r.supplier.name}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{r.received_date}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{r.line_count}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${RECEIPT_STATUS_STYLE[r.status]}`}>{RECEIPT_STATUS_LABELS[r.status]}</span></td>
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
