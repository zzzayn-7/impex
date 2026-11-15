"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { formatMoney } from "@/lib/product-validation";
import { qty } from "@/lib/sales-browser";
import type { OrderInvoiceDetail } from "@/lib/sales";

// ONE ORDER INVOICE, read-only: who it is for, which order, what is on it, the total. Print and Download give the same PDF (the one template of every invoice). Nothing here can be
// edited: the invoice was made from the order and is frozen.

// A unit that is a number (a pack of 400) is shown the way it is read: <pieces/total>, e.g. 20/400. A word unit (pcs, kg) stays "20 pcs".
const quantityText = (quantity: string, unit: string) => (/^\d+(\.\d+)?$/.test(unit.trim()) ? `${qty(quantity)}/${qty(unit.trim())}` : `${qty(quantity)} ${unit}`);

const buttonClass = "inline-flex min-h-10 items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60";

export default function OrderInvoiceView({ invoice }: { invoice: OrderInvoiceDetail }) {
  const router = useRouter();
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PRINT: the invoice itself - the same PDF Download saves - is fetched with the administrator's session and handed to the browser's print dialog from a hidden frame, so the
  // dashboard (sidebar, header, buttons) is never part of what is printed. If the browser will not print from a frame, the PDF opens in a tab instead.
  async function printInvoice() {
    if (printing) return;
    setPrinting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sales/order-invoices/${invoice.id}/pdf?inline=1`, { cache: "no-store" });
      if (res.status === 401) return router.replace("/login");
      if (!res.ok) return setError("The invoice could not be prepared for printing. Please try again.");
      const url = URL.createObjectURL(await res.blob());
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.title = "Invoice to print";
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
      const cleanup = () => { URL.revokeObjectURL(url); frame.remove(); };
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(url, "_blank");
        }
        setTimeout(cleanup, 120000);
      };
      frame.src = url;
      document.body.appendChild(frame);
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setPrinting(false);
    }
  }

  return (
    <article className="space-y-5" aria-label={invoice.number}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-xl font-semibold text-white">{invoice.number}</h2>
        <div className="flex flex-wrap gap-2 print:hidden">
          <button type="button" onClick={() => void printInvoice()} disabled={printing} className={buttonClass}>{printing ? "Preparing…" : "Print"}</button>
          <a href={`/api/sales/order-invoices/${invoice.id}/pdf`} download className={buttonClass}>Download</a>
        </div>
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
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{quantityText(line.quantity, line.unit)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(line.unit_price, invoice.currency_code)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{formatMoney(line.line_total, invoice.currency_code)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-700">
              <th scope="row" colSpan={3} className="px-4 py-3 text-right text-sm font-semibold text-slate-200">Total</th>
              <td className="px-4 py-3 text-right font-mono text-base font-semibold text-white whitespace-nowrap">{formatMoney(invoice.total, invoice.currency_code)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </article>
  );
}
