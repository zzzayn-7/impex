"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import InvoicesHeader from "@/components/invoices/invoices-header";
import { SALES_INVOICES_HREF } from "@/lib/invoices-nav";
import { formatMoney, INVOICE_STATUS_LABELS, INVOICE_STATUS_STYLE, PAYMENT_STATUS_LABELS } from "@/lib/sales-browser";
import type { Client, InvoiceFilters, InvoiceStatus, InvoiceSummary, Paged, PaymentStatusFilter } from "@/lib/sales";

const selectClass = "mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function InvoiceIndex({ list, filters, clients }: { list: Paged<InvoiceSummary>; filters: InvoiceFilters; clients: Client[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);

  function navigate(next: Partial<InvoiceFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status) params.set("status", merged.status);
    if (merged.paymentStatus) params.set("payment", merged.paymentStatus);
    if (merged.clientId) params.set("client", merged.clientId);
    if (merged.dateFrom) params.set("from", merged.dateFrom);
    if (merged.dateTo) params.set("to", merged.dateTo);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${SALES_INVOICES_HREF}?${query}` : SALES_INVOICES_HREF));
  }

  const filtered = Boolean(filters.q || filters.status || filters.paymentStatus || filters.clientId || filters.dateFrom || filters.dateTo);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;

  return (
    <div className="space-y-6">
      <InvoicesHeader
        current="sales"
        actions={<Link href="/invoices/new" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">New Invoice</Link>}
      >
        <p className="text-xs text-slate-400">Bill your clients for goods you have dispatched, and record the payments you receive. Invoicing never changes your stock.</p>
      </InvoicesHeader>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Invoice number or client" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as InvoiceFilters["status"] })} className={selectClass}>
              <option value="">All statuses</option>
              {(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map((s) => <option key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Payment
            <select value={filters.paymentStatus} onChange={(e) => navigate({ paymentStatus: e.target.value as InvoiceFilters["paymentStatus"] })} className={selectClass}>
              <option value="">Any payment status</option>
              {(Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatusFilter[]).map((s) => <option key={s} value={s}>{PAYMENT_STATUS_LABELS[s]}</option>)}
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
          {filtered && <button type="button" onClick={() => { setSearch(""); navigate({ q: "", status: "", paymentStatus: "", clientId: "", dateFrom: "", dateTo: "" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">Clear filters</button>}
        </div>

        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so invoices cannot be used. Please contact your platform administrator." : "Invoices are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No invoices match these filters." : "No invoices yet. Choose New Invoice to bill a client for goods you have dispatched."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Invoice</th><th className="px-4 py-3 font-semibold">Client</th><th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold">Due</th><th className="px-4 py-3 font-semibold text-right">Total</th><th className="px-4 py-3 font-semibold text-right">Paid</th>
                    <th className="px-4 py-3 font-semibold text-right">Outstanding</th><th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((i) => (
                    <tr key={i.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <Link href={`/invoices/${i.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{i.number ?? "Draft"}</Link>
                        {i.delivery_list && <div className="font-mono text-xs text-slate-500">{i.delivery_list.number}</div>}
                      </td>
                      <td className="px-4 py-3">{i.client.name}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{i.invoice_date}</td>
                      <td className={`px-4 py-3 text-xs whitespace-nowrap ${i.overdue ? "font-semibold text-red-300" : ""}`}>{i.due_date}{i.overdue && <span className="block text-[11px]">overdue</span>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(i.total)} <span className="text-slate-500">{i.currency_code}</span></td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(i.paid_total)}</td>
                      <td className={`px-4 py-3 text-right font-mono text-xs whitespace-nowrap ${i.status === "issued" || i.status === "partially_paid" ? "text-white" : "text-slate-500"}`}>{formatMoney(i.outstanding)}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLE[i.status]}`}>{INVOICE_STATUS_LABELS[i.status]}</span></td>
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
