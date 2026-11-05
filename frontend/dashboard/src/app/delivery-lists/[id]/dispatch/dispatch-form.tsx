"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import CameraScanner from "@/app/scan/camera-scanner";
import { DISPATCH_NOTICE, DISPATCH_STATUS_LABELS, DISPATCH_STATUS_STYLE, api, jsonBody, qty } from "@/lib/sales-browser";
import { exceeds } from "@/lib/sales-browser";
import { lookupOnServer, normalizeScanned } from "@/lib/scan";
import { newIdempotencyKey, validateQuantity, type StockProduct, type Warehouse } from "@/lib/stock-validation";
import type { DeliveryItem, DeliveryListDetail, DispatchDetail } from "@/lib/sales";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const cellInput = "w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right font-mono text-sm text-white outline-none focus:border-indigo-500";

type Row = { key: number; warehouseId: string; quantity: string };
type Stage = "edit" | "review" | "pending" | "done";

const remainingOf = (item: DeliveryItem) => item.remaining_quantity ?? item.quantity;
const today = () => new Date().toISOString().slice(0, 10);

/** Prepare a dispatch against a delivery list: choose products, quantities and warehouses, review the available stock, then explicitly
 *  confirm. Nothing here changes stock until "Confirm and deduct from stock". Quantities are never filled in or incremented automatically. */
export default function DispatchForm({
  list, warehouses, stock, draft,
}: { list: DeliveryListDetail; warehouses: Warehouse[]; stock: Record<string, StockProduct>; draft: DispatchDetail | null }) {
  const router = useRouter();
  const keyRef = useRef(newIdempotencyKey()); // one key per page: a double click or a retry returns the same draft
  const nextKey = useRef(1);
  const blocks = useRef<Record<string, HTMLElement | null>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [dispatch, setDispatch] = useState<DispatchDetail | null>(draft);
  const [stage, setStage] = useState<Stage>("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [header, setHeader] = useState({
    dispatchDate: draft?.dispatch_date ?? today(), deliveryAddress: draft?.delivery_address ?? "", transportDetails: draft?.transport_details ?? "",
    trackingReference: draft?.tracking_reference ?? "", notes: draft?.notes ?? "",
  });
  const savedHeader = useRef(header);
  const [camera, setCamera] = useState(false);
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const items = list.items;
  const [rows, setRows] = useState<Record<string, Row[]>>(() => {
    const initial: Record<string, Row[]> = {};
    for (const item of items) {
      const saved = (draft?.lines ?? []).filter((l) => l.delivery_list_item_id === item.id);
      initial[item.id] = saved.map((l) => ({ key: nextKey.current++, warehouseId: l.warehouse_id, quantity: qty(l.quantity).replace(/,/g, "") }));
    }
    return initial;
  });

  const heldIn = (item: DeliveryItem, warehouseId: string): string | null => {
    const line = stock[item.product_id]?.lines.find((l) => l.warehouse_id === warehouseId);
    return stock[item.product_id] ? (line ? line.quantity : "0") : null;
  };

  function setRow(itemId: string, key: number, patch: Partial<Row>) {
    setRows((current) => ({ ...current, [itemId]: current[itemId].map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
    setRowErrors((current) => ({ ...current, [itemId]: "" }));
  }
  const addRow = (itemId: string) => {
    const used = new Set(rows[itemId].map((r) => r.warehouseId));
    const free = warehouses.find((w) => !used.has(w.id));
    if (!free) return;
    setRows((current) => ({ ...current, [itemId]: [...current[itemId], { key: nextKey.current++, warehouseId: free.id, quantity: "" }] }));
  };
  const removeRow = (itemId: string, key: number) => setRows((current) => ({ ...current, [itemId]: current[itemId].filter((r) => r.key !== key) }));
  // Choosing a product to dispatch opens ONE row for it, with an empty quantity: the administrator types the quantity.
  const startItem = (item: DeliveryItem) => {
    if (rows[item.id].length > 0) return;
    const planned = warehouses.find((w) => w.id === item.planned_warehouse_id);
    const first = planned ?? warehouses.find((w) => exceeds(heldIn(item, w.id) ?? "0", "0")) ?? warehouses[0];
    if (first) setRows((current) => ({ ...current, [item.id]: [{ key: nextKey.current++, warehouseId: first.id, quantity: "" }] }));
  };

  // ---- locate a product of this list by SKU / barcode: a lookup only; it never fills in or increases a quantity ------------------------------
  async function locate(raw: string) {
    if (looking || !raw.trim()) return;
    setError(null);
    setNotice(null);
    setHighlight(null);
    const normalized = normalizeScanned(raw);
    if (!normalized.ok) return setError(normalized.message);
    setLooking(true);
    const result = await lookupOnServer(normalized.code);
    setLooking(false);
    if (result.kind === "unauthorized") return router.replace("/login");
    if (result.kind !== "found") return setError(result.message);
    const found = result.result.product;
    const item = items.find((i) => i.product_id === found.id);
    if (!item) return setError(`${found.name} (${found.sku}) is not on ${list.number}, so it cannot be dispatched against this list.`);
    if (!exceeds(remainingOf(item), "0")) return setError(`${found.name} is already fully dispatched on ${list.number}.`);
    startItem(item);
    setHighlight(item.id);
    setNotice(`${found.name} (${found.sku}) located. Enter the quantity to dispatch and choose the warehouse.`);
    setCode("");
    blocks.current[item.id]?.scrollIntoView?.({ block: "center" });
    window.setTimeout(() => inputs.current[item.id]?.focus(), 0);
  }
  function onLocate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void locate(code);
  }

  // ---- checking what was typed, exactly -------------------------------------------------------------------------------------------------------------
  function validate(): boolean {
    const errors: Record<string, string> = {};
    let any = false;
    for (const item of items) {
      const entries = rows[item.id].filter((r) => r.quantity.trim() !== "");
      if (entries.length === 0) continue;
      any = true;
      let total = "0";
      const seen = new Set<string>();
      for (const r of entries) {
        const problem = validateQuantity(r.quantity.trim(), true, item.unit);
        if (problem) { errors[item.id] = problem; break; }
        if (!r.warehouseId) { errors[item.id] = `Choose the warehouse the ${item.product_name} leaves from.`; break; }
        if (seen.has(r.warehouseId)) { errors[item.id] = `${item.product_name} appears twice for the same warehouse.`; break; }
        seen.add(r.warehouseId);
        total = addDecimal(total, r.quantity.trim());
      }
      if (!errors[item.id] && exceeds(total, remainingOf(item))) {
        errors[item.id] = `Only ${qty(remainingOf(item))} ${item.unit} of ${item.product_name} can still be dispatched.`;
      }
    }
    setRowErrors(errors);
    if (!any && Object.keys(errors).length === 0) setError("Enter the quantity to dispatch for at least one product.");
    return any && Object.keys(errors).length === 0;
  }

  const body = () => ({
    lines: items.flatMap((item) =>
      rows[item.id].filter((r) => r.quantity.trim() !== "").map((r) => ({ deliveryListItemId: item.id, warehouseId: r.warehouseId, quantity: r.quantity.trim() }))
    ),
  });

  // ---- save the draft (changes NO stock) and go to the review ----------------------------------------------------------------------------------
  async function review() {
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!validate()) return;
    setBusy(true);
    let saved: DispatchDetail;
    if (!dispatch) {
      const r = await api("/api/sales/dispatches", {
        method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ deliveryListId: list.id, ...header, ...body() }),
      });
      if (r.status === 401) { setBusy(false); return router.replace("/login"); }
      if (!r.ok) { setBusy(false); return setError(r.error); }
      saved = r.data.dispatch;
    } else {
      if (JSON.stringify(header) !== JSON.stringify(savedHeader.current)) {
        const h = await api(`/api/sales/dispatches/${dispatch.id}`, { method: "PATCH", ...jsonBody(header) });
        if (h.status === 401) { setBusy(false); return router.replace("/login"); }
        if (!h.ok) { setBusy(false); return setError(h.error); }
      }
      const r = await api(`/api/sales/dispatches/${dispatch.id}/lines`, { method: "PUT", ...jsonBody(body()) });
      if (r.status === 401) { setBusy(false); return router.replace("/login"); }
      if (!r.ok) { setBusy(false); return setError(r.error); }
      saved = r.data.dispatch;
    }
    savedHeader.current = header;
    setBusy(false);
    setDispatch(saved);
    setStage("review");
  }

  // ---- the explicit confirmation: the only step that deducts stock ----------------------------------------------------------------------------
  async function confirm() {
    if (busy || !dispatch) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/sales/dispatches/${dispatch.id}/confirm`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setError(r.error);
      if (r.code === "inventory_rejected" || r.code === "insufficient_stock") setStage("edit"); // nothing was deducted: back to the draft
      return;
    }
    setDispatch(r.data.dispatch);
    setStage(r.data.confirmed ? "done" : "pending");
  }

  async function discard() {
    if (busy || !dispatch) return;
    setBusy(true);
    const r = await api(`/api/sales/dispatches/${dispatch.id}/cancel`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    router.push(`/delivery-lists/${list.id}`);
  }

  if (stage === "done" && dispatch) {
    return (
      <section role="status" className="space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
        <h3 className="text-lg font-semibold text-emerald-300">{dispatch.number} confirmed</h3>
        <p className="text-sm text-emerald-200">The dispatched quantities were deducted from your stock. Each one is a movement in the stock history.</p>
        <ReviewTable dispatch={dispatch} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/dispatches/${dispatch.id}`} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">View the dispatch</Link>
          <Link href={`/delivery-lists/${list.id}`} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Back to {list.number}</Link>
        </div>
      </section>
    );
  }

  if (stage === "pending" && dispatch) {
    return (
      <section role="alert" className="space-y-4 rounded-xl border border-sky-500/30 bg-sky-500/10 p-5">
        <h3 className="text-lg font-semibold text-sky-200">{dispatch.number} is being deducted from stock</h3>
        <p className="text-sm text-sky-100">
          The inventory service has not confirmed the posting yet{dispatch.posting.last_error ? ` (${dispatch.posting.last_error})` : ""}. Nothing is lost and nothing will be deducted twice:
          the dispatch is saved and its quantities are reserved. Try again in a moment; you can also come back to it later from Dispatches.
        </p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={confirm} disabled={busy} className="min-h-10 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60">{busy ? "Checking…" : "Retry posting"}</button>
          <Link href={`/dispatches/${dispatch.id}`} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Open the dispatch</Link>
        </div>
      </section>
    );
  }

  if (stage === "review" && dispatch) {
    const short = dispatch.lines_exceeding_stock > 0;
    return (
      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Review the dispatch">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold text-white">Review {dispatch.number}</h3>
          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${DISPATCH_STATUS_STYLE[dispatch.status]}`}>{DISPATCH_STATUS_LABELS[dispatch.status]}</span>
        </div>
        <p className="text-xs text-slate-400">
          Dispatch date {dispatch.dispatch_date} · for {list.client.name} · against {list.number}
          {dispatch.tracking_reference ? ` · tracking ${dispatch.tracking_reference}` : ""}
        </p>
        <ReviewTable dispatch={dispatch} showStock />
        {dispatch.stock_status === "unavailable" && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Current stock could not be read right now. You can still confirm: the inventory service checks it again and refuses if it is not enough.</p>}
        {short && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{dispatch.lines_exceeding_stock} {dispatch.lines_exceeding_stock === 1 ? "line asks" : "lines ask"} for more than the warehouse holds right now. Go back and reduce the quantity or choose another warehouse. Stock never goes below zero.</p>}
        <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          Nothing has been deducted from your stock yet. Confirming removes the quantities above from the chosen warehouses. A confirmed dispatch cannot be changed afterwards.
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => { setStage("edit"); setError(null); }} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60">Back to edit</button>
          <button type="button" onClick={discard} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-red-300 hover:bg-slate-800 disabled:opacity-60">Discard draft</button>
          <button type="button" onClick={confirm} disabled={busy || short} className="min-h-10 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60">{busy ? "Deducting from stock…" : "Confirm and deduct from stock"}</button>
        </div>
      </section>
    );
  }

  const dispatchable = items.filter((i) => exceeds(remainingOf(i), "0") || rows[i.id].length > 0);
  return (
    <div className="space-y-5">
      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{DISPATCH_NOTICE}</p>
      {dispatch && <p role="status" className="text-xs text-slate-400">Editing the draft {dispatch.number}.</p>}

      <section className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-2 sm:p-5" aria-label="Dispatch details">
        <label className="text-xs font-medium text-slate-400">
          Dispatch date
          <input type="date" value={header.dispatchDate} max={today()} onChange={(e) => setHeader({ ...header, dispatchDate: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Tracking / reference number
          <input value={header.trackingReference} maxLength={100} onChange={(e) => setHeader({ ...header, trackingReference: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Delivery address
          <input value={header.deliveryAddress} maxLength={1000} onChange={(e) => setHeader({ ...header, deliveryAddress: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Transport details (carrier, vehicle, driver)
          <input value={header.transportDetails} maxLength={500} onChange={(e) => setHeader({ ...header, transportDetails: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400 sm:col-span-2">
          Notes
          <input value={header.notes} maxLength={2000} onChange={(e) => setHeader({ ...header, notes: e.target.value })} className={fieldClass} />
        </label>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Find a product on this list">
        <form onSubmit={onLocate} role="search" aria-label="Find a product on this list" className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-medium text-slate-400">
            Find a product on this list (SKU or barcode)
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={200} placeholder="Type, or scan into this box" className={`${fieldClass} font-mono`} />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={looking || !code.trim()} className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 sm:flex-none">{looking ? "Looking…" : "Find product"}</button>
            <button type="button" onClick={() => setCamera((on) => !on)} aria-expanded={camera} className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 sm:flex-none">{camera ? "Hide camera" : "Use camera"}</button>
          </div>
        </form>
        {camera && <CameraScanner onDetected={(text) => { setCamera(false); void locate(text); }} onClose={() => setCamera(false)} />}
        {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      </section>

      <div className="space-y-4">
        {dispatchable.map((item) => {
          const remaining = remainingOf(item);
          const open = rows[item.id].length > 0;
          const canSplit = rows[item.id].length < warehouses.length;
          return (
            <section
              key={item.id}
              ref={(el) => { blocks.current[item.id] = el; }}
              data-testid={`item-${item.product_sku}`}
              aria-label={item.product_name}
              className={`space-y-3 rounded-xl border p-4 sm:p-5 ${highlight === item.id ? "border-indigo-500/60 bg-indigo-500/10" : "border-slate-800 bg-slate-900/30"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="font-medium text-white">{item.product_name}</h4>
                  <p className="font-mono text-xs text-indigo-300">{item.product_sku}</p>
                </div>
                <dl className="grid grid-cols-4 gap-3 text-right text-xs">
                  <div><dt className="text-slate-400">Requested</dt><dd className="font-mono text-sm text-white">{qty(item.quantity)} {item.unit}</dd></div>
                  <div><dt className="text-slate-400">Dispatched</dt><dd className="font-mono text-sm text-white">{qty(item.dispatched_quantity ?? "0")}</dd></div>
                  <div><dt className="text-slate-400">In progress</dt><dd className="font-mono text-sm text-white">{qty(item.pending_quantity ?? "0")}</dd></div>
                  <div><dt className="text-slate-400">Remaining</dt><dd className="font-mono text-sm font-semibold text-emerald-400">{qty(remaining)}</dd></div>
                </dl>
              </div>
              {rowErrors[item.id] && <p role="alert" className="text-sm text-red-400">{rowErrors[item.id]}</p>}
              {!open ? (
                <button type="button" onClick={() => startItem(item)} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Dispatch {item.product_name}</button>
              ) : (
                <div className="space-y-2">
                  {rows[item.id].map((r, index) => {
                    const held = heldIn(item, r.warehouseId);
                    const tooMuch = held !== null && r.quantity.trim() !== "" && !validateQuantity(r.quantity.trim(), true) && exceeds(r.quantity.trim(), held);
                    return (
                      <div key={r.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_9rem_auto]">
                        <label className="text-xs font-medium text-slate-400">
                          Leaves from
                          <select aria-label={`Warehouse for ${item.product_name}${rows[item.id].length > 1 ? ` (${index + 1})` : ""}`} value={r.warehouseId} onChange={(e) => setRow(item.id, r.key, { warehouseId: e.target.value })}
                            className="mt-1.5 block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-white outline-none focus:border-indigo-500">
                            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}{heldIn(item, w.id) !== null ? ` (${qty(heldIn(item, w.id)!)} in stock)` : ""}</option>)}
                          </select>
                        </label>
                        <label className="text-xs font-medium text-slate-400">
                          Quantity to dispatch
                          <input aria-label={`Quantity to dispatch of ${item.product_name}${rows[item.id].length > 1 ? ` (${index + 1})` : ""}`} ref={index === 0 ? (el) => { inputs.current[item.id] = el; } : undefined}
                            value={r.quantity} inputMode="decimal" onChange={(e) => setRow(item.id, r.key, { quantity: e.target.value })} className={`mt-1.5 ${cellInput}`} placeholder="0" />
                        </label>
                        <button type="button" onClick={() => removeRow(item.id, r.key)} aria-label={`Remove ${item.product_name} from ${warehouses.find((w) => w.id === r.warehouseId)?.code ?? "this warehouse"}`}
                          className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">Remove</button>
                        {tooMuch && <p role="status" className="text-xs text-amber-300 sm:col-span-3">That is more than the {qty(held!)} {item.unit} in this warehouse right now. You can save the draft, but it cannot be confirmed until the stock is there.</p>}
                      </div>
                    );
                  })}
                  {canSplit && <button type="button" onClick={() => addRow(item.id)} className="text-xs font-medium text-indigo-300 hover:text-indigo-200">+ Dispatch part of it from another warehouse</button>}
                </div>
              )}
            </section>
          );
        })}
        {dispatchable.length === 0 && <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">Everything on this list has been dispatched.</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/delivery-lists/${list.id}`} className="text-sm text-indigo-300 hover:text-indigo-200">← Back to {list.number}</Link>
        <button type="button" onClick={review} disabled={busy || warehouses.length === 0} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Saving the draft…" : "Review dispatch"}</button>
      </div>
    </div>
  );
}

function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const total = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  const digits = total.toString().padStart(scale + 1, "0");
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function ReviewTable({ dispatch, showStock = false }: { dispatch: DispatchDetail; showStock?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-slate-300">
        <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
          <tr>
            <th className="px-3 py-2 font-semibold">Product</th><th className="px-3 py-2 font-semibold">Warehouse</th>
            <th className="px-3 py-2 font-semibold text-right">Dispatching</th>{showStock && <th className="px-3 py-2 font-semibold text-right">In stock now</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {dispatch.lines.map((l) => {
            const short = showStock && l.available_in_warehouse !== null && exceeds(l.quantity, l.available_in_warehouse);
            return (
              <tr key={l.id}>
                <td className="px-3 py-2"><span className="font-medium text-white">{l.product_name}</span> <span className="font-mono text-xs text-indigo-300">{l.product_sku}</span></td>
                <td className="px-3 py-2">{l.warehouse_code ?? <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2 text-right font-mono text-white">{qty(l.quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
                {showStock && (
                  <td className={`px-3 py-2 text-right font-mono ${short ? "text-red-300" : "text-emerald-400"}`}>
                    {l.available_in_warehouse === null ? <span className="text-slate-600">—</span> : <>{qty(l.available_in_warehouse)} {l.unit}{short && <span className="block text-[11px]">not enough</span>}</>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
