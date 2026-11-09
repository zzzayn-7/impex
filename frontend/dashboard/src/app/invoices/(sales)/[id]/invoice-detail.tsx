"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  api, formatMoney, INVOICE_NOTICE, INVOICE_STATUS_LABELS, INVOICE_STATUS_STYLE, jsonBody, moneyExceeds, PAYMENT_METHOD_LABELS, qty,
} from "@/lib/sales-browser";
import { newIdempotencyKey } from "@/lib/stock-validation";
import type { InvoiceDetail, Payment, PaymentMethod } from "@/lib/sales";

const fieldClass = "mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const buttonClass = "min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60";
const today = () => new Date().toISOString().slice(0, 10);
const plain = (value: string) => qty(value).replace(/,/g, "");

/** One invoice: the document (print it, or download the PDF), its payments, and the actions that are allowed in its state. Issuing, voiding and
 *  payments never change stock. A payment is never edited or deleted: a mistake is corrected by a reversal that stays on record. */
export default function InvoiceDetailView({ invoice: initial }: { invoice: InvoiceDetail }) {
  const router = useRouter();
  const [invoice, setInvoice] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"issue" | "void" | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const payKey = useRef(newIdempotencyKey());
  const reverseKey = useRef(newIdempotencyKey());
  const [pay, setPay] = useState({ amount: "", method: "bank_transfer" as PaymentMethod, paymentDate: today(), reference: "", notes: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const cur = invoice.currency_code;
  const money = (value: string) => `${formatMoney(value)} ${cur}`;
  const live = invoice.status === "issued" || invoice.status === "partially_paid" || invoice.status === "paid";
  const hasPayments = invoice.payments.length > 0;

  function accepted(data: any, message: string) {
    setInvoice(data.invoice);
    setNotice(message);
    setError(null);
    setConfirming(null);
    router.refresh();
  }
  function rejected(r: { status: number; error: string; fieldErrors?: Record<string, string> }, key?: { current: string }) {
    if (r.status === 401) return router.replace("/login");
    if (key && r.status >= 400 && r.status < 500) key.current = newIdempotencyKey(); // that request was not accepted: the next attempt is a new one
    setFieldErrors(r.fieldErrors ?? {});
    setError(r.error);
  }

  async function act(action: "issue" | "void") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/sales/invoices/${invoice.id}/${action}`, { method: "POST", ...(action === "void" ? jsonBody({ reason: voidReason }) : {}) });
    setBusy(false);
    if (!r.ok) return rejected(r);
    accepted(r.data, action === "issue" ? `${r.data.invoice.number} issued. Its commercial details are now frozen.` : "The invoice was voided.");
  }

  async function recordPayment() {
    if (busy) return;
    setError(null);
    setNotice(null);
    const problems: Record<string, string> = {};
    if (!/^[0-9]{1,14}(\.[0-9]{1,4})?$/.test(pay.amount.trim()) || /^0+(\.0+)?$/.test(pay.amount.trim())) problems.amount = "Enter the amount received (greater than zero, at most 4 decimals).";
    else if (moneyExceeds(pay.amount.trim(), invoice.outstanding)) problems.amount = `That is more than the ${money(invoice.outstanding)} still due. No credit balance is held, so a payment above the amount due is not accepted.`;
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    const r = await api(`/api/sales/invoices/${invoice.id}/payments`, { method: "POST", headers: { "Idempotency-Key": payKey.current }, ...jsonBody(pay) });
    setBusy(false);
    if (!r.ok) return rejected(r, payKey);
    payKey.current = newIdempotencyKey(); // the next payment is a new one
    setPay({ amount: "", method: pay.method, paymentDate: today(), reference: "", notes: "" });
    setFieldErrors({});
    accepted(r.data, r.data.replayed ? "That payment had already been recorded." : "Payment recorded.");
  }

  async function reversePayment(payment: Payment) {
    if (busy) return;
    if (!reverseReason.trim()) return setFieldErrors({ reason: "Give the reason for reversing this payment." });
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await api(`/api/sales/invoices/${invoice.id}/payments/${payment.id}/reverse`, { method: "POST", headers: { "Idempotency-Key": reverseKey.current }, ...jsonBody({ reason: reverseReason.trim() }) });
    setBusy(false);
    if (!r.ok) return rejected(r, reverseKey);
    reverseKey.current = newIdempotencyKey();
    setReversing(null);
    setReverseReason("");
    setFieldErrors({});
    accepted(r.data, "Payment reversed. Both records stay on the invoice.");
  }

  return (
    <article className="space-y-5" aria-label={invoice.number ?? "Draft invoice"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-xl font-semibold text-white">{invoice.number ?? "Draft invoice"}</h2>
            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLE[invoice.status]}`}>{INVOICE_STATUS_LABELS[invoice.status]}</span>
            {invoice.overdue && <span className="inline-flex rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-300">Overdue</span>}
          </div>
          <p className="text-xs text-slate-400">
            For {invoice.client.name}{!invoice.client.is_active && " (inactive)"}
            {invoice.delivery_list && <> · list <Link href={`/delivery-lists/${invoice.delivery_list.id}`} className="font-mono text-indigo-300 hover:text-indigo-200">{invoice.delivery_list.number}</Link></>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {invoice.editable && <Link href={`/invoices/${invoice.id}/edit`} className={`${buttonClass} inline-flex items-center`}>Edit draft</Link>}
          <button type="button" onClick={() => window.print()} className={buttonClass}>Print</button>
          <a href={`/api/sales/invoices/${invoice.id}/pdf`} download className={`${buttonClass} inline-flex items-center`}>Download PDF</a>
        </div>
      </div>

      {notice && <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 print:hidden">{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300 print:hidden">{error}</p>}
      {invoice.status === "void" && (
        <p role="note" className="rounded-lg border border-slate-600/40 bg-slate-700/30 px-4 py-3 text-sm text-slate-300">
          <strong>VOID</strong>{invoice.void_reason ? ` — ${invoice.void_reason}` : ""}. This invoice is kept for history and no longer counts as billed: the dispatched goods can be invoiced again.
        </p>
      )}

      <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:grid-cols-3 sm:p-5" aria-label="Invoice details">
        <div><h3 className="text-xs font-semibold uppercase text-slate-400">From</h3><p className="mt-1 text-sm text-white">{invoice.seller_name ?? "—"}</p></div>
        <div>
          <h3 className="text-xs font-semibold uppercase text-slate-400">Bill to</h3>
          <p className="mt-1 text-sm text-white">{invoice.client_name ?? invoice.client.name}</p>
          {invoice.client_address && <p className="whitespace-pre-line text-xs text-slate-400">{invoice.client_address}</p>}
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-slate-400">Invoice date</dt><dd className="text-white">{invoice.invoice_date}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-400">Due date</dt><dd className={invoice.overdue ? "font-semibold text-red-300" : "text-white"}>{invoice.due_date}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-slate-400">Currency</dt><dd className="font-mono text-white">{cur}</dd></div>
        </dl>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Invoice lines">
        {invoice.lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">This draft has no lines yet. Edit it to add dispatched products.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-semibold">Product</th><th className="px-3 py-2 text-right font-semibold">Quantity</th><th className="px-3 py-2 text-right font-semibold">Price</th>
                  <th className="px-3 py-2 text-right font-semibold">Discount</th><th className="px-3 py-2 text-right font-semibold">Tax</th><th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {invoice.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      <span className="font-medium text-white">{l.product_name}</span> <span className="font-mono text-xs text-indigo-300">{l.product_sku}</span>
                      <div className="text-[11px] text-slate-500">from {l.allocations.map((a) => `${a.dispatch_number} (${qty(a.quantity)})`).join(", ")}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{qty(l.quantity)} <span className="text-xs text-slate-400">{l.unit}</span></td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{formatMoney(l.unit_price)}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{moneyExceeds(l.discount_amount, "0") ? formatMoney(l.discount_amount) : <span className="text-slate-600">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {moneyExceeds(l.tax_rate, "0") ? <>{formatMoney(l.line_tax)}<div className="text-[11px] text-slate-500">{l.tax_label ?? "Tax"} {plain(l.tax_rate)}%</div></> : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-white">{formatMoney(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dl className="ml-auto mt-4 w-full max-w-sm space-y-1 text-sm" aria-label="Totals">
          <Row label="Subtotal" value={money(invoice.subtotal)} />
          <Row label="Discount" value={money(invoice.discount_total)} />
          <Row label="Tax" value={money(invoice.tax_total)} />
          <div className="border-t border-slate-800 pt-1"><Row label="Total" value={money(invoice.total)} strong /></div>
          <Row label="Paid" value={money(invoice.paid_total)} />
          <div className="border-t border-slate-800 pt-1"><Row label="Outstanding" value={money(invoice.outstanding)} strong /></div>
        </dl>
        {invoice.notes && <p className="mt-4 whitespace-pre-line text-sm text-slate-300"><span className="text-xs font-semibold uppercase text-slate-400">Notes </span>{invoice.notes}</p>}
        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">{invoice.disclaimer}</p>
      </section>

      {(hasPayments || live) && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Payments">
          <h3 className="text-sm font-semibold text-white">Payments</h3>
          {!hasPayments ? (
            <p className="text-sm text-slate-500">No payment has been recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                  <tr><th className="px-3 py-2 font-semibold">Date</th><th className="px-3 py-2 font-semibold">Method</th><th className="px-3 py-2 font-semibold">Reference</th><th className="px-3 py-2 text-right font-semibold">Amount</th><th className="px-3 py-2 font-semibold">Recorded by</th><th className="px-3 py-2 print:hidden" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {invoice.payments.map((p) => (
                    <tr key={p.id} className={p.kind === "reversal" || p.reversed ? "text-slate-500" : ""}>
                      <td className="px-3 py-2 whitespace-nowrap">{p.payment_date}</td>
                      <td className="px-3 py-2">{PAYMENT_METHOD_LABELS[p.method] ?? p.method}</td>
                      <td className="px-3 py-2 text-xs">
                        {p.kind === "reversal" ? <>Reversal — {p.notes}</> : <>{p.reference ?? "—"}{p.notes ? <div className="text-slate-500">{p.notes}</div> : null}{p.reversed && <div className="font-semibold text-amber-300">Reversed</div>}</>}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono whitespace-nowrap ${p.kind === "reversal" ? "text-red-300" : p.reversed ? "line-through" : "text-white"}`}>{p.kind === "reversal" ? "−" : ""}{formatMoney(p.amount)}</td>
                      <td className="px-3 py-2 text-xs">{p.recorded_by_email}</td>
                      <td className="px-3 py-2 text-right print:hidden">
                        {p.kind === "payment" && !p.reversed && invoice.status !== "void" && (
                          <button type="button" onClick={() => { setReversing(reversing === p.id ? null : p.id); setReverseReason(""); setFieldErrors({}); setError(null); }} aria-expanded={reversing === p.id}
                            aria-label={`Reverse the payment of ${formatMoney(p.amount)} on ${p.payment_date}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-slate-800">Reverse</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {invoice.payments.filter((p) => p.id === reversing).map((p) => (
            <div key={p.id} role="group" aria-label="Reverse payment" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 print:hidden">
              <p className="text-sm text-amber-100">Reversing the payment of {money(p.amount)} adds a reversal to the record. The payment itself is never deleted, and the balance due goes back up by that amount.</p>
              <label className="block text-xs font-medium text-amber-100">
                Reason
                <input value={reverseReason} maxLength={500} onChange={(e) => setReverseReason(e.target.value)} className={fieldClass} placeholder="e.g. recorded twice, cheque bounced" />
              </label>
              {fieldErrors.reason && <p role="alert" className="text-sm text-red-300">{fieldErrors.reason}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => reversePayment(p)} className="min-h-10 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60">{busy ? "Reversing…" : "Reverse this payment"}</button>
                <button type="button" onClick={() => setReversing(null)} className={buttonClass}>Keep it</button>
              </div>
            </div>
          ))}

          {invoice.can_record_payment && (
            <form onSubmit={(e) => { e.preventDefault(); void recordPayment(); }} aria-label="Record a payment" className="space-y-3 border-t border-slate-800 pt-4 print:hidden">
              <h4 className="text-sm font-semibold text-white">Record a payment received</h4>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs font-medium text-slate-400">
                  Amount ({cur})
                  <input aria-label="Payment amount" value={pay.amount} inputMode="decimal" placeholder="0.00" onChange={(e) => setPay({ ...pay, amount: e.target.value })} className={`${fieldClass} font-mono`} />
                  {fieldErrors.amount && <span role="alert" className="mt-1 block text-red-400">{fieldErrors.amount}</span>}
                </label>
                <label className="text-xs font-medium text-slate-400">
                  Method
                  <select aria-label="Payment method" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PaymentMethod })} className={fieldClass}>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-400">
                  Date received
                  <input aria-label="Payment date" type="date" value={pay.paymentDate} max={today()} onChange={(e) => setPay({ ...pay, paymentDate: e.target.value })} className={fieldClass} />
                  {fieldErrors.paymentDate && <span role="alert" className="mt-1 block text-red-400">{fieldErrors.paymentDate}</span>}
                </label>
                <label className="text-xs font-medium text-slate-400">
                  Reference (optional)
                  <input aria-label="Payment reference" value={pay.reference} maxLength={100} onChange={(e) => setPay({ ...pay, reference: e.target.value })} className={fieldClass} placeholder="Receipt, cheque or transfer number" />
                </label>
                <label className="text-xs font-medium text-slate-400 sm:col-span-2 lg:col-span-4">
                  Notes (optional)
                  <input aria-label="Payment notes" value={pay.notes} maxLength={500} onChange={(e) => setPay({ ...pay, notes: e.target.value })} className={fieldClass} />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" disabled={busy} className="min-h-10 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60">{busy ? "Recording…" : "Record payment"}</button>
                <button type="button" onClick={() => setPay({ ...pay, amount: plain(invoice.outstanding) })} className="text-xs font-medium text-indigo-300 hover:text-indigo-200">Pay the full {money(invoice.outstanding)} still due</button>
              </div>
              <p className="text-[11px] text-slate-500">Payments are recorded by hand; Impex does not contact a bank or take a card payment. A payment cannot be edited or deleted afterwards — a mistake is corrected with a reversal.</p>
            </form>
          )}
        </section>
      )}

      {(invoice.can_issue || invoice.can_void || (live && hasPayments)) && (
        <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5 print:hidden" aria-label="Invoice actions">
          {invoice.can_issue && confirming !== "issue" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-300">Review the invoice above. Issuing gives it its number and freezes its prices, discounts and taxes.</p>
              <button type="button" onClick={() => { setConfirming("issue"); setError(null); }} className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Issue invoice</button>
            </div>
          )}
          {confirming === "issue" && (
            <div role="group" aria-label="Confirm issuing" className="space-y-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
              <p className="text-sm text-indigo-100">Issue this invoice for {money(invoice.total)}? It gets the next invoice number and can no longer be edited. Stock is not touched.</p>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => act("issue")} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">{busy ? "Issuing…" : "Yes, issue it"}</button>
                <button type="button" onClick={() => setConfirming(null)} className={buttonClass}>Not yet</button>
              </div>
            </div>
          )}
          {live && hasPayments && invoice.status !== "void" && (
            <p className="text-xs text-slate-400">This invoice has payments on record, so it cannot be voided. To cancel it, reverse its payments first (each reversal stays on record), then void it and issue a corrected invoice.</p>
          )}
          {invoice.can_void && confirming !== "void" && (
            <button type="button" onClick={() => { setConfirming("void"); setError(null); }} className="min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-red-300 hover:bg-slate-800">{invoice.status === "draft" ? "Discard draft" : "Void invoice"}</button>
          )}
          {confirming === "void" && (
            <div role="group" aria-label="Confirm voiding" className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <p className="text-sm text-red-100">{invoice.status === "draft" ? "Discard this draft?" : `Void ${invoice.number}? It stays on record, marked void, and the dispatched goods can be invoiced again.`}</p>
              {invoice.status !== "draft" && (
                <label className="block text-xs font-medium text-red-100">
                  Reason
                  <input value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} className={fieldClass} placeholder="e.g. issued to the wrong client" />
                </label>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy || (invoice.status !== "draft" && !voidReason.trim())} onClick={() => act("void")} className="min-h-10 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60">{busy ? "Working…" : invoice.status === "draft" ? "Yes, discard it" : "Yes, void it"}</button>
                <button type="button" onClick={() => setConfirming(null)} className={buttonClass}>Keep it</button>
              </div>
            </div>
          )}
        </section>
      )}

      <p role="note" className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200 print:hidden">{INVOICE_NOTICE}</p>
    </article>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? "text-base font-semibold text-white" : "text-slate-300"}`}>
      <dt>{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
