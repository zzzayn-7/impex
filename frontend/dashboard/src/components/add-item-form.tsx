"use client";

import { FormEvent, useState } from "react";

import { DuplicateItem, STOCK_NOTICE, addDecimal, api, exceeds, jsonBody, qty, shortfall } from "@/lib/sales-browser";
import { validateQuantity } from "@/lib/stock-validation";

export type AddProduct = { id: string; name: string; sku: string; unit: string; unit_allows_fractions?: boolean };
export type AddStock = { total_quantity: string };

type Props = {
  listId: string;
  listNumber: string;
  product: AddProduct;
  stock: AddStock | null;
  /** Called after a line was added or changed. `itemCount` is the list's new number of lines. */
  onChanged: (info: { message: string; itemCount?: number }) => void;
};

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 font-mono text-base text-white placeholder-slate-500 outline-none transition focus:ring-1";

// Add ONE product to a draft delivery list with a quantity the user types. Nothing here changes inventory, and nothing is
// ever incremented automatically: if the product is already on the list the user is told so and chooses explicitly
// between setting the quantity, increasing it, or leaving it alone.
export default function AddItemForm({ listId, listNumber, product, stock, onChanged }: Props) {
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateItem | null>(null);

  const allowsFractions = product.unit_allows_fractions ?? false;
  const clean = quantity.trim();
  const problem = clean ? validateQuantity(clean, allowsFractions, product.unit) : undefined;
  const valid = Boolean(clean) && !problem;
  const available = stock?.total_quantity ?? null;
  const tooMuch = valid && available !== null && exceeds(clean, available);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setDuplicate(null);
    const found = validateQuantity(clean, allowsFractions, product.unit);
    if (found) return setError(found);
    setBusy(true);
    const r = await api(`/api/sales/delivery-lists/${listId}/items`, { method: "POST", ...jsonBody({ productId: product.id, quantity: clean }) });
    setBusy(false);
    if (r.ok) {
      setQuantity("");
      return onChanged({ message: `Added ${qty(clean)} ${product.unit} of ${product.name} to ${listNumber}.`, itemCount: r.data?.item_count });
    }
    if (r.status === 409 && r.code === "duplicate_item" && r.item) return setDuplicate(r.item);
    setError(r.error);
  }

  async function resolveDuplicate(how: "set" | "increase") {
    if (busy || !duplicate) return;
    setBusy(true);
    setError(null);
    const url = `/api/sales/delivery-lists/${listId}/items/${duplicate.id}`;
    const r = how === "set" ? await api(url, { method: "PATCH", ...jsonBody({ quantity: clean }) }) : await api(`${url}/increase`, { method: "POST", ...jsonBody({ quantity: clean }) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const total = r.data?.item?.quantity ?? clean;
    setDuplicate(null);
    setQuantity("");
    onChanged({ message: `${product.name} on ${listNumber} is now ${qty(total)} ${product.unit}.`, itemCount: r.data?.item_count });
  }

  return (
    <form onSubmit={submit} noValidate aria-label={`Add ${product.name} to ${listNumber}`} className="space-y-3">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5 text-sm">
        <p className="text-slate-200">
          <span className="font-semibold text-white">{product.name}</span> <span className="font-mono text-xs text-indigo-300">{product.sku}</span>
        </p>
        <p className="mt-0.5 text-xs text-slate-400">
          Unit: {product.unit} · {allowsFractions ? "decimal quantities allowed" : "whole numbers only"}
        </p>
        {stock ? (
          <p className="mt-1 text-xs text-slate-300" data-testid="availability">
            In stock now: <span className="font-mono font-semibold text-emerald-400">{qty(stock.total_quantity)} {product.unit}</span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">Current stock could not be loaded.</p>
        )}
      </div>

      <label className="block text-xs font-medium text-slate-400">
        Quantity to deliver ({product.unit})
        <input
          value={quantity}
          onChange={(e) => { setQuantity(e.target.value); setDuplicate(null); setError(null); }}
          inputMode={allowsFractions ? "decimal" : "numeric"}
          autoComplete="off"
          placeholder={allowsFractions ? "e.g. 2.5" : "e.g. 10"}
          aria-invalid={Boolean(problem)}
          className={`${inputClass} ${problem ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"}`}
        />
        {problem && <span role="alert" className="mt-1 block text-xs text-red-400">{problem}</span>}
      </label>

      {tooMuch && available !== null && (
        <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {qty(clean)} {product.unit} is more than the {qty(available)} {product.unit} available now (short by {qty(shortfall(clean, available))}). You can still add it, but the stock
          is not reserved and may not be there at dispatch.
        </p>
      )}

      {error && <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      {duplicate && (
        <div role="alertdialog" aria-label="Already on this list" className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm text-amber-100">
            {duplicate.product_name} is already on {listNumber} with <span className="font-mono font-semibold">{qty(duplicate.quantity)} {duplicate.unit}</span>. Nothing was changed. What would you like to do?
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button type="button" disabled={busy || !valid} onClick={() => resolveDuplicate("set")} className="min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50">
              Set quantity to {qty(clean)} {product.unit}
            </button>
            <button type="button" disabled={busy || !valid} onClick={() => resolveDuplicate("increase")} className="min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-50">
              Increase by {qty(clean)} (to {qty(addDecimal(duplicate.quantity, clean))} {duplicate.unit})
            </button>
            <button type="button" onClick={() => setDuplicate(null)} className="min-h-11 rounded-lg px-3 py-2 text-sm text-slate-300 hover:text-white">Leave it as it is</button>
          </div>
        </div>
      )}

      <button type="submit" disabled={busy || !clean} className="min-h-12 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto">
        {busy ? "Adding…" : "Add to delivery list"}
      </button>
      <p className="text-xs text-slate-500">{STOCK_NOTICE}</p>
    </form>
  );
}
