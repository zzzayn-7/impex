import Link from "next/link";

import { formatMoney, INVOICE_STATUS_LABELS, INVOICE_STATUS_STYLE, PAYMENT_METHOD_LABELS } from "@/lib/sales-browser";
import type { ClientAccount } from "@/lib/sales";

/** A client's account: what they owe per currency (never added across currencies), their invoices and the payments they made. Read-only. */
export default function ClientAccountView({ account }: { account: ClientAccount }) {
  const { client, balances, invoices, payments } = account;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-white">{client.name}</h2>
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${client.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>{client.is_active ? "Active" : "Inactive"}</span>
          </div>
          <p className="text-xs text-slate-400">Invoices, payments and the balance this client owes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {client.is_active && <Link href={`/invoices/new?client=${client.id}`} className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">New invoice</Link>}
          <Link href={`/invoices?client=${client.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">All their invoices</Link>
          <Link href={`/delivery-lists?client=${client.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Delivery lists</Link>
        </div>
      </div>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Outstanding balance">
        <h3 className="text-sm font-semibold text-white">Outstanding balance</h3>
        {balances.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing has been invoiced to this client yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {balances.map((b) => (
              <div key={b.currency_code} data-testid={`balance-${b.currency_code}`} className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="font-mono text-xs font-semibold text-indigo-300">{b.currency_code}</p>
                <p className="font-mono text-2xl font-semibold text-white">{formatMoney(b.outstanding)}</p>
                <dl className="space-y-0.5 text-xs text-slate-400">
                  <div className="flex justify-between"><dt>Invoiced</dt><dd className="font-mono">{formatMoney(b.invoiced)}</dd></div>
                  <div className="flex justify-between"><dt>Paid</dt><dd className="font-mono">{formatMoney(b.paid)}</dd></div>
                  <div className="flex justify-between"><dt>Overdue</dt><dd className={`font-mono ${b.overdue !== "0.0000" ? "text-red-300" : ""}`}>{formatMoney(b.overdue)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-slate-500">Balances are kept per currency. Nothing is converted or added across currencies, and draft and void invoices are not counted.</p>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Invoices">
        <h3 className="text-sm font-semibold text-white">Invoices</h3>
        {invoices.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                <tr><th className="px-3 py-2 font-semibold">Invoice</th><th className="px-3 py-2 font-semibold">Date</th><th className="px-3 py-2 font-semibold">Due</th><th className="px-3 py-2 text-right font-semibold">Total</th><th className="px-3 py-2 text-right font-semibold">Outstanding</th><th className="px-3 py-2 font-semibold">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {invoices.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-800/30">
                    <td className="px-3 py-2"><Link href={`/invoices/${i.id}`} className="font-mono font-semibold text-indigo-300 hover:text-indigo-200">{i.number ?? "Draft"}</Link></td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{i.invoice_date}</td>
                    <td className={`px-3 py-2 text-xs whitespace-nowrap ${i.overdue ? "font-semibold text-red-300" : ""}`}>{i.due_date}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">{formatMoney(i.total)} <span className="text-slate-500">{i.currency_code}</span></td>
                    <td className="px-3 py-2 text-right font-mono text-xs whitespace-nowrap">{i.status === "issued" || i.status === "partially_paid" ? formatMoney(i.outstanding) : <span className="text-slate-600">—</span>}</td>
                    <td className="px-3 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLE[i.status]}`}>{INVOICE_STATUS_LABELS[i.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 sm:p-5" aria-label="Recent payments">
        <h3 className="text-sm font-semibold text-white">Recent payments</h3>
        {payments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-500">No payment has been recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
                <tr><th className="px-3 py-2 font-semibold">Date</th><th className="px-3 py-2 font-semibold">Invoice</th><th className="px-3 py-2 font-semibold">Method</th><th className="px-3 py-2 font-semibold">Reference</th><th className="px-3 py-2 text-right font-semibold">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {payments.map((p) => (
                  <tr key={p.id} className={p.kind === "reversal" || p.reversed ? "text-slate-500" : ""}>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{p.payment_date}</td>
                    <td className="px-3 py-2"><Link href={`/invoices/${p.invoice_id}`} className="font-mono text-indigo-300 hover:text-indigo-200">{p.invoice_number}</Link></td>
                    <td className="px-3 py-2">{PAYMENT_METHOD_LABELS[p.method] ?? p.method}</td>
                    <td className="px-3 py-2 text-xs">{p.kind === "reversal" ? `Reversal — ${p.notes ?? ""}` : (p.reference ?? "—")}{p.reversed && <span className="ml-2 font-semibold text-amber-300">Reversed</span>}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs whitespace-nowrap ${p.kind === "reversal" ? "text-red-300" : ""}`}>{p.kind === "reversal" ? "−" : ""}{formatMoney(p.amount)} <span className="text-slate-500">{p.currency_code}</span></td>
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
