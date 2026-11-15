"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import InvoiceTabs, { PURCHASE_BASE } from "@/components/invoices/invoice-tabs";
import { RECEIPT_STATUS_LABELS, RECEIPT_STATUS_STYLE } from "@/lib/purchasing-browser";
import type { Paged, ReceiptFilters, ReceiptSummary, Supplier } from "@/lib/purchasing";

// PURCHASE INVOICE > HISTORY. Every goods receipt (the record of what arrived from a supplier), newest first. The supplier and the date narrow it, together or one at a time.

const fieldClass = "mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function PurchaseHistory({ list, filters, suppliers }: { list: Paged<ReceiptSummary>; filters: ReceiptFilters; suppliers: Supplier[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const day = filters.dateFrom; // one date: from and to are the same day

  function navigate(next: { supplierId?: string; day?: string; page?: number }) {
    const supplierId = next.supplierId ?? filters.supplierId;
    const chosenDay = next.day ?? day;
    const page = next.page ?? 1;
    const params = new URLSearchParams();
    if (supplierId) params.set("supplier", supplierId);
    if (chosenDay) params.set("date", chosenDay);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${PURCHASE_BASE}/history?${query}` : `${PURCHASE_BASE}/history`));
  }

  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const filtered = Boolean(filters.supplierId || day);

  return (
    <div className="space-y-4">
      <InvoiceTabs base={PURCHASE_BASE} current="history" />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-400">
          Supplier
          <select aria-label="Supplier" value={filters.supplierId} onChange={(e) => navigate({ supplierId: e.target.value })} className={`${fieldClass} w-56`}>
            <option value="">All suppliers</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? "" : " (inactive)"}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-400">
          Date
          <input type="date" aria-label="Date" value={day} onChange={(e) => navigate({ day: e.target.value })} className={`${fieldClass} w-44`} />
        </label>
        {filtered && <button type="button" onClick={() => navigate({ supplierId: "", day: "" })} className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Clear</button>}
      </div>

      <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
        {!list.ok ? (
          <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
            {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable. Please contact your platform administrator." : "Invoices are temporarily unavailable. Please refresh in a moment."}
          </div>
        ) : list.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">{filtered ? "No invoices found." : "No invoices yet."}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Receipt</th>
                  <th className="px-4 py-3 font-semibold">Supplier</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Order</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Date</th>
                  <th className="px-3 py-3 font-semibold sm:px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.items.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30">
                    <td className="px-3 py-3 whitespace-nowrap sm:px-4"><Link href={`/goods-receipts/${r.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{r.number}</Link></td>
                    <td className="px-3 py-3 sm:px-4">{r.supplier.name}<span className="mt-0.5 block text-xs text-slate-400 sm:hidden">{r.purchase_order.number} · {r.received_date}</span></td>
                    <td className="hidden px-4 py-3 font-mono text-xs sm:table-cell">{r.purchase_order.number}</td>
                    <td className="hidden px-4 py-3 text-xs whitespace-nowrap sm:table-cell">{r.received_date}</td>
                    <td className="px-3 py-3 sm:px-4"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${RECEIPT_STATUS_STYLE[r.status]}`}>{RECEIPT_STATUS_LABELS[r.status]}</span></td>
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
            <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
            <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
