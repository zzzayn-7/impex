"use client";

import { FormEvent, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/components/ui/confirm";
import { Tooltip } from "@/components/ui/tooltip";

import { ORDER_STATUS_LABELS, ORDER_STATUS_STYLE } from "@/lib/purchasing-browser";
import { api, jsonBody } from "@/lib/sales-browser";
import { formatMoney } from "@/lib/product-validation";
import { newIdempotencyKey } from "@/lib/stock-validation";
import type { OrderFilters, OrderStatus, Paged, PurchaseOrderSummary, Supplier } from "@/lib/purchasing";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

export default function OrderIndex({ list, filters, suppliers, defaultCurrency }: { list: Paged<PurchaseOrderSummary>; filters: OrderFilters; suppliers: Supplier[]; defaultCurrency?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(filters.q);
  const [confirm, confirmDialog] = useConfirm();
  const [problem, setProblem] = useState<string | null>(null);

  // The bin deletes an order for good: a draft, placed or cancelled order that has no goods receipt (the Purchasing Service refuses, and says why, when goods were received).
  async function remove(order: PurchaseOrderSummary) {
    const ok = await confirm({
      title: `Delete ${order.number} for good?`,
      message: "The order and its lines are removed and cannot be recovered. Its number is not used again. No stock is involved. An order that already has goods received, or any goods receipt, cannot be deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setProblem(null);
    const r = await api(`/api/purchasing/purchase-orders/${order.id}`, { method: "DELETE" });
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setProblem(r.error);
    router.refresh();
  }

  function navigate(next: Partial<OrderFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.supplierId) params.set("supplier", merged.supplierId);
    if (merged.status) params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/purchase-orders?${query}` : "/purchase-orders"));
  }

  const filtered = Boolean(filters.q || filters.supplierId || filters.status);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const activeSuppliers = suppliers.filter((s) => s.is_active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Purchase Orders</h2>
          <p className="text-xs text-slate-400">What you have ordered from suppliers. An order does not change your stock.</p>
        </div>
        <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500">
          {creating ? "Close" : "New Purchase Order"}
        </button>
      </div>

      {creating && <NewOrderForm suppliers={activeSuppliers} defaultSupplierId={filters.supplierId} defaultCurrency={defaultCurrency} onCancel={() => setCreating(false)} />}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[14rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PO number, supplier reference or supplier" maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
            </label>
            <button type="submit" className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Supplier
            <select value={filters.supplierId} onChange={(e) => navigate({ supplierId: e.target.value })} className="mt-1.5 block max-w-[14rem] rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? "" : " (inactive)"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select value={filters.status} onChange={(e) => navigate({ status: e.target.value as OrderFilters["status"] })} className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="">All statuses</option>
              {(Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).map((s) => <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>)}
            </select>
          </label>
        </div>

        {problem && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{problem}</div>}
        <div aria-busy={isPending} className={isPending ? "opacity-50" : ""}>
          {!list.ok ? (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              {list.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so purchase orders cannot be used. Please contact your platform administrator." : "Purchase orders are temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No purchase orders match these filters." : "No purchase orders yet. Use New Purchase Order to create your first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Order</th><th className="px-4 py-3 font-semibold">Supplier</th><th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold text-right">Lines</th><th className="px-4 py-3 font-semibold text-right">Total</th><th className="px-4 py-3 font-semibold">Status</th>
                    <th className="w-12 px-2 py-3"><span className="sr-only">Delete</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((order) => (
                    <tr key={order.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <Link href={`/purchase-orders/${order.id}`} className="font-mono text-sm font-semibold text-indigo-300 hover:text-indigo-200">{order.number}</Link>
                        {order.supplier_reference && <div className="text-xs text-slate-500">{order.supplier_reference}</div>}
                      </td>
                      <td className="px-4 py-3">{order.supplier.name}{!order.supplier.is_active && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}</td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">{order.order_date}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{order.line_count}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{formatMoney(order.total_amount, order.currency_code)}</td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABELS[order.status]}</span></td>
                      <td className="px-2 py-3 text-right">
                        {(order.status === "draft" || order.status === "ordered" || order.status === "cancelled") && (
                          <Tooltip label="Delete order">
                            <button type="button" onClick={() => void remove(order)} aria-label={`Delete ${order.number}`} className="p-1.5 text-red-400 transition-colors hover:text-red-300 focus-visible:text-red-300 focus-visible:outline-none">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                            </button>
                          </Tooltip>
                        )}
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
      </section>
      {confirmDialog}
    </div>
  );
}

function NewOrderForm({ suppliers, defaultSupplierId, defaultCurrency, onCancel }: { suppliers: Supplier[]; defaultSupplierId: string; defaultCurrency?: string; onCancel: () => void }) {
  const router = useRouter();
  const [values, setValues] = useState({
    supplierId: suppliers.some((s) => s.id === defaultSupplierId) ? defaultSupplierId : "", currencyCode: defaultCurrency ?? "USD", supplierReference: "",
    orderDate: new Date().toISOString().slice(0, 10), expectedDeliveryDate: "", notes: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One Idempotency-Key per intended order. Resubmitting the SAME values (a double click, a retry after a timeout) reuses it, so
  // the order is created once; changing anything starts a new order with a new key.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const set = (field: keyof typeof values, value: string) => { setValues((v) => ({ ...v, [field]: value })); setErrors((e) => ({ ...e, [field]: "" })); };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    const found: Record<string, string> = {};
    if (!values.supplierId) found.supplierId = "Choose a supplier.";
    if (!/^[A-Za-z]{3}$/.test(values.currencyCode.trim())) found.currencyCode = "Use a 3-letter currency code such as USD or EUR.";
    if (values.orderDate && values.expectedDeliveryDate && values.expectedDeliveryDate < values.orderDate) found.expectedDeliveryDate = "The expected delivery cannot be before the order date.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const fingerprint = JSON.stringify(values);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newIdempotencyKey() };
    setBusy(true);
    const r = await api("/api/purchasing/purchase-orders", { method: "POST", headers: { "Idempotency-Key": attempt.current.key }, ...jsonBody(values) });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setFormError(r.error);
    }
    router.push(`/purchase-orders/${r.data.order.id}`);
  }

  const err = (id: string) => errors[id] && <span role="alert" className="mt-1 block text-xs text-red-400">{errors[id]}</span>;

  return (
    <form onSubmit={submit} noValidate aria-label="New purchase order" className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-white">New purchase order</h3>
      {formError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</div>}
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">
          Supplier
          <select value={values.supplierId} onChange={(e) => set("supplierId", e.target.value)} aria-invalid={Boolean(errors.supplierId)} className={fieldClass}>
            <option value="">{suppliers.length ? "Choose a supplier…" : "No active suppliers yet"}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}
          </select>
          {err("supplierId")}
        </label>
        <label className="text-xs font-medium text-slate-400">
          Currency
          <input value={values.currencyCode} onChange={(e) => set("currencyCode", e.target.value.toUpperCase())} maxLength={3} aria-invalid={Boolean(errors.currencyCode)} className={`${fieldClass} font-mono uppercase`} />
          {err("currencyCode")}
        </label>
        <label className="text-xs font-medium text-slate-400">
          Order date
          <input type="date" value={values.orderDate} onChange={(e) => set("orderDate", e.target.value)} className={fieldClass} />
          {err("orderDate")}
        </label>
        <label className="text-xs font-medium text-slate-400">
          Expected delivery (optional)
          <input type="date" value={values.expectedDeliveryDate} onChange={(e) => set("expectedDeliveryDate", e.target.value)} className={fieldClass} />
          {err("expectedDeliveryDate")}
        </label>
        <label className="text-xs font-medium text-slate-400">
          Supplier reference (optional)
          <input value={values.supplierReference} onChange={(e) => set("supplierReference", e.target.value)} maxLength={100} className={fieldClass} />
          {err("supplierReference")}
        </label>
      </div>
      <label className="block text-xs font-medium text-slate-400">
        Notes (optional)
        <input value={values.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} className={fieldClass} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Creating…" : "Create draft order"}</button>
      </div>
    </form>
  );
}
