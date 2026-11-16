"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useToday } from "@/components/clock";
import { SALES_BASE } from "@/components/invoices/invoice-tabs";
import { MAX_INSTALLMENTS, MIN_INSTALLMENTS, UNIT_LABELS, UNIT_LIMITS, parsePlan, splitInstallments, type InstallmentUnit } from "@/lib/installments";
import { downloadPdf, pdfName, pdfProblem, printPdf, type PdfOutcome } from "@/lib/invoice-pdf";
import { formatMoney } from "@/lib/product-validation";
import { api, invoiceQuantity, jsonBody } from "@/lib/sales-browser";
import type { OrderDetail } from "@/lib/sales";

// SALES INVOICE > NEW INVOICE > ONE ORDER. The order as it will be invoiced (read-only). Nothing exists yet: the invoice is made by Print, Download (bottom right: the whole order in one
// invoice) or, with Installments (top right) filled in, by "Create invoice" (or Print / Download, which then use the installments). The first invoice is the one to print now; the
// others are kept in Pending payments until their date.

const buttonClass = "inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60";
const fieldClass = "mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

export default function CreateInvoice({ order }: { order: OrderDetail }) {
  const router = useRouter();
  const today = useToday()();
  const currency = order.currency_code ?? "";
  const total = order.total_amount ?? "0.0000";
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState("");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<InstallmentUnit>("months");
  const [busy, setBusy] = useState<"create" | "print" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; number: string } | null>(null);

  const plan = parsePlan({ count: Number(count), every: Number(every), unit });
  const blocked = open && plan === null; // the panel is open but not filled in: nothing can be made until it is, or closed
  const parts = plan ? splitInstallments(total, plan.count) : [];
  const lastDiffers = parts.length > 1 && parts[parts.length - 1] !== parts[0];

  // Makes the invoice (once): with the installments when the panel is filled in, otherwise for the whole order.
  async function generate(): Promise<{ id: string; number: string } | null> {
    if (created) return created;
    setError(null);
    const r = await api("/api/sales/order-invoices", { method: "POST", ...jsonBody({ orderId: order.id, ...(open && plan ? { installments: plan } : {}) }) });
    if (r.status === 401) {
      router.replace("/login");
      return null;
    }
    if (!r.ok || !r.data?.invoice?.id) {
      setError(r.ok ? "The invoice could not be made. Please try again." : r.error);
      return null;
    }
    setCreated(r.data.invoice);
    return r.data.invoice;
  }

  async function createWithInstallments() {
    if (busy || !plan) return;
    setBusy("create");
    const invoice = await generate();
    if (invoice) router.push(`${SALES_BASE}/${encodeURIComponent(invoice.id)}`);
    else setBusy(null);
  }

  async function output(kind: "print" | "download") {
    if (busy || blocked) return;
    setBusy(kind);
    const invoice = await generate();
    if (invoice) {
      const url = `/api/sales/order-invoices/${encodeURIComponent(invoice.id)}/pdf`;
      const outcome: PdfOutcome = kind === "print" ? await printPdf(url) : await downloadPdf(url, pdfName(invoice.number));
      if (outcome === "unauthorized") router.replace("/login");
      else setError(pdfProblem(outcome));
    }
    setBusy(null);
  }

  return (
    <article className="space-y-5" aria-label={`Invoice for ${order.number}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-xl font-semibold text-white">{created ? created.number : order.number}</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={created !== null || busy !== null} className={buttonClass}>Installments</button>
      </div>

      {open && !created && (
        <section aria-label="Installments" className="relative z-20 space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs font-medium text-slate-400">
              Number of installments
              <select aria-label="Number of installments" value={count} onChange={(e) => setCount(e.target.value)} className={`${fieldClass} w-48`}>
                <option value="">Choose</option>
                {Array.from({ length: MAX_INSTALLMENTS - MIN_INSTALLMENTS + 1 }, (_, i) => MIN_INSTALLMENTS + i).map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </label>
            <div className="text-xs font-medium text-slate-400">
              <label htmlFor="installment-every">Pay every</label>
              <div className="mt-1.5 flex gap-2">
                <input id="installment-every" type="number" inputMode="numeric" min={1} max={UNIT_LIMITS[unit]} value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Time between payments"
                  className="block w-24 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500" />
                <select aria-label="Time unit" value={unit} onChange={(e) => setUnit(e.target.value as InstallmentUnit)} className="block w-32 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
                  {(Object.keys(UNIT_LABELS) as InstallmentUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                </select>
              </div>
            </div>
          </div>
          {plan && (
            <p data-installment-summary className="text-sm text-slate-200">
              {plan.count} payments of <span className="font-mono font-semibold text-white">{formatMoney(parts[0], currency)}</span>
              {lastDiffers && <> (the last one {formatMoney(parts[parts.length - 1], currency)})</>}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={() => void createWithInstallments()} disabled={!plan || busy !== null} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
              {busy === "create" ? "Creating…" : "Create invoice"}
            </button>
          </div>
        </section>
      )}

      {created && (
        <p role="status" className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Invoice {created.number} is ready. <Link href={`${SALES_BASE}/${created.id}`} className="underline">Open it</Link>
        </p>
      )}
      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <dl className="grid gap-x-8 gap-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-slate-400">Client</dt><dd className="mt-0.5 font-medium text-white">{order.client.name}</dd></div>
        <div><dt className="text-xs text-slate-400">Order</dt><dd className="mt-0.5 font-mono text-white">{order.number}</dd></div>
        {order.delivery_list && <div><dt className="text-xs text-slate-400">Delivery list</dt><dd className="mt-0.5 font-mono text-white">{order.delivery_list.number}</dd></div>}
        <div><dt className="text-xs text-slate-400">Date</dt><dd className="mt-0.5 text-white">{today}</dd></div>
      </dl>

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
        <table className="w-full text-left text-sm text-slate-300">
          <caption className="sr-only">Products on {order.number}</caption>
          <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold text-right">Quantity</th>
              <th className="px-4 py-3 font-semibold text-right">Price</th>
              <th className="px-4 py-3 font-semibold text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-4 py-3"><div className="font-medium text-white">{line.product_name}</div><div className="font-mono text-xs text-indigo-300">{line.product_sku}</div></td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{invoiceQuantity(line.ordered_quantity, line.unit)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{line.unit_price ? formatMoney(line.unit_price, currency) : "—"}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{line.line_total ? formatMoney(line.line_total, currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-700">
              <th scope="row" colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-slate-200">Total</th>
              <td className="px-4 py-3 text-right font-mono text-base font-semibold text-white whitespace-nowrap">{formatMoney(total, currency)}</td>
            </tr>
            {plan && !created && (
              <tr>
                <th scope="row" colSpan={3} className="px-4 pb-3 text-right text-sm font-semibold text-slate-200">Installment 1 of {plan.count}</th>
                <td className="px-4 pb-3 text-right font-mono text-base font-semibold text-white whitespace-nowrap">{formatMoney(parts[0], currency)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        <button type="button" onClick={() => void output("print")} disabled={busy !== null || blocked} className={buttonClass}>{busy === "print" ? "Preparing…" : "Print"}</button>
        <button type="button" onClick={() => void output("download")} disabled={busy !== null || blocked} className={buttonClass}>{busy === "download" ? "Preparing…" : "Download"}</button>
      </div>
    </article>
  );
}
