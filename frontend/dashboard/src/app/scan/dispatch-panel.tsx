"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { Product } from "@/lib/product-validation";
import { api, exceeds, jsonBody, qty } from "@/lib/sales-browser";
import type { DeliveryListDetail, DeliveryListSummary, DispatchDetail } from "@/lib/sales";
import { newIdempotencyKey, validateQuantity, type StockProduct, type Warehouse } from "@/lib/stock-validation";

type Props = {
  product: Product;
  stock: StockProduct;
  warehouses: Warehouse[]; // the organization's active warehouses
  onAdded: (message: string) => void;
  onClose: () => void;
};

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

// "Prepare Dispatch": a scanned product is located on a Ready delivery list and put on that list's DRAFT dispatch with a typed
// quantity and a warehouse. The Sales Service knows the list; a product that is not on it is refused. Nothing here deducts stock
// (only confirming the dispatch does), and scanning the same code again never raises the quantity: saving SETS the quantity of
// that product in that warehouse to exactly what was typed.
export default function DispatchPanel({ product, stock, warehouses, onAdded, onClose }: Props) {
  const keyRef = useRef(newIdempotencyKey());
  const [lists, setLists] = useState<DeliveryListSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [list, setList] = useState<DeliveryListDetail | null>(null);
  const [draft, setDraft] = useState<DispatchDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [ready, partial] = await Promise.all([
        api<{ items: DeliveryListSummary[] }>("/api/sales/delivery-lists?status=ready&limit=100"),
        api<{ items: DeliveryListSummary[] }>("/api/sales/delivery-lists?status=partially_dispatched&limit=100"),
      ]);
      if (!ready.ok) return setLoadError(ready.error);
      const all = [...(ready.data?.items ?? []), ...(partial.ok ? partial.data?.items ?? [] : [])];
      setLists(all);
      if (all.length === 1) setChoice(all[0].id);
    })();
  }, []);

  useEffect(() => {
    setList(null);
    setDraft(null);
    setProblem(null);
    setError(null);
    if (!choice) return;
    let cancelled = false;
    void (async () => {
      setLoadingList(true);
      const r = await api<{ list: DeliveryListDetail }>(`/api/sales/delivery-lists/${choice}`);
      if (cancelled) return;
      setLoadingList(false);
      if (!r.ok || !r.data) return setProblem(r.error);
      const found = r.data.list;
      if (!found.items.some((i) => i.product_id === product.id)) {
        return setProblem(`${product.name} (${product.sku}) is not on ${found.number}, so it cannot be prepared for dispatch against this list.`);
      }
      setList(found);
      // the open DRAFT dispatch of this list, if any (its lines are kept; only this product / warehouse is set)
      const drafts = await api<{ items: { id: string }[] }>(`/api/sales/dispatches?deliveryListId=${found.id}&status=draft&limit=1`);
      if (cancelled || !drafts.ok || !drafts.data?.items?.[0]) return;
      const detail = await api<{ dispatch: DispatchDetail }>(`/api/sales/dispatches/${drafts.data.items[0].id}`);
      if (!cancelled && detail.ok && detail.data) setDraft(detail.data.dispatch);
    })();
    return () => { cancelled = true; };
  }, [choice, product.id, product.name, product.sku]);

  const item = list?.items.find((i) => i.product_id === product.id) ?? null;
  const heldIn = (id: string) => stock.lines.find((l) => l.warehouse_id === id)?.quantity ?? "0";
  const existing = draft?.lines.find((l) => l.delivery_list_item_id === item?.id && l.warehouse_id === warehouseId) ?? null;
  const remaining = item ? item.remaining_quantity ?? item.quantity : "0";

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !list || !item) return;
    setError(null);
    const q = quantity.trim();
    const bad = validateQuantity(q, true, item.unit);
    if (bad) return setError(bad);
    if (!warehouseId) return setError("Choose the warehouse the goods leave from.");
    // what this draft will carry for the product after saving: its other warehouses + exactly what was typed here
    const others = (draft?.lines ?? []).filter((l) => l.delivery_list_item_id === item.id && l.warehouse_id !== warehouseId);
    let total = q;
    for (const o of others) total = add(total, o.quantity);
    if (exceeds(total, remaining)) return setError(`Only ${qty(remaining)} ${item.unit} of ${product.name} can still be dispatched against ${list.number}.`);
    const lines = [
      ...(draft?.lines ?? []).filter((l) => !(l.delivery_list_item_id === item.id && l.warehouse_id === warehouseId)).map((l) => ({ deliveryListItemId: l.delivery_list_item_id, warehouseId: l.warehouse_id, quantity: l.quantity })),
      { deliveryListItemId: item.id, warehouseId, quantity: q },
    ];
    setBusy(true);
    const r = draft
      ? await api<{ dispatch: DispatchDetail }>(`/api/sales/dispatches/${draft.id}/lines`, { method: "PUT", ...jsonBody({ lines }) })
      : await api<{ dispatch: DispatchDetail }>("/api/sales/dispatches", { method: "POST", headers: { "Idempotency-Key": keyRef.current }, ...jsonBody({ deliveryListId: list.id, lines }) });
    setBusy(false);
    if (!r.ok || !r.data) return setError(r.error);
    setDraft(r.data.dispatch);
    setQuantity("");
    onAdded(`${product.name}: ${qty(q)} ${item.unit} from ${warehouses.find((w) => w.id === warehouseId)?.code ?? "the warehouse"} is on the draft dispatch ${r.data.dispatch.number}. Nothing has been deducted from stock; review and confirm it from Dispatches.`);
  }

  return (
    <section aria-label="Prepare Dispatch" className="space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-white">Prepare Dispatch</h4>
          <p className="text-xs text-slate-400">Put this product on a draft dispatch for a Ready delivery list. It does not deduct any stock until you confirm the dispatch.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {loadError && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{loadError}</p>}
      {!lists && !loadError && <p role="status" className="text-sm text-slate-400">Loading your delivery lists…</p>}
      {lists && lists.length === 0 && (
        <p role="status" className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">
          No delivery list is ready for dispatch. Mark a list Ready in <Link href="/delivery-lists" className="text-indigo-300 hover:text-indigo-200">Delivery Lists</Link> first.
        </p>
      )}

      {lists && lists.length > 0 && (
        <label className="block text-xs font-medium text-slate-400">
          Delivery list
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className={fieldClass}>
            <option value="">Choose a delivery list…</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.number} · {l.client.name}</option>)}
          </select>
        </label>
      )}

      {loadingList && <p role="status" className="text-sm text-slate-400">Loading the list…</p>}
      {problem && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{problem}</p>}

      {list && item && (
        <form onSubmit={save} noValidate aria-label="Dispatch quantity" className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Client requested" value={`${qty(item.quantity)} ${item.unit}`} />
            <Figure label="Already dispatched" value={`${qty(item.dispatched_quantity ?? "0")} ${item.unit}`} />
            <Figure label="Remaining" value={`${qty(remaining)} ${item.unit}`} tone="good" />
            <Figure label="In stock (all warehouses)" value={`${qty(stock.available_quantity)} ${item.unit}`} />
          </dl>
          {draft && <p className="text-xs text-slate-400">Adding to the open draft <Link href={`/dispatches/${draft.id}`} className="font-mono text-indigo-300 hover:text-indigo-200">{draft.number}</Link>.</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-400">
              Dispatching warehouse
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={fieldClass}>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name} ({qty(heldIn(w.id))} {item.unit} in stock)</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-400">
              Quantity to dispatch
              <input value={quantity} onChange={(e) => { setQuantity(e.target.value); setError(null); }} inputMode="decimal" autoComplete="off" placeholder="Type the quantity" className={`${fieldClass} font-mono`} />
            </label>
          </div>
          {existing && (
            <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              This product is already on {draft?.number} from this warehouse with {qty(existing.quantity)} {item.unit}. Saving replaces that quantity with what you type; scanning again never adds to it.
            </p>
          )}
          {quantity.trim() !== "" && !validateQuantity(quantity.trim(), true) && exceeds(quantity.trim(), heldIn(warehouseId)) && (
            <p role="status" className="text-xs text-amber-300">That is more than the {qty(heldIn(warehouseId))} {item.unit} in this warehouse right now. You can save the draft, but it cannot be confirmed until the stock is there.</p>
          )}
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy || warehouses.length === 0} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Saving…" : existing ? "Replace the quantity on the draft" : "Add to the draft dispatch"}</button>
        </form>
      )}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className={`mt-1 font-mono text-sm font-semibold ${tone === "good" ? "text-emerald-400" : "text-white"}`}>{value}</dd>
    </div>
  );
}

function add(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const total = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  const digits = total.toString().padStart(scale + 1, "0");
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
