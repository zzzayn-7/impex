"use client";

import { FormEvent, useState } from "react";

import { NO_STOCK_NOTICE, lineTotal, validatePrice } from "@/lib/purchasing-browser";
import { api, jsonBody, qty } from "@/lib/sales-browser";
import { formatMoney } from "@/lib/product-validation";
import { validateQuantity } from "@/lib/stock-validation";
import QuantityInput from "@/components/ui/quantity-input";

export type OrderProduct = { id: string; name: string; sku: string; unit: string; unit_allows_fractions?: boolean };

type Props = {
  orderId: string;
  orderNumber: string;
  currency: string;
  product: OrderProduct;
  /** A suggested unit purchase price (a new product's cost price); the administrator can change it. */
  initialPrice?: string;
  /** Called after the line was added; `existingLineId` is set when the product was already on the order. */
  onAdded: (message: string) => void;
  onDuplicate: (lineId: string) => void;
};

const inputClass = "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 font-mono text-base text-white placeholder-slate-500 outline-none transition focus:ring-1";
const border = (error?: string) => (error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500");

// Add ONE existing product to a draft purchase order with the ordered quantity and the unit purchase price. The preview of the
// line total is only a convenience while typing: the Purchasing Service calculates the real one. Nothing here changes stock,
// and the purchase price never touches the product's own prices.
export default function AddLineForm({ orderId, orderNumber, currency, product, initialPrice, onAdded, onDuplicate }: Props) {
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState(initialPrice ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowsFractions = product.unit_allows_fractions ?? false;
  const q = quantity.trim();
  const p = price.trim();
  const quantityProblem = q ? validateQuantity(q, allowsFractions, product.unit) : undefined;
  const priceProblem = p ? validatePrice(p) : undefined;
  const preview = q && p && !quantityProblem && !priceProblem ? lineTotal(q, p) : null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const qProblem = validateQuantity(q, allowsFractions, product.unit);
    const pProblem = validatePrice(p);
    if (qProblem || pProblem) return setError(qProblem ?? pProblem ?? null);
    setBusy(true);
    const r = await api(`/api/purchasing/purchase-orders/${orderId}/lines`, {
      method: "POST",
      ...jsonBody({ productId: product.id, quantity: q, unitPrice: p, notes }),
    });
    setBusy(false);
    if (r.ok) {
      onAdded(`Added ${qty(q)} ${product.unit} of ${product.name} to ${orderNumber}.`);
      return;
    }
    if (r.status === 409 && r.code === "duplicate_line" && r.line) {
      setError(r.error);
      return onDuplicate(r.line.id);
    }
    setError(r.error);
  }

  return (
    <form onSubmit={submit} noValidate aria-label={`Add ${product.name} to ${orderNumber}`} className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-sm">
        <p className="text-slate-200"><span className="font-semibold text-white">{product.name}</span> <span className="font-mono text-xs text-indigo-300">{product.sku}</span></p>
        <p className="mt-0.5 text-xs text-slate-400">Unit: {product.unit} · {allowsFractions ? "decimal quantities allowed" : "whole numbers only"}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="block text-xs font-medium text-slate-400">
          <label htmlFor="order-line-quantity" className="block">Quantity to order ({product.unit})</label>
          <QuantityInput id="order-line-quantity" value={quantity} onChange={setQuantity} inputMode={allowsFractions ? "decimal" : "numeric"} aria-invalid={Boolean(quantityProblem)} className="mt-1.5" />
          {quantityProblem && <span role="alert" className="mt-1 block text-xs text-red-400">{quantityProblem}</span>}
        </div>
        <label className="block text-xs font-medium text-slate-400">
          Unit purchase price ({currency})
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" autoComplete="off" aria-invalid={Boolean(priceProblem)} placeholder="e.g. 1.25"
            className={`${inputClass} ${border(priceProblem)}`} />
          {priceProblem && <span role="alert" className="mt-1 block text-xs text-red-400">{priceProblem}</span>}
        </label>
      </div>

      <label className="block text-xs font-medium text-slate-400">
        Line note (optional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500" />
      </label>

      <p className="text-sm text-slate-300" data-testid="line-preview">
        Line total: <span className="font-mono font-semibold text-white">{preview ? formatMoney(preview, currency) : "—"}</span>
        <span className="ml-2 text-xs text-slate-500">(calculated again by the server when you add it)</span>
      </p>

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <button type="submit" disabled={busy || !q || !p} className="min-h-12 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto">
        {busy ? "Adding…" : "Add to order"}
      </button>
      <p className="text-xs text-slate-500">{NO_STOCK_NOTICE}</p>
    </form>
  );
}
