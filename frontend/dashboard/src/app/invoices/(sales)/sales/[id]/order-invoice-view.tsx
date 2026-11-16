"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { SALES_BASE } from "@/components/invoices/invoice-tabs";
import { pdfProblem, printPdf } from "@/lib/invoice-pdf";
import { formatMoney } from "@/lib/product-validation";
import { invoiceQuantity } from "@/lib/sales-browser";
import type { OrderInvoiceDetail } from "@/lib/sales";

// ONE ORDER INVOICE, read-only: who it is for, which order, what is on it, the total. Print and Download (bottom right) give the same PDF (the one template of every invoice). Nothing
// here can be edited: the invoice was made from the order and is frozen. An installment says which one it is and lists the order's other payments.

const buttonClass = "inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60";

export default function OrderInvoiceView({ invoice }: { invoice: OrderInvoiceDetail }) {
  const router = useRouter();
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = invoice.installment_count ?? 1;
  const isInstallment = count > 1;
  const schedule = invoice.schedule ?? [];

  async function printInvoice() {
    if (printing) return;
    setPrinting(true);
    setError(null);
    const outcome = await printPdf(`/api/sales/order-invoices/${invoice.id}/pdf`);
    if (outcome === "unauthorized") router.replace("/login");
    else setError(pdfProblem(outcome));
    setPrinting(false);
  }

  return (
    <article className="space-y-5" aria-label={invoice.number}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-xl font-semibold text-white">{invoice.number}</h2>
        {isInstallment && <span className="rounded-full border border-slate-600/40 bg-slate-700/30 px-2.5 py-0.5 text-xs font-medium text-slate-200">Installment {invoice.installment_no} of {count}</span>}
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300 print:hidden">{error}</p>}

      <dl className="grid gap-x-8 gap-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-slate-400">Client</dt><dd className="mt-0.5 font-medium text-white">{invoice.client_name}</dd>{invoice.client_address && <dd className="mt-0.5 whitespace-pre-line text-xs text-slate-400">{invoice.client_address}</dd>}</div>
        <div><dt className="text-xs text-slate-400">Order</dt><dd className="mt-0.5 font-mono text-white">{invoice.order_number}</dd></div>
        {invoice.delivery_list_number && <div><dt className="text-xs text-slate-400">Delivery list</dt><dd className="mt-0.5 font-mono text-white">{invoice.delivery_list_number}</dd></div>}
        <div><dt className="text-xs text-slate-400">Date</dt><dd className="mt-0.5 text-white">{invoice.invoice_date}</dd></div>
      </dl>

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
        <table className="w-full text-left text-sm text-slate-300">
          <caption className="sr-only">Products on {invoice.number}</caption>
          <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold text-right">Quantity</th>
              <th className="px-4 py-3 font-semibold text-right">Price</th>
              <th className="px-4 py-3 font-semibold text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {invoice.lines.map((line) => (
              <tr key={line.product_id}>
                <td className="px-4 py-3"><div className="font-medium text-white">{line.product_name}</div><div className="font-mono text-xs text-indigo-300">{line.product_sku}</div></td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{invoiceQuantity(line.quantity, line.unit)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(line.unit_price, invoice.currency_code)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{formatMoney(line.line_total, invoice.currency_code)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-700">
              <th scope="row" colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-slate-200">{isInstallment ? "Order total" : "Total"}</th>
              <td className={`px-4 py-3 text-right font-mono whitespace-nowrap ${isInstallment ? "text-sm text-slate-300" : "text-base font-semibold text-white"}`}>{formatMoney(invoice.subtotal, invoice.currency_code)}</td>
            </tr>
            {isInstallment && (
              <tr>
                <th scope="row" colSpan={3} className="px-4 pb-3 text-right text-sm font-semibold text-slate-200">Installment {invoice.installment_no} of {count}</th>
                <td className="px-4 pb-3 text-right font-mono text-base font-semibold text-white whitespace-nowrap">{formatMoney(invoice.total, invoice.currency_code)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {isInstallment && schedule.length > 0 && (
        <section aria-label="Payments" className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/30">
          <table className="w-full text-left text-sm text-slate-300">
            <caption className="sr-only">Payments of {invoice.order_number}</caption>
            <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Payment</th>
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold text-right">Amount</th>
                <th className="px-4 py-3 font-semibold">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {schedule.map((row) => (
                <tr key={row.id} className={row.id === invoice.id ? "bg-slate-800/40" : ""} aria-current={row.id === invoice.id ? "true" : undefined}>
                  <td className="px-4 py-3">{row.installment_no} of {count}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.invoice_date}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(row.total, invoice.currency_code)}</td>
                  <td className="px-4 py-3">{row.id === invoice.id ? <span className="font-mono text-xs text-white">{row.number}</span> : <Link href={`${SALES_BASE}/${row.id}`} className="font-mono text-xs text-indigo-300 hover:text-indigo-200">{row.number}</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        <button type="button" onClick={() => void printInvoice()} disabled={printing} className={buttonClass}>{printing ? "Preparing…" : "Print"}</button>
        <a href={`/api/sales/order-invoices/${invoice.id}/pdf`} download className={buttonClass}>Download</a>
      </div>
    </article>
  );
}
