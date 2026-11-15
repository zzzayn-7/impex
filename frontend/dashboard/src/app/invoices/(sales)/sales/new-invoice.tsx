"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useStamp } from "@/components/clock";
import InvoiceTabs, { SALES_BASE } from "@/components/invoices/invoice-tabs";
import { api, jsonBody } from "@/lib/sales-browser";
import { formatMoney } from "@/lib/product-validation";
import type { Client, OrderInvoiceRef, OrderSummary, Paged, PreparedFilters } from "@/lib/sales";

// SALES INVOICE > NEW INVOICE. The prepared orders (booked, waiting to be dispatched), newest first. Pick a client to see only theirs, or search an order number.
// "Create invoice" makes the invoice of that one order and opens it; an order that already has one shows "View invoice" instead (there is never a second).

const selectClass = "mt-1.5 block w-56 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function NewInvoice({ list, filters, clients, refs }: { list: Paged<OrderSummary>; filters: PreparedFilters; clients: Client[]; refs: OrderInvoiceRef[] }) {
  const router = useRouter();
  const stamp = useStamp();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invoiceOf = new Map(refs.map((r) => [r.order_id, r]));

  function navigate(next: Partial<PreparedFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.clientId) params.set("client", merged.clientId);
    if (merged.q) params.set("q", merged.q);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `${SALES_BASE}?${query}` : SALES_BASE));
  }

  async function create(order: OrderSummary) {
    if (busyId) return;
    setBusyId(order.id);
    setError(null);
    const r = await api(`/api/sales/order-invoices`, { method: "POST", ...jsonBody({ orderId: order.id }) });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok || !r.data?.invoice?.id) {
      setBusyId(null);
      return setError(r.ok ? "The invoice could not be opened. Please try again." : r.error);
    }
    router.push(`${SALES_BASE}/${encodeURIComponent(r.data.invoice.id)}`);
  }

  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const filtered = Boolean(filters.q || filters.clientId);

  return (
    <div className="space-y-4">
      <InvoiceTabs base={SALES_BASE} current="new" />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-400">
          Client
          <select aria-label="Client" value={filters.clientId} onChange={(e) => navigate({ clientId: e.target.value })} className={selectClass}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (inactive)"}</option>)}
          </select>
        </label>
        <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
          <label className="flex-1 text-xs font-medium text-slate-400">
            Search
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order number" maxLength={100}
              className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
          </label>
          <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
        </form>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">{error}</p>}

      <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
        {!list.ok ? (
          <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
            {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable. Please contact your platform administrator." : "Orders are temporarily unavailable. Please refresh in a moment."}
          </div>
        ) : list.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">{filtered ? "No orders found." : "No orders waiting to be dispatched."}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Order</th>
                  <th className="px-4 py-3 font-semibold">Client</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Date</th>
                  <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Total</th>
                  <th className="px-4 py-3 font-semibold"><span className="sr-only">Invoice</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.items.map((order) => {
                  const existing = invoiceOf.get(order.id);
                  return (
                    <tr key={order.id} className="hover:bg-slate-800/30">
                      <td className="px-3 py-3 font-mono text-sm font-semibold whitespace-nowrap text-white sm:px-4">{order.number}<span className="mt-0.5 block font-sans text-xs font-normal text-slate-400 sm:hidden">{order.total_amount && order.currency_code ? formatMoney(order.total_amount, order.currency_code) : "—"}</span></td>
                      <td className="px-3 py-3 sm:px-4">{order.client.name}</td>
                      <td className="hidden px-4 py-3 text-xs whitespace-nowrap sm:table-cell">{stamp(order.created_at)}</td>
                      <td className="hidden px-4 py-3 text-right font-mono text-xs whitespace-nowrap sm:table-cell">{order.total_amount && order.currency_code ? formatMoney(order.total_amount, order.currency_code) : "—"}</td>
                      <td className="px-3 py-3 text-right sm:px-4">
                        {existing ? (
                          <Link href={`${SALES_BASE}/${existing.invoice_id}`} aria-label={`View invoice ${existing.number}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">View invoice</Link>
                        ) : order.prices_recorded === false ? (
                          <span className="text-xs text-slate-500">No prices</span>
                        ) : (
                          <button type="button" onClick={() => create(order)} disabled={busyId !== null} aria-label={`Create invoice for ${order.number}`}
                            className="min-h-10 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
                            {busyId === order.id ? "Creating…" : "Create invoice"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
