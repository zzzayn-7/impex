"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import CameraScanner from "@/app/scan/camera-scanner";
import { RECEIPT_NOTICE, RECEIPT_STATUS_LABELS, RECEIPT_STATUS_STYLE, validateReceivedQuantity } from "@/lib/purchasing-browser";
import { api, exceeds, jsonBody, qty } from "@/lib/sales-browser";
import { lookupOnServer, normalizeScanned } from "@/lib/scan";
import { newIdempotencyKey, type Warehouse } from "@/lib/stock-validation";
import type { OrderLine, PurchaseOrderDetail, ReceiptDetail } from "@/lib/purchasing";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const cellInput = "w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right font-mono text-sm text-white outline-none focus:border-indigo-500 disabled:opacity-40";

type Row = { accepted: string; rejected: string; warehouseId: string; notes: string };
type Stage = "edit" | "review" | "pending" | "done";

const remainingOf = (line: OrderLine) => line.remaining_quantity ?? line.quantity;
const today = () => new Date().toISOString().slice(0, 10);

/** Receive goods against a purchase order: prepare, review, then explicitly confirm. Nothing here changes stock until "Confirm". */
export default function ReceiveForm({ order, warehouses, draft }: { order: PurchaseOrderDetail; warehouses: Warehouse[]; draft: ReceiptDetail | null }) {
  const router = useRouter();
  const keyRef = useRef(newIdempotencyKey()); // one key per page: a double click or a retry returns the same draft
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(draft);
  const [stage, setStage] = useState<Stage>("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [header, setHeader] = useState({ receivedDate: draft?.received_date ?? today(), supplierReference: draft?.supplier_reference ?? "", notes: draft?.notes ?? "" });
  const savedHeader = useRef(header);

  const lines = order.lines;
  const defaultWarehouse = (line: OrderLine) => {
    const planned = warehouses.find((w) => w.id === line.planned_warehouse_id);
    return (planned ?? warehouses[0])?.id ?? "";
  };
  const [rows, setRows] = useState<Record<string, Row>>(() => {
    const initial: Record<string, Row> = {};
    for (const line of lines) {
      const saved = draft?.lines.find((l) => l.purchase_order_line_id === line.id);
      initial[line.id] = {
        accepted: saved ? qty(saved.accepted_quantity).replace(/,/g, "") : "",
        rejected: saved && saved.rejected_quantity !== "0.0000" ? qty(saved.rejected_quantity).replace(/,/g, "") : "",
        warehouseId: saved?.warehouse_id ?? defaultWarehouse(line),
        notes: saved?.notes ?? "",
      };
    }
    return initial;
  });
  const [code, setCode] = useState("");
  const [looking, setLooking] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);

  const set = (lineId: string, patch: Partial<Row>) => {
    setRows((current) => ({ ...current, [lineId]: { ...current[lineId], ...patch } }));
    setRowErrors((current) => ({ ...current, [lineId]: "" }));
  };

  // ---- locate a product by SKU / barcode: it must be ON this order -----------------------------------------------------------------
  // The typed text, a USB / Bluetooth scanner (which "types" into the box) and the phone camera all end up here. It only LOOKS the
  // product up and moves to its row: it never fills in or increases a quantity.
  function onLocate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void locateCode(code);
  }

  async function locateCode(raw: string) {
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
    const line = lines.find((l) => l.product_id === found.id);
    if (!line) return setError(`${found.name} (${found.sku}) is not on ${order.number}, so it cannot be received against this order.`);
    if (exceeds("0.0001", remainingOf(line))) return setError(`${found.name} is already fully received on ${order.number}.`);
    setHighlight(line.id);
    setNotice(`${found.name} (${found.sku}) located. Enter the quantity that arrived.`);
    setCode("");
    inputs.current[line.id]?.focus();
  }

  // ---- checking what was typed, exactly ---------------------------------------------------------------------------------------------
  function validate(): boolean {
    const errors: Record<string, string> = {};
    let any = false;
    for (const line of lines) {
      const row = rows[line.id];
      const accepted = row.accepted.trim(), rejected = row.rejected.trim();
      const problem = validateReceivedQuantity(accepted, "accepted") ?? validateReceivedQuantity(rejected, "rejected");
      if (problem) { errors[line.id] = problem; continue; }
      const acceptedPositive = accepted !== "" && /[1-9]/.test(accepted), rejectedPositive = rejected !== "" && /[1-9]/.test(rejected);
      if (!acceptedPositive && !rejectedPositive) continue;
      any = true;
      if (acceptedPositive && !row.warehouseId) errors[line.id] = `Choose the warehouse that receives ${line.product_name}.`;
      else if (acceptedPositive && exceeds(accepted, remainingOf(line))) {
        errors[line.id] = `Only ${qty(remainingOf(line))} ${line.unit} of ${line.product_name} can still be received.`;
      }
    }
    setRowErrors(errors);
    if (!any && Object.keys(errors).length === 0) setError("Enter the quantity that arrived for at least one product.");
    return any && Object.keys(errors).length === 0;
  }

  const body = () => ({
    lines: lines
      .map((line) => ({ line, row: rows[line.id] }))
      .filter(({ row }) => /[1-9]/.test(row.accepted) || /[1-9]/.test(row.rejected))
      .map(({ line, row }) => ({
        purchaseOrderLineId: line.id,
        acceptedQuantity: row.accepted.trim() || "0",
        rejectedQuantity: row.rejected.trim() || "0",
        ...(/[1-9]/.test(row.accepted) ? { warehouseId: row.warehouseId } : {}),
        ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
      })),
  });

  // ---- save the draft (changes NO stock) and go to the review ---------------------------------------------------------------------
  async function review() {
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!validate()) return;
    setBusy(true);
    let saved: ReceiptDetail | null = null;
    if (!receipt) {
      const r = await api("/api/purchasing/goods-receipts", {
        method: "POST", headers: { "Idempotency-Key": keyRef.current },
        ...jsonBody({ purchaseOrderId: order.id, receivedDate: header.receivedDate, supplierReference: header.supplierReference, notes: header.notes, ...body() }),
      });
      if (r.status === 401) { setBusy(false); return router.replace("/login"); }
      if (!r.ok) { setBusy(false); return setError(r.error); }
      saved = r.data.receipt;
    } else {
      if (JSON.stringify(header) !== JSON.stringify(savedHeader.current)) {
        const h = await api(`/api/purchasing/goods-receipts/${receipt.id}`, { method: "PATCH", ...jsonBody(header) });
        if (h.status === 401) { setBusy(false); return router.replace("/login"); }
        if (!h.ok) { setBusy(false); return setError(h.error); }
      }
      const r = await api(`/api/purchasing/goods-receipts/${receipt.id}/lines`, { method: "PUT", ...jsonBody(body()) });
      if (r.status === 401) { setBusy(false); return router.replace("/login"); }
      if (!r.ok) { setBusy(false); return setError(r.error); }
      saved = r.data.receipt;
    }
    savedHeader.current = header;
    setBusy(false);
    setReceipt(saved);
    setStage("review");
  }

  // ---- the explicit confirmation: the only step that adds stock ------------------------------------------------------------------
  async function confirm() {
    if (busy || !receipt) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/purchasing/goods-receipts/${receipt.id}/confirm`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) {
      setError(r.error);
      // a definitive refusal returned the receipt to draft: go back to editing it
      if (r.code === "inventory_rejected") setStage("edit");
      return;
    }
    setReceipt(r.data.receipt);
    setStage(r.data.confirmed ? "done" : "pending");
  }

  async function discard() {
    if (busy || !receipt) return;
    setBusy(true);
    const r = await api(`/api/purchasing/goods-receipts/${receipt.id}/cancel`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setError(r.error);
    router.push(`/purchase-orders/${order.id}`);
  }

  if (stage === "done" && receipt) {
    return (
      <section role="status" className="space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
        <h3 className="text-lg font-semibold text-emerald-300">{receipt.number} confirmed</h3>
        <p className="text-sm text-emerald-200">The accepted quantities were added to your stock. Each one is a movement in the stock history.</p>
        <ReviewTable receipt={receipt} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/goods-receipts/${receipt.id}`} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">View the receipt</Link>
          <Link href={`/purchase-orders/${order.id}`} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Back to {order.number}</Link>
        </div>
      </section>
    );
  }

  if (stage === "pending" && receipt) {
    return (
      <section role="alert" className="space-y-4 rounded-xl border border-sky-500/30 bg-sky-500/10 p-5">
        <h3 className="text-lg font-semibold text-sky-200">{receipt.number} is being added to stock</h3>
        <p className="text-sm text-sky-100">
          The inventory service has not confirmed the posting yet{receipt.posting.last_error ? ` (${receipt.posting.last_error})` : ""}. Nothing is lost and nothing will be added twice:
          the receipt is saved and its quantities are reserved. Try again in a moment; you can also come back to it later from Goods Receipts.
        </p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={confirm} disabled={busy} className="min-h-10 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60">{busy ? "Checking…" : "Retry posting"}</button>
          <Link href={`/goods-receipts/${receipt.id}`} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Open the receipt</Link>
        </div>
      </section>
    );
  }

  if (stage === "review" && receipt) {
    return (
      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Review the goods receipt">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold text-white">Review {receipt.number}</h3>
          <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${RECEIPT_STATUS_STYLE[receipt.status]}`}>{RECEIPT_STATUS_LABELS[receipt.status]}</span>
        </div>
        <p className="text-xs text-slate-400">Received on {receipt.received_date}{receipt.supplier_reference ? ` · supplier reference ${receipt.supplier_reference}` : ""} · against {order.number} from {order.supplier.name}</p>
        <ReviewTable receipt={receipt} />
        <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          Nothing has been added to your stock yet. Confirming adds the <strong>accepted</strong> quantities to the chosen warehouses. A rejected quantity is only recorded. A confirmed receipt cannot be changed afterwards.
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => { setStage("edit"); setError(null); }} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60">Back to edit</button>
          <button type="button" onClick={discard} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-red-300 hover:bg-slate-800 disabled:opacity-60">Discard draft</button>
          <button type="button" onClick={confirm} disabled={busy} className="min-h-10 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60">{busy ? "Adding to stock…" : "Confirm and add to stock"}</button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{RECEIPT_NOTICE}</p>
      {receipt && <p role="status" className="text-xs text-slate-400">Editing the draft {receipt.number}.</p>}

      <section className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-3 sm:p-5" aria-label="Receipt details">
        <label className="text-xs font-medium text-slate-400">
          Receiving date
          <input type="date" value={header.receivedDate} max={today()} onChange={(e) => setHeader({ ...header, receivedDate: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Supplier reference (delivery note)
          <input value={header.supplierReference} maxLength={100} onChange={(e) => setHeader({ ...header, supplierReference: e.target.value })} className={fieldClass} />
        </label>
        <label className="text-xs font-medium text-slate-400">
          Notes
          <input value={header.notes} maxLength={2000} onChange={(e) => setHeader({ ...header, notes: e.target.value })} className={fieldClass} />
        </label>
      </section>

      <form onSubmit={onLocate} role="search" aria-label="Find a product on this order" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-medium text-slate-400">
          Find a product on this order (SKU or barcode)
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={200} placeholder="Type, or scan into this box" className={`${fieldClass} font-mono`} />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={looking || !code.trim()} className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 sm:flex-none">{looking ? "Looking…" : "Find product"}</button>
          <button type="button" onClick={() => setCamera((on) => !on)} aria-expanded={camera} className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 sm:flex-none">{camera ? "Hide camera" : "Use camera"}</button>
        </div>
      </form>
      {camera && <CameraScanner onDetected={(text) => { setCamera(false); void locateCode(text); }} onClose={() => setCamera(false)} />}
      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Products on this order">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-3 font-semibold">Product</th>
                <th className="px-3 py-3 font-semibold text-right">Ordered</th>
                <th className="px-3 py-3 font-semibold text-right">Received</th>
                <th className="px-3 py-3 font-semibold text-right">In progress</th>
                <th className="px-3 py-3 font-semibold text-right">Remaining</th>
                <th className="px-3 py-3 font-semibold">Accepted now</th>
                <th className="px-3 py-3 font-semibold">Rejected now</th>
                <th className="px-3 py-3 font-semibold">Warehouse</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {lines.map((line) => {
                const row = rows[line.id];
                const remaining = remainingOf(line);
                const done = !exceeds(remaining, "0") && !draft?.lines.some((l) => l.purchase_order_line_id === line.id); // nothing left to receive
                return (
                  <tr key={line.id} className={`align-top ${highlight === line.id ? "bg-indigo-500/10" : "hover:bg-slate-800/30"}`} data-testid={`row-${line.product_sku}`}>
                    <td className="px-3 py-3">
                      <div className="font-medium text-white">{line.product_name}</div>
                      <div className="font-mono text-xs text-indigo-300">{line.product_sku}</div>
                      {rowErrors[line.id] && <div role="alert" className="mt-1 max-w-xs text-xs text-red-400">{rowErrors[line.id]}</div>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono">{qty(line.quantity)} <span className="text-xs text-slate-400">{line.unit}</span></td>
                    <td className="px-3 py-3 text-right font-mono">{qty(line.received_quantity ?? "0")}</td>
                    <td className="px-3 py-3 text-right font-mono">{qty(line.pending_quantity ?? "0")}</td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-white">{qty(remaining)}</td>
                    <td className="px-3 py-3 w-32">
                      <input aria-label={`Accepted quantity of ${line.product_name}`} ref={(el) => { inputs.current[line.id] = el; }} value={row.accepted} disabled={done} inputMode="decimal"
                        onChange={(e) => set(line.id, { accepted: e.target.value })} className={cellInput} placeholder={done ? "done" : "0"} />
                    </td>
                    <td className="px-3 py-3 w-28">
                      <input aria-label={`Rejected quantity of ${line.product_name}`} value={row.rejected} disabled={done} inputMode="decimal"
                        onChange={(e) => set(line.id, { rejected: e.target.value })} className={cellInput} placeholder="0" />
                    </td>
                    <td className="px-3 py-3 w-40">
                      <select aria-label={`Warehouse for ${line.product_name}`} value={row.warehouseId} disabled={done} onChange={(e) => set(line.id, { warehouseId: e.target.value })}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-indigo-500 disabled:opacity-40">
                        {warehouses.length === 0 && <option value="">No active warehouse</option>}
                        {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">Only the accepted quantity becomes stock. The rejected quantity is recorded for your records and never added. More than the remaining quantity cannot be received.</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/purchase-orders/${order.id}`} className="text-sm text-indigo-300 hover:text-indigo-200">← Back to {order.number}</Link>
        <button type="button" onClick={review} disabled={busy || warehouses.length === 0} className="min-h-11 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {busy ? "Saving the draft…" : "Review receipt"}
        </button>
      </div>
    </div>
  );
}

function ReviewTable({ receipt }: { receipt: ReceiptDetail }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-slate-300">
        <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
          <tr><th className="px-3 py-2 font-semibold">Product</th><th className="px-3 py-2 font-semibold">Warehouse</th><th className="px-3 py-2 font-semibold text-right">Accepted (to stock)</th><th className="px-3 py-2 font-semibold text-right">Rejected (not stock)</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {receipt.lines.map((l) => (
            <tr key={l.id}>
              <td className="px-3 py-2"><span className="font-medium text-white">{l.product_name}</span> <span className="font-mono text-xs text-indigo-300">{l.product_sku}</span></td>
              <td className="px-3 py-2">{l.warehouse_code ?? <span className="text-slate-600">—</span>}</td>
              <td className="px-3 py-2 text-right font-mono text-white">{qty(l.accepted_quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
              <td className="px-3 py-2 text-right font-mono">{qty(l.rejected_quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
