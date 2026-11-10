"use client";

import { useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DISPATCH_NOTICE, DISPATCH_STATUS_LABELS, DISPATCH_STATUS_STYLE, api, qty } from "@/lib/sales-browser";
import type { DispatchDetail } from "@/lib/sales";
import { useStamp } from "@/components/clock";


export default function DispatchDetailView({ dispatch: initial }: { dispatch: DispatchDetail }) {
  const stamp = useStamp();
  const router = useRouter();
  const [dispatch, setDispatch] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: "confirm" | "cancel") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await api(`/api/sales/dispatches/${dispatch.id}/${action}`, { method: "POST" });
    setBusy(false);
    if (r.status === 401) return router.replace("/login");
    if (!r.ok) return setMessage({ ok: false, text: r.error });
    setDispatch(r.data.dispatch);
    setConfirmingCancel(false);
    if (action === "cancel") return setMessage({ ok: true, text: `${r.data.dispatch.number} was cancelled. It is kept for history; no stock was involved.` });
    setMessage(
      r.data.confirmed
        ? { ok: true, text: `${r.data.dispatch.number} is confirmed. The dispatched quantities were deducted from your stock.` }
        : { ok: false, text: "The inventory service has not confirmed the posting yet. Nothing is lost and nothing will be deducted twice; try again in a moment." }
    );
    router.refresh();
  }

  const lines = dispatch.lines;
  const short = dispatch.status === "draft" && dispatch.lines_exceeding_stock > 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-2xl font-semibold text-white">{dispatch.number}</h2>
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${DISPATCH_STATUS_STYLE[dispatch.status]}`}>{DISPATCH_STATUS_LABELS[dispatch.status]}</span>
          </div>
          <p className="mt-1 text-sm text-slate-300">
            For {dispatch.client.name} · against <Link href={`/delivery-lists/${dispatch.delivery_list.id}`} className="font-mono font-medium text-indigo-300 hover:text-indigo-200">{dispatch.delivery_list.number}</Link>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Dispatch date {dispatch.dispatch_date}{dispatch.tracking_reference ? ` · tracking ${dispatch.tracking_reference}` : ""} · prepared by {dispatch.created_by_email}
            {dispatch.confirmed_at && ` · confirmed by ${dispatch.confirmed_by_email} on ${stamp(dispatch.confirmed_at)}`}
            {dispatch.cancelled_at && ` · cancelled by ${dispatch.cancelled_by_email} on ${stamp(dispatch.cancelled_at)}`}
          </p>
          {(dispatch.delivery_address || dispatch.transport_details) && (
            <p className="mt-1 text-xs text-slate-400">{dispatch.delivery_address && <>Deliver to: {dispatch.delivery_address}</>}{dispatch.delivery_address && dispatch.transport_details ? " · " : ""}{dispatch.transport_details && <>Transport: {dispatch.transport_details}</>}</p>
          )}
          {dispatch.notes && <p className="mt-1 text-xs text-slate-400">{dispatch.notes}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Dispatch actions">
          {dispatch.status === "draft" && (
            <>
              <Link href={`/delivery-lists/${dispatch.delivery_list.id}/dispatch?dispatch=${dispatch.id}`} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Edit dispatch</Link>
              <button type="button" disabled={busy || lines.length === 0 || short} onClick={() => act("confirm")} className="min-h-11 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? "Deducting from stock…" : "Confirm and deduct from stock"}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmingCancel(true)} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-red-300 hover:bg-slate-800 disabled:opacity-50">Discard draft</button>
            </>
          )}
          {dispatch.status === "confirmed" && (
            <Link href={`/invoices/new?client=${dispatch.client.id}`} className="min-h-11 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Create invoice</Link>
          )}
          {dispatch.status === "posting" && (
            <button type="button" disabled={busy} onClick={() => act("confirm")} className="min-h-11 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{busy ? "Checking…" : "Retry posting"}</button>
          )}
        </div>
      </div>

      {confirmingCancel && (
        <div role="alertdialog" aria-label="Confirm discarding the draft" className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-200">Discard {dispatch.number}?</p>
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

      {dispatch.status === "posting" && (
        <div role="status" className="space-y-1 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <p>This dispatch is being deducted from stock. It is saved and its quantities are reserved, but the inventory service has not confirmed the posting yet.</p>
          <p className="text-xs text-sky-200/80">
            Attempts: {dispatch.posting.attempts}{dispatch.posting.last_attempt_at ? ` · last try ${stamp(dispatch.posting.last_attempt_at)}` : ""}{dispatch.posting.last_error ? ` · ${dispatch.posting.last_error}` : ""}.
            Retrying is always safe: the goods cannot be deducted twice.
          </p>
        </div>
      )}
      {dispatch.status === "draft" && dispatch.posting.last_error && (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">The last attempt to deduct this dispatch from stock was refused, and nothing was deducted: {dispatch.posting.last_error}</p>
      )}
      {short && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{dispatch.lines_exceeding_stock} {dispatch.lines_exceeding_stock === 1 ? "line asks" : "lines ask"} for more than is in stock right now, so this dispatch cannot be confirmed yet.</p>}
      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">{dispatch.stock_notice || DISPATCH_NOTICE}</p>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Dispatch lines">
        <h3 className="text-sm font-semibold text-white">Products ({lines.length})</h3>
        {lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-8 text-center text-sm text-slate-500">No products on this dispatch yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-3 font-semibold">Product</th><th className="px-3 py-3 font-semibold text-right">Requested</th>
                  <th className="px-3 py-3 font-semibold text-right">Dispatched</th>{dispatch.stock_status === "ok" && <th className="px-3 py-3 font-semibold text-right">In stock now</th>}<th className="px-3 py-3 font-semibold">Stock movement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {lines.map((l) => (
                  <tr key={l.id} className="align-top hover:bg-slate-800/30">
                    <td className="px-3 py-3"><div className="font-medium text-white">{l.product_name}</div><div className="font-mono text-xs text-indigo-300">{l.product_sku}</div></td>
                    <td className="px-3 py-3 text-right font-mono">{qty(l.requested_quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-white">{qty(l.quantity)} <span className="text-xs font-normal text-slate-400">{l.unit}</span></td>
                    {dispatch.stock_status === "ok" && <td className="px-3 py-3 text-right font-mono text-xs">{l.available_quantity === null ? <span className="text-slate-600">—</span> : <>{qty(l.available_quantity)} {l.unit}</>}</td>}
                    <td className="px-3 py-3 text-xs">
                      {l.inventory_movement_id
                        ? <Tooltip label={`Stock movement ${l.inventory_movement_id}`}><Link href={`/movements?product=${l.product_id}`} className="font-mono text-indigo-300 hover:text-indigo-200">#{l.inventory_movement_id.slice(0, 8)}</Link></Tooltip>
                        : <span className="text-slate-600">not yet deducted</span>}
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
