"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import CameraScanner from "@/app/scan/camera-scanner";
import { DISPATCH_NOTICE, DISPATCH_STATUS_LABELS, DISPATCH_STATUS_STYLE, api, jsonBody, qty } from "@/lib/sales-browser";
import { exceeds } from "@/lib/sales-browser";
import { lookupOnServer, normalizeScanned } from "@/lib/scan";
import { newIdempotencyKey, validateQuantity, type StockProduct } from "@/lib/stock-validation";
import type { DeliveryItem, DeliveryListDetail, DispatchDetail } from "@/lib/sales";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const cellInput = "w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right font-mono text-sm text-white outline-none focus:border-indigo-500";

type Stage = "edit" | "review" | "pending" | "done";

const remainingOf = (item: DeliveryItem) => item.remaining_quantity ?? item.quantity;
const today = () => new Date().toISOString().slice(0, 10);

/** Prepare a dispatch against a delivery list: choose products and quantities, review the stock on hand, then explicitly
 *  confirm. Nothing here changes stock until "Confirm and deduct from stock". Quantities are never filled in or incremented automatically. */
export default function DispatchForm({
  list, stock, draft,
}: { list: DeliveryListDetail; stock: Record<string, StockProduct>; draft: DispatchDetail | null }) {
  const router = useRouter();
  const keyRef = useRef(newIdempotencyKey()); // one key per page: a double click or a retry returns the same draft
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
  // The quantity typed for each product of the list; null = this product is not being dispatched (yet).
  const [quantities, setQuantities] = useState<Record<string, string | null>>(() => {
    const initial: Record<string, string | null> = {};
    for (const item of items) {
      const saved = (draft?.lines ?? []).find((l) => l.delivery_list_item_id === item.id);
      initial[item.id] = saved ? qty(saved.quantity).replace(/,/g, "") : null;
    }
    return initial;
  });

  const inStock = (item: DeliveryItem): string | null => (stock[item.product_id] ? stock[item.product_id].total_quantity : null);

  function setQuantity(itemId: string, value: string) {
    setQuantities((current) => ({ ...current, [itemId]: value }));
    setRowErrors((current) => ({ ...current, [itemId]: "" }));
  }
  const stopItem = (itemId: string) => setQuantities((current) => ({ ...current, [itemId]: null }));
  // Choosing a product to dispatch opens it with an EMPTY quantity: the administrator types the quantity.
  const startItem = (item: DeliveryItem) => setQuantities((current) => (current[item.id] === null ? { ...current, [item.id]: "" } : current));

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
    setNotice(`${found.name} (${found.sku}) located. Enter the quantity to dispatch.`);
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
      const typed = (quantities[item.id] ?? "").trim();
      if (typed === "") continue;
      any = true;
      const problem = validateQuantity(typed, true, item.unit);
      if (problem) { errors[item.id] = problem; continue; }
      if (exceeds(typed, remainingOf(item))) {
        errors[item.id] = `Only ${qty(remainingOf(item))} ${item.unit} of ${item.product_name} can still be dispatched.`;
      }
    }
    setRowErrors(errors);
    if (!any && Object.keys(errors).length === 0) setError("Enter the quantity to dispatch for at least one product.");
    return any && Object.keys(errors).length === 0;
  }

  const body = () => ({
    lines: items.flatMap((item) => ((quantities[item.id] ?? "").trim() !== "" ? [{ deliveryListItemId: item.id, quantity: (quantities[item.id] ?? "").trim() }] : [])),
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
        {short && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{dispatch.lines_exceeding_stock} {dispatch.lines_exceeding_stock === 1 ? "line asks" : "lines ask"} for more than is in stock right now. Go back and reduce the quantity. Stock never goes below zero.</p>}
        <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          Nothing has been deducted from your stock yet. Confirming removes the quantities above from your stock. A confirmed dispatch cannot be changed afterwards.
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

  const dispatchable = items.filter((i) => exceeds(remainingOf(i), "0") || quantities[i.id] !== null);
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
          const typed = quantities[item.id];
          const open = typed !== null;
          const held = inStock(item);
          const tooMuch = open && held !== null && typed.trim() !== "" && !validateQuantity(typed.trim(), true) && exceeds(typed.trim(), held);
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
                <div className="flex flex-wrap items-end gap-3">
                  <label className="w-44 text-xs font-medium text-slate-400">
                    Quantity to dispatch
                    <input aria-label={`Quantity to dispatch of ${item.product_name}`} ref={(el) => { inputs.current[item.id] = el; }}
                      value={typed} inputMode="decimal" onChange={(e) => setQuantity(item.id, e.target.value)} className={`mt-1.5 ${cellInput}`} placeholder="0" />
                  </label>
                  {held !== null && <p className="pb-2.5 text-xs text-slate-400">{qty(held)} {item.unit} in stock</p>}
                  <button type="button" onClick={() => stopItem(item.id)} aria-label={`Remove ${item.product_name} from this dispatch`}
                    className="min-h-10 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">Remove</button>
                  {tooMuch && <p role="status" className="basis-full text-xs text-amber-300">That is more than the {qty(held!)} {item.unit} in stock right now. You can save the draft, but it cannot be confirmed until the stock is there.</p>}
                </div>
              )}
            </section>
          );
        })}
        {dispatchable.length === 0 && <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">Everything on this list has been dispatched.</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/delivery-lists/${list.id}`} className="text-sm text-indigo-300 hover:text-indigo-200">← Back to {list.number}</Link>
        <button type="button" onClick={review} disabled={busy} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Saving the draft…" : "Review dispatch"}</button>
      </div>
    </div>
  );
}

export function ReviewTable({ dispatch, showStock = false }: { dispatch: DispatchDetail; showStock?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-slate-300">
        <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
          <tr>
            <th className="px-3 py-2 font-semibold">Product</th>
            <th className="px-3 py-2 font-semibold text-right">Dispatching</th>{showStock && <th className="px-3 py-2 font-semibold text-right">In stock now</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {dispatch.lines.map((l) => {
            const short = showStock && l.available_quantity !== null && exceeds(l.quantity, l.available_quantity);
            return (
              <tr key={l.id}>
                <td className="px-3 py-2"><span className="font-medium text-white">{l.product_name}</span> <span className="font-mono text-xs text-indigo-300">{l.product_sku}</span></td>
                <td className="px-3 py-2 text-right font-mono text-white">{qty(l.quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
                {showStock && (
                  <td className={`px-3 py-2 text-right font-mono ${short ? "text-red-300" : "text-emerald-400"}`}>
                    {l.available_quantity === null ? <span className="text-slate-600">—</span> : <>{qty(l.available_quantity)} {l.unit}{short && <span className="block text-[11px]">not enough</span>}</>}
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
