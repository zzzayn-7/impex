"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import AddItemForm from "@/components/add-item-form";
import { validateQuantity } from "@/lib/stock-validation";
import { ScanProductButton } from "@/components/scan/scan-product-modal";
import { lookupOnServer, normalizeScanned, type ScanResult } from "@/lib/scan";
import { DISPATCH_STATUS_LABELS, DISPATCH_STATUS_STYLE, STATUS_LABELS, STATUS_STYLE, STOCK_NOTICE, api, jsonBody, percent, qty } from "@/lib/sales-browser";
import type { DeliveryItem, DeliveryListDetail as Detail } from "@/lib/sales";
import QuantityInput from "@/components/ui/quantity-input";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

export default function DeliveryListDetail({ list }: { list: Detail }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [scanned, setScanned] = useState<ScanResult | null>(null); // a product identified by the Scan Product dialog, waiting for its quantity

  const draft = list.status === "draft";
  const dispatches = list.dispatches ?? [];
  // Once goods are dispatched (or being dispatched) the list can be neither reopened nor cancelled: that would hide the fulfilment history.
  // An unfinished DRAFT dispatch does not count: reopening or cancelling the list cancels it.
  const hasFulfilment = dispatches.some((d) => d.status === "posting" || d.status === "confirmed");
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

  const changeStatus = async (action: "ready" | "cancel" | "reopen") => {
    const text = action === "ready" ? `${list.number} is marked Ready and its stock is booked. Physical stock is deducted only when a dispatch is confirmed.` : action === "cancel" ? `${list.number} was cancelled. Nothing was deleted and no stock was involved.` : `${list.number} is a draft again.`;
    if (await call(`/api/sales/delivery-lists/${list.id}/${action}`, { method: "POST" }, text)) setConfirmCancel(false);
  };

  async function saveQuantity(item: DeliveryItem) {
    if (!editing) return;
    const found = validateQuantity(editing.value.trim(), item.stock?.unit_allows_fractions ?? false, item.unit);
    if (found) return setEditError(found);
    setEditError(null);
    if (await call(`/api/sales/delivery-lists/${list.id}/items/${item.id}`, { method: "PATCH", ...jsonBody({ quantity: editing.value.trim() }) }, `${item.product_name} is now ${qty(editing.value.trim())} ${item.unit}.`)) setEditing(null);
  }

  async function removeItem(item: DeliveryItem) {
    if (await call(`/api/sales/delivery-lists/${list.id}/items/${item.id}`, { method: "DELETE" }, `${item.product_name} was removed from ${list.number}.`)) setRemoving(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-2xl font-semibold text-white">{list.number}</h2>
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[list.status]}`}>{STATUS_LABELS[list.status]}</span>
          </div>
          <p className="mt-1 text-sm text-slate-300">
            For <Link href={`/delivery-lists?client=${list.client.id}`} className="font-medium text-indigo-300 hover:text-indigo-200">{list.client.name}</Link>
            {!list.client.is_active && <span className="ml-2 rounded-full border border-slate-600/40 bg-slate-700/30 px-2 py-0.5 text-xs text-slate-400">inactive client</span>}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {list.external_reference ? `Reference ${list.external_reference} · ` : ""}Created by {list.created_by_email} · {list.created_at.slice(0, 16).replace("T", " ")} UTC
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="List actions">
          {draft && <button type="button" disabled={busy || list.items.length === 0} onClick={() => changeStatus("ready")} className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">Mark Ready</button>}
          {list.can_dispatch && <Link href={`/delivery-lists/${list.id}/dispatch`} className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Prepare dispatch</Link>}
          {list.status === "ready" && !hasFulfilment && list.booking_state !== "booked" && <button type="button" disabled={busy} onClick={() => changeStatus("reopen")} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">Reopen as draft</button>}
          {(list.status === "draft" || list.status === "ready") && !hasFulfilment && (confirmCancel ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-slate-300">Cancel this list?</span>
              <button type="button" disabled={busy} onClick={() => changeStatus("cancel")} className="min-h-11 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">Yes, cancel</button>
              <button type="button" onClick={() => setConfirmCancel(false)} className="min-h-11 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">No</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmCancel(true)} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-red-300 hover:bg-slate-800">Cancel list</button>
          ))}
        </div>
      </div>

      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{list.stock_notice || STOCK_NOTICE}</p>

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}
      {list.status === "partially_dispatched" && <p role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">Some of the goods have been dispatched. The list stays open until everything has left. Its products are frozen, and it can no longer be reopened or cancelled.</p>}
      {list.status === "dispatched" && <p role="status" className="rounded-lg border border-teal-500/20 bg-teal-500/10 px-4 py-3 text-xs text-teal-200">Everything on this list has been dispatched. The list is complete and frozen.</p>}
      {list.stock_status === "unavailable" && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Current stock could not be loaded right now, so availability is not shown. The list itself is unaffected.</p>}
      {list.items_exceeding_stock > 0 && (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {list.items_exceeding_stock} {list.items_exceeding_stock === 1 ? "line asks" : "lines ask"} for more than is available right now. This is only a warning: nothing is reserved, and stock may change before dispatch.
        </p>
      )}

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Products on this list">
        <h3 className="text-sm font-semibold text-white">Products ({list.items.length})</h3>
        {list.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">
            No products yet. {draft ? "Scan a product, or look one up below, and add it with the quantity to deliver." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-3 font-semibold">Product</th><th className="px-3 py-3 font-semibold text-right">Quantity</th>
                  <th className="px-3 py-3 font-semibold text-right">In stock now</th>
                  {!draft && <th className="px-3 py-3 font-semibold">Dispatch progress</th>}{draft && <th className="px-3 py-3 font-semibold">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {list.items.map((item) => (
                  <tr key={item.id} className="align-top hover:bg-slate-800/30">
                    <td className="px-3 py-3">
                      <div className="font-medium text-white">{item.product_name}</div>
                      <div className="font-mono text-xs text-indigo-300">{item.product_sku}</div>
                      {item.stock && !item.stock.product_active && <div className="mt-1 text-xs text-amber-300">Archived product: remove it before marking the list Ready.</div>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      {editing?.id === item.id ? (
                        <div className="flex flex-col items-end gap-1">
                          <QuantityInput aria-label={`Quantity of ${item.product_name}`} value={editing.value} onChange={(v) => { setEditing({ id: item.id, value: v }); setEditError(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveQuantity(item); } if (e.key === "Escape") setEditing(null); }}
                            autoFocus className="w-40" />
                          {editError && <span role="alert" className="max-w-[12rem] text-right text-xs text-red-400">{editError}</span>}
                          <span className="flex gap-1">
                            <button type="button" disabled={busy} onClick={() => saveQuantity(item)} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">Save</button>
                            <button type="button" onClick={() => { setEditing(null); setEditError(null); }} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                          </span>
                        </div>
                      ) : (
                        <span className="text-base font-semibold text-white">{qty(item.quantity)} <span className="text-xs font-normal text-slate-400">{item.unit}</span></span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs">
                      {item.stock ? (
                        <span className={item.stock.exceeds_available ? "text-amber-300" : "text-emerald-400"}>
                          {qty(item.stock.available_quantity ?? item.stock.total_quantity)} {item.unit} available
                          <span className="block text-[11px] text-slate-400">{qty(item.stock.total_quantity)} on hand · {qty(item.stock.reserved_quantity ?? "0")} reserved</span>
                          {item.stock.exceeds_available && <span className="block text-[11px]">short by {qty(item.stock.shortfall)}</span>}
                        </span>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                    {!draft && (
                      <td className="px-3 py-3 text-xs" data-testid={`progress-${item.product_sku}`}>
                        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label={`Dispatched ${item.product_name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(item.dispatched_quantity ?? "0", item.quantity)}>
                          <div className="h-full bg-emerald-500" style={{ width: `${percent(item.dispatched_quantity ?? "0", item.quantity)}%` }} />
                        </div>
                        <div className="mt-1 font-mono text-slate-300">{qty(item.dispatched_quantity ?? "0")} of {qty(item.quantity)} {item.unit} dispatched</div>
                        <div className="font-mono text-slate-500">
                          {item.pending_quantity && /[1-9]/.test(item.pending_quantity) ? <span className="text-sky-300">{qty(item.pending_quantity)} in progress · </span> : null}
                          {qty(item.remaining_quantity ?? item.quantity)} remaining
                        </div>
                      </td>
                    )}
                    {draft && (
                      <td className="px-3 py-3">
                        {removing === item.id ? (
                          <span className="flex items-center gap-2">
                            <span className="text-xs text-slate-300">Remove?</span>
                            <button type="button" disabled={busy} onClick={() => removeItem(item)} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">Yes</button>
                            <button type="button" onClick={() => setRemoving(null)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">No</button>
                          </span>
                        ) : (
                          <span className="flex gap-1.5">
                            <button type="button" onClick={() => { setEditing({ id: item.id, value: qty(item.quantity).replace(/,/g, "") }); setEditError(null); }} aria-label={`Edit quantity of ${item.product_name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">Edit</button>
                            <button type="button" onClick={() => setRemoving(item.id)} aria-label={`Remove ${item.product_name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-slate-800">Remove</button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!draft && list.status !== "cancelled" && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Dispatches">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Dispatches ({dispatches.length})</h3>
            {list.can_dispatch && <Link href={`/delivery-lists/${list.id}/dispatch`} className="text-sm font-medium text-indigo-300 hover:text-indigo-200">Prepare dispatch →</Link>}
          </div>
          {dispatches.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">Nothing has been dispatched against this list yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                  <tr><th className="px-3 py-2 font-semibold">Dispatch</th><th className="px-3 py-2 font-semibold">Date</th><th className="px-3 py-2 font-semibold text-right">Lines</th><th className="px-3 py-2 font-semibold">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {dispatches.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-800/30">
                      <td className="px-3 py-2"><Link href={`/dispatches/${d.id}`} className="font-mono font-semibold text-indigo-300 hover:text-indigo-200">{d.number}</Link>{d.tracking_reference && <span className="ml-2 text-xs text-slate-500">{d.tracking_reference}</span>}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{d.dispatch_date}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{d.line_count}</td>
                      <td className="px-3 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${DISPATCH_STATUS_STYLE[d.status]}`}>{DISPATCH_STATUS_LABELS[d.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {draft ? (
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Add a product">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">Add a product</h3>
            <div className="flex gap-2">
              <ScanProductButton onFound={(r) => { setAdding(false); setScanned(r); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500" />
              <button type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">{adding ? "Close" : "Type a SKU or barcode"}</button>
            </div>
          </div>
          {scanned && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                <span>Scanned: <strong className="font-semibold text-white">{scanned.product.name}</strong> <span className="font-mono text-indigo-300">{scanned.product.sku}</span></span>
                <button type="button" onClick={() => setScanned(null)} className="text-slate-400 underline-offset-2 hover:text-white hover:underline">Clear</button>
              </div>
              <AddItemForm
                key={scanned.product.id}
                listId={list.id}
                listNumber={list.number}
                product={scanned.product}
                stock={scanned.stock}
                onChanged={({ message }) => { setScanned(null); setMessage({ ok: true, text: message }); refresh(); }}
              />
            </div>
          )}
          {adding && <ManualAdd list={list} onChanged={(text) => { setMessage({ ok: true, text }); refresh(); }} />}
          <ListNotes list={list} onSaved={(text) => { setMessage({ ok: true, text }); refresh(); }} />
        </section>
      ) : (
        list.status === "ready" && (hasFulfilment
          ? <p className="text-xs text-slate-500">This list has dispatches, so its products are frozen.</p>
          : list.booking_state === "booked"
            ? <p className="text-xs text-slate-500">This list belongs to sales order {list.order_number} and its stock is reserved. Change its products with Edit on the Delivery Lists page.</p>
            : <p className="text-xs text-slate-500">This list is Ready. Reopen it as a draft to change its products.</p>)
      )}
    </div>
  );
}

// Look a product up by SKU / barcode (a hardware scanner "types" into the same box) and add it with a typed quantity.
function ManualAdd({ list, onChanged }: { list: Detail; onChanged: (message: string) => void }) {
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (looking || !code.trim()) return;
    setError(null);
    setFound(null);
    // Same rules as the scanner box: scanner suffixes are stripped, and a web link or malformed text is refused here.
    const normalized = normalizeScanned(code);
    if (!normalized.ok) return setError(normalized.message);
    setLooking(true);
    const result = await lookupOnServer(normalized.code);
    setLooking(false);
    if (result.kind === "found") setFound(result.result);
    else setError(result.message);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={find} role="search" aria-label="Find a product" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-medium text-slate-400">
          SKU or barcode
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={200} placeholder="Type, or scan into this box"
            className={`${fieldClass} font-mono`} />
        </label>
        <button type="submit" disabled={looking || !code.trim()} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">{looking ? "Looking…" : "Find product"}</button>
      </form>
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      {found && !found.product.is_active && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{found.product.name} is archived and cannot be added. Restore it in Products first.</p>}
      {found && found.product.is_active && (
        <AddItemForm
          key={found.product.id}
          listId={list.id}
          listNumber={list.number}
          product={found.product}
          stock={found.stock}
          onChanged={({ message }) => { setFound(null); setCode(""); onChanged(message); }}
        />
      )}
    </div>
  );
}

function ListNotes({ list, onSaved }: { list: Detail; onSaved: (message: string) => void }) {
  const [reference, setReference] = useState(list.external_reference ?? "");
  const [notes, setNotes] = useState(list.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = reference !== (list.external_reference ?? "") || notes !== (list.notes ?? "");

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/sales/delivery-lists/${list.id}`, { method: "PATCH", ...jsonBody({ externalReference: reference, notes }) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSaved("Reference and notes saved.");
  }

  return (
    <form onSubmit={save} noValidate aria-label="Reference and notes" className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2">
      <label className="text-xs font-medium text-slate-400">
        Your order reference
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={fieldClass} />
      </label>
      <label className="text-xs font-medium text-slate-400">
        Delivery notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={fieldClass} />
      </label>
      {error && <p role="alert" className="text-sm text-red-400 sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy || !dirty} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50">{busy ? "Saving…" : "Save reference & notes"}</button>
      </div>
    </form>
  );
}
