"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import InvoiceTabs, { SALES_BASE } from "@/components/invoices/invoice-tabs";
import { IconAction } from "@/components/ui/icon-action";
import { downloadPdf, pdfName, pdfProblem, printPdf, type PdfOutcome } from "@/lib/invoice-pdf";
import { formatMoney } from "@/lib/product-validation";
import type { Client, HistoryFilters, HistoryItem, Paged } from "@/lib/sales";

// SALES INVOICE > HISTORY and SALES INVOICE > PENDING PAYMENTS: the same list, two views. History is every past invoice, newest first; Pending payments is the installments whose date
// has not come yet, the nearest first. The client and the date narrow either, together or one at a time. Every row can be printed or downloaded. An invoice made from an order opens its
// page; an older invoice (made from dispatched goods) opens its own page, which still has its payments.

const fieldClass = "mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";
// only older invoices carry a state worth showing
const OLD_STATUS: Record<string, string> = { draft: "Draft", partially_paid: "Part paid", paid: "Paid", void: "Void" };
const pdfUrl = (item: HistoryItem) => (item.kind === "order" ? `/api/sales/order-invoices/${item.id}/pdf` : `/api/sales/invoices/${item.id}/pdf`);

export default function InvoiceHistory({ list, filters, clients, view = "history" }: { list: Paged<HistoryItem>; filters: HistoryFilters; clients: Client[]; view?: "history" | "pending" }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `${SALES_BASE}/${view}`;

  function navigate(next: Partial<HistoryFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.clientId) params.set("client", merged.clientId);
    if (merged.day) params.set("date", merged.day);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${path}?${query}` : path));
  }

  async function output(item: HistoryItem, kind: "print" | "download") {
    if (busyId) return;
    setBusyId(item.id);
    setError(null);
    const outcome: PdfOutcome = kind === "print" ? await printPdf(pdfUrl(item)) : await downloadPdf(pdfUrl(item), pdfName(item.number));
    if (outcome === "unauthorized") router.replace("/login");
    else setError(pdfProblem(outcome));
    setBusyId(null);
  }

  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const filtered = Boolean(filters.clientId || filters.day);
  const emptyText = view === "pending" ? (filtered ? "No pending payments found." : "No pending payments.") : filtered ? "No invoices found." : "No invoices yet.";

  return (
    <div className="space-y-4">
      <InvoiceTabs base={SALES_BASE} current={view} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-400">
          Client
          <select aria-label="Client" value={filters.clientId} onChange={(e) => navigate({ clientId: e.target.value })} className={`${fieldClass} w-56`}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (inactive)"}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-400">
          Date
          <input type="date" aria-label="Date" value={filters.day} onChange={(e) => navigate({ day: e.target.value })} className={`${fieldClass} w-44`} />
        </label>
        {filtered && <button type="button" onClick={() => navigate({ clientId: "", day: "" })} className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Clear</button>}
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">{error}</p>}

      <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
        {!list.ok ? (
          <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
            {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable. Please contact your platform administrator." : "Invoices are temporarily unavailable. Please refresh in a moment."}
          </div>
        ) : list.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">{emptyText}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Invoice</th>
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Date</th>
                  <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Total</th>
                  <th className="px-2 py-3 text-right font-semibold"><span className="sr-only">Print and download</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.items.map((item) => (
                  <tr key={`${item.kind}-${item.id}`} className="hover:bg-slate-800/30">
                    <td className="px-3 py-3 whitespace-nowrap sm:px-4">
                      <Link href={item.kind === "order" ? `${SALES_BASE}/${item.id}` : `/invoices/${item.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{item.number ?? "Draft"}</Link>
                      {item.kind === "invoice" && OLD_STATUS[item.status] && <span className="ml-2 rounded-full border border-slate-600/40 bg-slate-700/30 px-2 py-0.5 text-xs text-slate-300">{OLD_STATUS[item.status]}</span>}
                      {item.installment_count && item.installment_count > 1 && <span className="mt-0.5 block text-xs text-slate-400">Installment {item.installment_no} of {item.installment_count}</span>}
                    </td>
                    <td className="px-3 py-3 sm:px-4">{item.client_name ?? "—"}<span className="mt-0.5 block text-xs text-slate-400 sm:hidden">{item.invoice_date} · {formatMoney(item.total, item.currency_code)}</span></td>
                    <td className="hidden px-4 py-3 text-xs whitespace-nowrap sm:table-cell">{item.invoice_date}</td>
                    <td className="hidden px-4 py-3 text-right font-mono text-xs whitespace-nowrap sm:table-cell">{formatMoney(item.total, item.currency_code)}</td>
                    <td className="px-2 py-3">
                      <div className="flex justify-end gap-0.5">
                        <IconAction kind="print" label="Print" ariaLabel={`Print ${item.number ?? "invoice"}`} onClick={() => void output(item, "print")} disabled={busyId !== null} />
                        <IconAction kind="download" label="Download" ariaLabel={`Download ${item.number ?? "invoice"}`} onClick={() => void output(item, "download")} disabled={busyId !== null} />
                      </div>
                    </td>
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
