"use client";

import { FormEvent, useEffect, useState, useTransition } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import Link from "next/link";
import { useRouter } from "next/navigation";

import AddLineForm from "@/components/add-line-form";
import { NewProductModal } from "@/components/product/product-modal";
import { NO_STOCK_NOTICE, ORDER_STATUS_LABELS, ORDER_STATUS_STYLE, RECEIPT_STATUS_LABELS, RECEIPT_STATUS_STYLE, lineTotal, validatePrice } from "@/lib/purchasing-browser";
import { api, jsonBody, qty } from "@/lib/sales-browser";
import { formatMoney, plainDecimal, type Product } from "@/lib/product-validation";
import { lookupOnServer, normalizeScanned, type ScanResult } from "@/lib/scan";
import { validateQuantity } from "@/lib/stock-validation";
import type { OrderLine, PurchaseOrderDetail, Supplier } from "@/lib/purchasing";
import QuantityInput from "@/components/ui/quantity-input";
import { useStamp } from "@/components/clock";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

export default function OrderDetail({ order, suppliers }: { order: PurchaseOrderDetail; suppliers: Supplier[] }) {
  const stamp = useStamp();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"order" | "cancel" | "delete" | null>(null);
  const [editing, setEditing] = useState<{ id: string; quantity: string; price: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);

  const draft = order.status === "draft";
  const refresh = () => startTransition(() => router.refresh());

  async function call(url: string, init: RequestInit, success: string) {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    const r = await api(url, init);
    setBusy(false);
    if (r.status === 401) { router.replace("/login"); return false; }
    if (!r.ok) { setMessage({ ok: false, text: r.error }); return false; }
    setMessage({ ok: true, text: success });
    refresh();
    return true;
  }

  async function changeStatus(action: "order" | "cancel") {
    const text = action === "order"
      ? `${order.number} was placed with ${order.supplier.name}. Its details and lines are now frozen. No stock was added.`
      : `${order.number} was cancelled. It is kept for history; no stock was involved.`;
    await call(`/api/purchasing/purchase-orders/${order.id}/${action}`, { method: "POST" }, text);
    setConfirming(null);
  }

  // DELETE for good: a draft, placed or cancelled order that has no goods receipt. The Purchasing Service refuses (and says why) when goods were received.
  async function deleteOrder() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await api(`/api/purchasing/purchase-orders/${order.id}`, { method: "DELETE" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setConfirming(null);
      return setMessage({ ok: false, text: r.error });
    }
    router.replace("/purchase-orders");
    router.refresh();
  }

  async function saveLine(line: OrderLine) {
    if (!editing) return;
    // The shape is checked here; whether this unit allows a fraction is the Inventory Service's call, relayed by the server.
    const q = validateQuantity(editing.quantity.trim(), true, line.unit);
    const p = validatePrice(editing.price.trim());
    if (q || p) return setEditError(q ?? p ?? null);
    setEditError(null);
    if (await call(`/api/purchasing/purchase-orders/${order.id}/lines/${line.id}`, { method: "PATCH", ...jsonBody({ quantity: editing.quantity.trim(), unitPrice: editing.price.trim() }) }, `${line.product_name} was updated.`)) setEditing(null);
  }

  async function removeLine(line: OrderLine) {
    if (await call(`/api/purchasing/purchase-orders/${order.id}/lines/${line.id}`, { method: "DELETE" }, `${line.product_name} was removed from ${order.number}.`)) setRemoving(null);
  }

  const startEdit = (line: OrderLine) => { setEditing({ id: line.id, quantity: qty(line.quantity).replace(/,/g, ""), price: line.unit_price.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") }); setEditError(null); };
  const money = (value: string) => formatMoney(value, order.currency_code);
  const editPreview = (line: OrderLine) => {
    if (!editing || editing.id !== line.id) return null;
    const q = editing.quantity.trim(), p = editing.price.trim();
    return q && p && !validateQuantity(q, true, line.unit) && !validatePrice(p) ? lineTotal(q, p) : null;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-2xl font-semibold text-white">{order.number}</h2>
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${ORDER_STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABELS[order.status]}</span>
          </div>
          <p className="mt-1 text-sm text-slate-300">
            From <Link href={`/purchase-orders?supplier=${order.supplier.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">{order.supplier.name}</Link>
            {!order.supplier.is_active && <span className="ml-2 rounded-full border border-slate-600/40 bg-slate-700/30 px-2 py-0.5 text-xs text-slate-400">inactive supplier</span>}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Ordered on {order.order_date}{order.expected_delivery_date ? ` · expected ${order.expected_delivery_date}` : ""}{order.supplier_reference ? ` · supplier reference ${order.supplier_reference}` : ""} · {order.currency_code}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Created by {order.created_by_email}
            {order.ordered_at && ` · placed by ${order.ordered_by_email} on ${stamp(order.ordered_at)}`}
            {order.cancelled_at && ` · cancelled by ${order.cancelled_by_email} on ${stamp(order.cancelled_at)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Order actions">
          {draft && <button type="button" disabled={busy || order.lines.length === 0} onClick={() => setConfirming("order")} className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">Mark as Ordered</button>}
          {order.can_receive && <Link href={`/purchase-orders/${order.id}/receive`} className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Receive goods</Link>}
          {(order.status === "draft" || order.status === "ordered") && <button type="button" disabled={busy} onClick={() => setConfirming("cancel")} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-red-300 hover:bg-slate-800 disabled:opacity-50">Cancel order</button>}
          {(order.status === "draft" || order.status === "ordered" || order.status === "cancelled") && <button type="button" disabled={busy} onClick={() => setConfirming("delete")} className="min-h-11 rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">Delete order</button>}
        </div>
      </div>

      {confirming && (
        <div role="alertdialog" aria-label={confirming === "order" ? "Confirm placing the order" : confirming === "delete" ? "Confirm deleting the order" : "Confirm cancelling the order"} className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-200">
            {confirming === "order"
              ? `Place ${order.number} with ${order.supplier.name} for ${money(order.total_amount)}?`
              : confirming === "delete"
                ? `Delete ${order.number} for good?`
                : `Cancel ${order.number}?`}
          </p>
          <p className="text-xs text-amber-300/80">
            {confirming === "order"
              ? "Once placed, the supplier, dates, currency, products, quantities and prices are frozen and can no longer be changed. This does not add any stock."
              : confirming === "delete"
                ? "The order and its lines are removed and cannot be recovered. Its number is not used again. No stock is involved. An order that already has goods received, or any goods receipt, cannot be deleted."
                : "The order is kept for history and cannot be reactivated. No stock is involved."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setConfirming(null)} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60">Back</button>
            <button type="button" onClick={() => (confirming === "delete" ? deleteOrder() : changeStatus(confirming))} disabled={busy} className={`min-h-10 rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-60 ${confirming === "order" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-red-600 hover:bg-red-500"}`}>
              {busy ? "Saving…" : confirming === "order" ? "Place order" : confirming === "delete" ? "Yes, delete it" : "Yes, cancel it"}
            </button>
          </div>
        </div>
      )}

      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{order.stock_notice || NO_STOCK_NOTICE}</p>
      {order.status === "ordered" && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">This order has been placed. Its details, products, quantities and prices are frozen. Stock is added when you receive the goods and confirm a goods receipt.</p>}
      {order.status === "partially_received" && <p role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">Some of the goods have been received and confirmed. The order stays open until everything has arrived. Its details are frozen, and it can no longer be cancelled.</p>}
      {order.status === "received" && <p role="status" className="rounded-lg border border-teal-500/20 bg-teal-500/10 px-4 py-3 text-xs text-teal-200">Everything on this order has been received. The order is complete and frozen.</p>}
      {order.status === "cancelled" && <p role="status" className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-xs text-slate-400">This order was cancelled and is kept for history.</p>}

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}
      {draft && !order.supplier.is_active && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{order.supplier.name} is inactive. Reactivate the supplier (or choose another) before changing or placing this order.</p>}

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Products on this order">
        <h3 className="text-sm font-semibold text-white">Products ({order.lines.length})</h3>
        {order.lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">No products yet. {draft ? "Look a product up below and add it with the quantity and price." : ""}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-3 font-semibold">Product</th><th className="px-3 py-3 font-semibold text-right">Quantity</th><th className="px-3 py-3 font-semibold text-right">Unit price</th>
                  <th className="px-3 py-3 font-semibold text-right">Line total</th>
                  {!draft && <><th className="px-3 py-3 font-semibold text-right">Received</th><th className="px-3 py-3 font-semibold text-right">Remaining</th></>}{draft && <th className="px-3 py-3 font-semibold">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {order.lines.map((line) => (
                  <tr key={line.id} className="align-top hover:bg-slate-800/30">
                    <td className="px-3 py-3">
                      <div className="font-medium text-white">{line.product_name}</div>
                      <div className="font-mono text-xs text-indigo-300">{line.product_sku}</div>
                      {line.notes && <div className="mt-1 text-xs text-slate-500">{line.notes}</div>}
                    </td>
                    {editing?.id === line.id ? (
                      <td colSpan={3} className="px-3 py-3">
                        <div className="flex flex-col items-end gap-2">
                          <div className="flex flex-wrap justify-end gap-2">
                            <QuantityInput aria-label={`Quantity of ${line.product_name}`} value={editing.quantity} onChange={(v) => { setEditing({ ...editing, quantity: v }); setEditError(null); }} autoFocus className="w-40" />
                            <input aria-label={`Unit price of ${line.product_name}`} value={editing.price} onChange={(e) => { setEditing({ ...editing, price: e.target.value }); setEditError(null); }} inputMode="decimal"
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveLine(line); } if (e.key === "Escape") setEditing(null); }}
                              className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right font-mono text-sm text-white outline-none focus:border-indigo-500" />
                          </div>
                          <span className="font-mono text-xs text-slate-400">Line total: {editPreview(line) ? money(editPreview(line)!) : "—"}</span>
                          {editError && <span role="alert" className="max-w-xs text-right text-xs text-red-400">{editError}</span>}
                          <span className="flex gap-1">
                            <button type="button" disabled={busy} onClick={() => saveLine(line)} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">Save</button>
                            <button type="button" onClick={() => { setEditing(null); setEditError(null); }} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                          </span>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td className="px-3 py-3 text-right font-mono">{qty(line.quantity)} <span className="text-xs text-slate-400">{line.unit}</span></td>
                        <td className="px-3 py-3 text-right font-mono text-xs whitespace-nowrap">{money(line.unit_price)}</td>
                        <td className="px-3 py-3 text-right font-mono font-semibold whitespace-nowrap text-white">{money(line.line_total)}</td>
                      </>
                    )}
                    {!draft && (
                      <>
                        <td className="px-3 py-3 text-right font-mono text-xs">
                          {qty(line.received_quantity ?? "0")} <span className="text-slate-500">{line.unit}</span>
                          {line.pending_quantity && /[1-9]/.test(line.pending_quantity) && <Tooltip label="Being added to stock; reserved until confirmed"><div tabIndex={0} className="rounded text-sky-300">+{qty(line.pending_quantity)} in progress</div></Tooltip>}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-xs font-semibold text-white">{qty(line.remaining_quantity ?? line.quantity)}</td>
                      </>
                    )}
                    {draft && (
                      <td className="px-3 py-3">
                        {removing === line.id ? (
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-slate-300">Remove?</span>
                            <button type="button" disabled={busy} onClick={() => removeLine(line)} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">Yes</button>
                            <button type="button" onClick={() => setRemoving(null)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">No</button>
                          </span>
                        ) : (
                          <span className="flex gap-1.5">
                            <button type="button" onClick={() => startEdit(line)} aria-label={`Edit ${line.product_name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Edit</button>
                            <button type="button" onClick={() => setRemoving(line.id)} aria-label={`Remove ${line.product_name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-slate-800">Remove</button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700">
                  <th scope="row" colSpan={3} className="px-3 py-3 text-right text-xs font-semibold uppercase text-slate-400">Order total</th>
                  <td className="px-3 py-3 text-right font-mono text-base font-bold whitespace-nowrap text-white" data-testid="order-total">{money(order.total_amount)}</td>
                  <td colSpan={draft ? 1 : 2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {!draft && order.status !== "cancelled" && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Goods receipts">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Goods receipts ({(order.receipts ?? []).length})</h3>
            {order.can_receive && <Link href={`/purchase-orders/${order.id}/receive`} className="text-sm font-medium text-indigo-300 hover:text-indigo-200">Receive goods →</Link>}
          </div>
          {(order.receipts ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">Nothing has been received against this order yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                  <tr><th className="px-3 py-2 font-semibold">Receipt</th><th className="px-3 py-2 font-semibold">Received on</th><th className="px-3 py-2 font-semibold text-right">Lines</th><th className="px-3 py-2 font-semibold">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {(order.receipts ?? []).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-800/30">
                      <td className="px-3 py-2"><Link href={`/goods-receipts/${r.id}`} className="font-mono font-semibold text-indigo-300 hover:text-indigo-200">{r.number}</Link>{r.supplier_reference && <span className="ml-2 text-xs text-slate-500">{r.supplier_reference}</span>}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{r.received_date}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{r.line_count}</td>
                      <td className="px-3 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${RECEIPT_STATUS_STYLE[r.status]}`}>{RECEIPT_STATUS_LABELS[r.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {draft && (
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Add a product">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Add a product</h3>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">{adding ? "Close" : "Find a product (SKU or barcode)"}</button>
              <button type="button" onClick={() => setEditingHeader((v) => !v)} aria-expanded={editingHeader} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">{editingHeader ? "Close" : "Edit order details"}</button>
            </div>
          </div>
          {adding && <ProductLookup order={order} onAdded={(text) => { setMessage({ ok: true, text }); refresh(); }} />}
          {editingHeader && <HeaderForm order={order} suppliers={suppliers} onSaved={(text) => { setEditingHeader(false); setMessage({ ok: true, text }); refresh(); }} />}
        </section>
      )}
    </div>
  );
}

// Choose the product to order: find it by SKU or barcode (typed, or scanned into the box), search the catalog by name, or register a NEW product right here
// when it does not exist yet. Whichever way it is chosen, the same form then takes the quantity and the unit purchase price. Registering a product puts
// nothing in stock (stock increases only when a goods receipt is confirmed), and the purchase price on a line never changes the product's own prices.
function ProductLookup({ order, onAdded }: { order: PurchaseOrderDetail; onAdded: (message: string) => void }) {
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Product[] | null>(null); // null = nothing searched yet
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Product | null>(null); // chosen from the search, or just registered
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Search the catalog by name / SKU while typing (after a short pause); a slower, older answer never replaces a newer one.
  useEffect(() => {
    const text = term.trim();
    if (text.length < 2) { setResults(null); setSearching(false); return; }
    let current = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/products?q=${encodeURIComponent(text)}&limit=8`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (current) setResults(res.ok && Array.isArray(body?.items) ? body.items : []);
      } catch {
        if (current) setResults([]);
      } finally {
        if (current) setSearching(false);
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [term]);

  async function find(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (looking || !code.trim()) return;
    setError(null);
    setFound(null);
    setPicked(null);
    setNotice(null);
    const normalized = normalizeScanned(code);
    if (!normalized.ok) return setError(normalized.message);
    setLooking(true);
    const result = await lookupOnServer(normalized.code);
    setLooking(false);
    if (result.kind === "found") setFound(result.result);
    else setError(result.message);
  }

  const chosen: Product | null = picked ?? (found && found.product.is_active ? found.product : null);
  const finish = (message: string) => { setFound(null); setPicked(null); setCode(""); setTerm(""); setResults(null); setNotice(null); onAdded(message); };
  const typed = term.trim();

  return (
    <div className="space-y-4">
      <form onSubmit={find} role="search" aria-label="Find a product" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-medium text-slate-400">
          SKU or barcode
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={200} placeholder="Type, or scan into this box" className={`${fieldClass} font-mono`} />
        </label>
        <button type="submit" disabled={looking || !code.trim()} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">{looking ? "Looking…" : "Find product"}</button>
      </form>

      <div className="space-y-2 border-t border-slate-800 pt-4">
        <label className="block text-xs font-medium text-slate-400">
          Or search your products by name
          <input type="search" value={term} onChange={(e) => { setTerm(e.target.value); setPicked(null); setNotice(null); }} autoComplete="off" maxLength={100} placeholder="e.g. steel bolt" aria-label="Search products by name" className={fieldClass} />
        </label>
        {searching && <p role="status" className="text-xs text-slate-500">Searching…</p>}
        {results && results.length > 0 && (
          <ul aria-label="Matching products" className="divide-y divide-slate-800/60 rounded-lg border border-slate-800">
            {results.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => { setPicked(p); setFound(null); setError(null); setNotice(null); }} aria-label={`Choose ${p.name} (${p.sku})`} aria-pressed={picked?.id === p.id}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-800/50 ${picked?.id === p.id ? "bg-slate-800/60" : ""}`}>
                  <span><span className="font-medium text-white">{p.name}</span> <span className="font-mono text-xs text-indigo-300">{p.sku}</span></span>
                  <span className="shrink-0 text-xs text-slate-400">{p.unit} · cost {formatMoney(p.cost_price, p.currency_code)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {results && results.length === 0 && !searching && <p className="text-sm text-slate-400">No active product matches “{typed}”.</p>}
        <div>
          <button type="button" onClick={() => { setError(null); setNotice(null); setRegistering(true); }} aria-haspopup="dialog" className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">
            Add New Product
          </button>
          <span className="ml-3 text-xs text-slate-500">Not in your catalog yet? Register it here and order it straight away.</span>
        </div>
      </div>

      {registering && (
        <NewProductModal
          defaults={{ currencyCode: order.currency_code, ...(results && results.length === 0 && typed ? { name: typed } : {}) }}
          onClose={() => setRegistering(false)}
          onSaved={(product, message) => { setRegistering(false); setFound(null); setError(null); setPicked(product); setNotice(`${message} Enter the quantity and the purchase price to add it to ${order.number}.`); }}
        />
      )}

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      {found && !found.product.is_active && !picked && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{found.product.name} is archived and cannot be ordered. Restore it from the Stock page first.</p>}
      {chosen && (
        <AddLineForm
          key={chosen.id}
          orderId={order.id}
          orderNumber={order.number}
          currency={order.currency_code}
          product={chosen}
          initialPrice={picked && picked.currency_code === order.currency_code ? plainDecimal(picked.cost_price) : undefined}
          onAdded={finish}
          onDuplicate={() => undefined}
        />
      )}
    </div>
  );
}

function HeaderForm({ order, suppliers, onSaved }: { order: PurchaseOrderDetail; suppliers: Supplier[]; onSaved: (message: string) => void }) {
  const [values, setValues] = useState({
    supplierId: order.supplier.id, currencyCode: order.currency_code, supplierReference: order.supplier_reference ?? "", orderDate: order.order_date,
    expectedDeliveryDate: order.expected_delivery_date ?? "", notes: order.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (field: keyof typeof values, value: string) => { setValues((v) => ({ ...v, [field]: value })); setErrors((e) => ({ ...e, [field]: "" })); };
  const options = suppliers.some((s) => s.id === order.supplier.id) ? suppliers : [{ id: order.supplier.id, name: order.supplier.name, code: order.supplier.code } as Supplier, ...suppliers];

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const r = await api(`/api/purchasing/purchase-orders/${order.id}`, { method: "PATCH", ...jsonBody(values) });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      return setError(r.error);
    }
    onSaved("Order details saved.");
  }

  return (
    <form onSubmit={save} noValidate aria-label="Order details" className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-3">
      <label className="text-xs font-medium text-slate-400 sm:col-span-2">
        Supplier
        <select value={values.supplierId} onChange={(e) => set("supplierId", e.target.value)} className={fieldClass}>
          {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="text-xs font-medium text-slate-400">
        Currency {order.lines.length > 0 && <span className="text-slate-600">(locked: the order has lines)</span>}
        <input value={values.currencyCode} onChange={(e) => set("currencyCode", e.target.value.toUpperCase())} maxLength={3} disabled={order.lines.length > 0} className={`${fieldClass} font-mono uppercase disabled:opacity-50`} />
        {errors.currencyCode && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.currencyCode}</span>}
      </label>
      <label className="text-xs font-medium text-slate-400">
        Order date
        <input type="date" value={values.orderDate} onChange={(e) => set("orderDate", e.target.value)} className={fieldClass} />
      </label>
      <label className="text-xs font-medium text-slate-400">
        Expected delivery
        <input type="date" value={values.expectedDeliveryDate} onChange={(e) => set("expectedDeliveryDate", e.target.value)} className={fieldClass} />
        {errors.expectedDeliveryDate && <span role="alert" className="mt-1 block text-xs text-red-400">{errors.expectedDeliveryDate}</span>}
      </label>
      <label className="text-xs font-medium text-slate-400">
        Supplier reference
        <input value={values.supplierReference} onChange={(e) => set("supplierReference", e.target.value)} maxLength={100} className={fieldClass} />
      </label>
      <label className="text-xs font-medium text-slate-400 sm:col-span-3">
        Notes
        <input value={values.notes} onChange={(e) => set("notes", e.target.value)} maxLength={2000} className={fieldClass} />
      </label>
      {error && <p role="alert" className="text-sm text-red-400 sm:col-span-3">{error}</p>}
      <div className="sm:col-span-3">
        <button type="submit" disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">{busy ? "Saving…" : "Save order details"}</button>
      </div>
    </form>
  );
}
