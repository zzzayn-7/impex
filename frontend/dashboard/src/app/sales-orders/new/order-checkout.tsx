"use client";

import { useEffect, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/controls";
import { GlassPanel } from "@/components/ui/glass";
import { type OrderRow, orderTotal, priceErrors, readyToSave, rowTotal } from "@/lib/order-form";
import { formatMoney } from "@/lib/product-validation";
import { qty } from "@/lib/sales-browser";

// ORDER CHECKOUT (step 2 of Create Order). The products, quantities, units and the client are READ-ONLY here: the only thing a person can type is the price of
// ONE piece for each product, the price agreed with THIS client. Every line total and the order total follow immediately, in exact decimal arithmetic (nothing
// is a JavaScript number). Save Order stays off until EVERY product has a valid price; an empty price is "not entered", never zero. Changing the selection is
// done by going Back to Products, which keeps everything chosen so far. Nothing is saved or reserved until Save Order.
//
// On a phone the table turns into one card per product (the same inputs, stacked and large enough for a thumb).

export default function OrderCheckout({ clientName, clientId, currency, rows, onPrice, onBack, onSave, busy }: {
  clientName: string;
  clientId: string;
  currency: string;
  rows: OrderRow[];
  onPrice: (productId: string, value: string) => void;
  onBack: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const [seen, setSeen] = useState<Record<string, boolean>>({}); // a price field was left: an empty one is now worth pointing at
  const first = useRef<HTMLInputElement | null>(null);
  const errors = priceErrors(rows);
  const total = orderTotal(rows);
  const ready = readyToSave(clientId, rows);
  const missing = rows.filter((r) => r.unitPrice.trim() === "").length;

  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);

  const shown = (row: OrderRow) => {
    const problem = errors[row.productId];
    return problem && (row.unitPrice.trim() !== "" || seen[row.productId]) ? problem : undefined;
  };

  return (
    <div className="space-y-5" aria-label="Order checkout">
      <GlassPanel className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-ix-muted">Client</p>
            <p className="mt-1 truncate text-lg font-semibold tracking-tight text-ix-text" data-testid="checkout-client">{clientName}</p>
          </div>
          <p className="rounded-full border border-ix-accent-text/30 bg-ix-butter/10 px-3 py-1 text-xs font-medium text-ix-accent-text" data-testid="checkout-currency">Prices in {currency}</p>
        </div>

        <div className="ix-inset overflow-hidden">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Products on this order. Only the per piece price can be edited.</caption>
            <thead className="max-sm:hidden text-[11px] uppercase tracking-wide text-ix-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Product</th>
                <th scope="col" className="px-3 py-3 font-medium">SKU</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Quantity</th>
                <th scope="col" className="px-3 py-3 font-medium">Unit</th>
                <th scope="col" className="w-56 px-3 py-3 font-medium">Per Piece Price</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Line Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ix-mist/10 max-sm:space-y-3 max-sm:divide-y-0 max-sm:p-3 max-sm:block">
              {rows.map((row, index) => {
                const problem = shown(row);
                const id = `price-${row.productId}`;
                const line = rowTotal(row);
                return (
                  <tr key={row.productId} data-product={row.productId} className="align-top max-sm:block max-sm:rounded-2xl max-sm:border max-sm:border-ix-mist/15 max-sm:bg-ix-deep/25 max-sm:p-4">
                    <td className="px-4 py-3 max-sm:block max-sm:p-0">
                      <div className="font-medium text-ix-text">{row.name}</div>
                      <div className="font-mono text-xs text-ix-accent-text sm:hidden">{row.sku}</div>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ix-accent-text max-sm:hidden">{row.sku}</td>
                    <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-ix-text max-sm:mt-2 max-sm:flex max-sm:justify-between max-sm:p-0 max-sm:text-sm" data-label="Quantity">
                      <span className="sm:hidden text-ix-muted">Quantity</span><span data-testid={`qty-${row.sku}`}>{qty(row.quantity)}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-ix-muted max-sm:flex max-sm:justify-between max-sm:p-0 max-sm:pt-1 max-sm:text-sm">
                      <span className="sm:hidden">Unit</span><span>{row.unit}</span>
                    </td>
                    <td className="px-3 py-3 max-sm:mt-3 max-sm:block max-sm:p-0">
                      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ix-muted sm:sr-only">Per piece price ({currency})</label>
                      <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="w-9 shrink-0 text-xs font-medium text-ix-muted">{currency}</span>
                        <input
                          id={id}
                          ref={index === 0 ? first : undefined}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          value={row.unitPrice}
                          disabled={busy}
                          placeholder="0.00"
                          aria-label={`Per piece price of ${row.name} in ${currency}`}
                          aria-invalid={problem ? true : undefined}
                          aria-describedby={problem ? `${id}-error` : undefined}
                          onChange={(e) => onPrice(row.productId, e.target.value)}
                          onBlur={() => setSeen((s) => ({ ...s, [row.productId]: true }))}
                          className={`block w-full min-w-0 text-right font-mono max-sm:min-h-12 max-sm:text-base ${problem ? "border-red-300/60" : ""}`}
                        />
                      </div>
                      {problem && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-300 sm:text-right">{problem}</p>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm tabular-nums text-ix-text max-sm:mt-3 max-sm:flex max-sm:justify-between max-sm:p-0 max-sm:pt-3 max-sm:border-t max-sm:border-ix-mist/10">
                      <span className="sm:hidden text-xs text-ix-muted">Line Total</span>
                      <span data-testid={`line-${row.sku}`}>{line ? formatMoney(line, currency) : "—"}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ix-mist/10 pt-4">
          <p role="status" className="text-xs text-ix-muted">
            {ready ? "Every product has a price. Nothing is saved or reserved until you press Save Order." : missing > 0 ? `Enter the price per piece for ${missing === rows.length ? "every product" : `the ${missing} product${missing === 1 ? "" : "s"} still without one`} to save the order.` : "Correct the highlighted prices to save the order."}
          </p>
          <p className="text-right max-sm:flex max-sm:w-full max-sm:items-baseline max-sm:justify-between">
            <span className="block text-xs font-medium uppercase tracking-[0.14em] text-ix-muted">Order Total</span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-ix-text" data-testid="order-total">{total ? formatMoney(total, currency) : "—"}</span>
          </p>
        </div>
      </GlassPanel>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <button type="button" onClick={onBack} disabled={busy} className={buttonClass.secondary}>Back to Products</button>
        <button type="button" onClick={onSave} disabled={busy || !ready} className={buttonClass.primary}>{busy ? "Saving…" : "Save Order"}</button>
      </div>
    </div>
  );
}

