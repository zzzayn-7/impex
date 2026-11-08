"use client";

import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { RECEIPT_NOTICE, RECEIPT_STATUS_LABELS, RECEIPT_STATUS_STYLE } from "@/lib/purchasing-browser";
import { api, qty } from "@/lib/sales-browser";
import type { ReceiptDetail } from "@/lib/purchasing";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ") + " UTC";

export default function ReceiptDetailView({ receipt: initial }: { receipt: ReceiptDetail }) {
  const router = useRouter();
  const [receipt, setReceipt] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: "confirm" | "cancel") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await api(`/api/purchasing/goods-receipts/${receipt.id}/${action}`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    setReceipt(r.data.receipt);
    setConfirmingCancel(false);
    if (action === "cancel") return setMessage({ ok: true, text: `${r.data.receipt.number} was cancelled. It is kept for history; no stock was involved.` });
    setMessage(
      r.data.confirmed
        ? { ok: true, text: `${r.data.receipt.number} is confirmed. The accepted quantities were added to your stock.` }
        : { ok: false, text: "The inventory service has not confirmed the posting yet. Nothing is lost and nothing will be added twice; try again in a moment." }
    );
    router.refresh();
  }

  const lines = receipt.lines;
  const hasRejected = lines.some((l) => /[1-9]/.test(l.rejected_quantity));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-2xl font-semibold text-white">{receipt.number}</h2>
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${RECEIPT_STATUS_STYLE[receipt.status]}`}>{RECEIPT_STATUS_LABELS[receipt.status]}</span>
          </div>
          <p className="mt-1 text-sm text-slate-300">
            Against <Link href={`/purchase-orders/${receipt.purchase_order.id}`} className="font-mono font-medium text-indigo-300 hover:text-indigo-200">{receipt.purchase_order.number}</Link> from {receipt.supplier.name}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Received on {receipt.received_date}{receipt.supplier_reference ? ` · supplier reference ${receipt.supplier_reference}` : ""} · started by {receipt.created_by_email}
            {receipt.confirmed_at && ` · confirmed by ${receipt.confirmed_by_email} on ${stamp(receipt.confirmed_at)}`}
            {receipt.cancelled_at && ` · cancelled by ${receipt.cancelled_by_email} on ${stamp(receipt.cancelled_at)}`}
          </p>
          {receipt.notes && <p className="mt-1 text-xs text-slate-400">{receipt.notes}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Receipt actions">
          {receipt.status === "draft" && (
            <>
              <Link href={`/purchase-orders/${receipt.purchase_order.id}/receive?receipt=${receipt.id}`} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Edit receipt</Link>
              <button type="button" disabled={busy || lines.length === 0} onClick={() => act("confirm")} className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? "Adding to stock…" : "Confirm and add to stock"}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmingCancel(true)} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-red-300 hover:bg-slate-800 disabled:opacity-50">Discard draft</button>
            </>
          )}
          {receipt.status === "posting" && (
            <button type="button" disabled={busy} onClick={() => act("confirm")} className="min-h-11 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{busy ? "Checking…" : "Retry posting"}</button>
          )}
        </div>
      </div>

      {confirmingCancel && (
        <div role="alertdialog" aria-label="Confirm discarding the draft" className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-200">Discard {receipt.number}?</p>
          <p className="text-xs text-amber-300/80">The draft is kept for history and cannot be reopened. No stock is involved.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmingCancel(false)} disabled={busy} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Back</button>
            <button type="button" onClick={() => act("cancel")} disabled={busy} className="min-h-10 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">{busy ? "Saving…" : "Yes, discard it"}</button>
          </div>
        </div>
      )}

      {message && (
        <div role={message.ok ? "status" : "alert"} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {receipt.status === "posting" && (
        <div role="status" className="space-y-1 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <p>This receipt is being added to stock. It is saved and its quantities are reserved, but the inventory service has not confirmed the posting yet.</p>
          <p className="text-xs text-sky-200/80">
            Attempts: {receipt.posting.attempts}{receipt.posting.last_attempt_at ? ` · last try ${stamp(receipt.posting.last_attempt_at)}` : ""}{receipt.posting.last_error ? ` · ${receipt.posting.last_error}` : ""}.
            Retrying is always safe: the goods cannot be added twice.
          </p>
        </div>
      )}
      {receipt.status === "draft" && receipt.posting.last_error && (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">The last attempt to add this receipt to stock was refused, and nothing was added: {receipt.posting.last_error}</p>
      )}
      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{receipt.stock_notice || RECEIPT_NOTICE}</p>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Receipt lines">
        <h3 className="text-sm font-semibold text-white">Products ({lines.length})</h3>
        {lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">No products on this receipt yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-3 font-semibold">Product</th><th className="px-3 py-3 font-semibold text-right">Ordered</th>
                  <th className="px-3 py-3 font-semibold text-right">Accepted</th>{hasRejected && <th className="px-3 py-3 font-semibold text-right">Rejected</th>}<th className="px-3 py-3 font-semibold">Stock movement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {lines.map((l) => (
                  <tr key={l.id} className="align-top hover:bg-slate-800/30">
                    <td className="px-3 py-3"><div className="font-medium text-white">{l.product_name}</div><div className="font-mono text-xs text-indigo-300">{l.product_sku}</div>{l.notes && <div className="mt-1 text-xs text-slate-500">{l.notes}</div>}</td>
                    <td className="px-3 py-3 text-right font-mono">{qty(l.ordered_quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-white">{qty(l.accepted_quantity)} <span className="text-xs font-normal text-slate-400">{l.unit}</span></td>
                    {hasRejected && <td className="px-3 py-3 text-right font-mono">{qty(l.rejected_quantity)}</td>}
                    <td className="px-3 py-3 text-xs">
                      {l.inventory_movement_id
                        ? <Tooltip label={`Stock movement ${l.inventory_movement_id}`}><Link href={`/movements?product=${l.product_id}`} className="font-mono text-indigo-300 hover:text-indigo-200">#{l.inventory_movement_id.slice(0, 8)}</Link></Tooltip>
                        : <span className="text-slate-600">{/[1-9]/.test(l.accepted_quantity) ? "not yet in stock" : "none (nothing accepted)"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
