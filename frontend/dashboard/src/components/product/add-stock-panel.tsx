"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import QuantityInput from "@/components/ui/quantity-input";
import type { Product } from "@/lib/product-validation";
import { isZero } from "@/lib/quantity";
import { postStockChange } from "@/lib/stock-browser";
import { QUANTITY_RE, newIdempotencyKey } from "@/lib/stock-validation";
import ProductForm from "./product-form";

// ADD STOCK (the Stock page's top-level button): REGISTER A NEW PRODUCT, and optionally enter the quantity the organization already owns (as a Stock In). It opens as a form on the
// page itself, drawn like the Add Client and Purchase Order forms (not in a dialog).
//
// It is the same product form and the same product API as everywhere else (no second registration system), plus one optional box. Two OPERATIONS, never
// pretended to be one:
//   1. the product is created in the Inventory Service (a duplicate SKU is refused there and nothing else happens);
//   2. if a quantity above zero was entered, it is recorded as a Stock In (the one way stock is entered by hand), with its own Idempotency-Key.
// A quantity of zero (or none) records nothing: no artificial movement. If step 2 fails the product exists, so this panel switches to a plain partial-success
// notice that remembers the product (it is never created a second time) and lets the administrator retry the quantity. Retrying with the same quantity reuses
// the same key (the service applies it once, however often it is sent). A DIFFERENT quantity is a new request with a new key: check the Stock table first if the first
// answer may have been lost.
// Goods bought from now on are NOT entered here: they arrive through Purchase Order -> confirmed Goods Receipt.

const ONLY_ONCE = "Pressing the button again can never count the quantity twice.";

type Held = { product: Product; quantity: string; key: string; error: string };

const cardClass = "space-y-4 rounded-xl border border-indigo-500/30 bg-slate-900/60 p-4 sm:p-5";
const secondaryButton = "min-h-10 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-60";
const primaryButton = "min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60";

export default function AddStockPanel({ onClose, onDone, onProductAdded }: {
  onClose: () => void;
  /** The whole operation is finished (the message says what happened): the page closes the panel and shows it. */
  onDone: (message: string) => void;
  /** The product exists now: the page behind re-reads its table even while this panel stays open on a partial result. */
  onProductAdded?: () => void;
}) {
  const router = useRouter();
  const [held, setHeld] = useState<Held | null>(null);
  const holding = useRef(false); // set while the quantity is unresolved, so the form's own "done" does not close the panel
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ quantity: string; key: string } | null>(null);

  const later = (product: Product) => `Added ${product.name} (${product.sku}) with no stock yet. Use Stock In to add its first quantity.`;

  async function retry() {
    if (!held || busy) return;
    const typed = quantity.trim();
    if (!typed) { setError("Enter the quantity you already own, or choose Record it later."); return; }
    if (!QUANTITY_RE.test(typed)) { setError("Use a positive number with at most 4 decimals, e.g. 35 or 2.5."); return; }
    if (isZero(typed)) { setError("Enter the quantity you already own (more than zero), or choose Record it later."); return; }
    // Same quantity -> same key (a retry can never be counted twice). A different quantity is a different request, so it gets a new key.
    if (!attempt.current || attempt.current.quantity !== typed) attempt.current = { quantity: typed, key: typed === held.quantity ? held.key : newIdempotencyKey() };
    setBusy(true);
    setError(null);
    const posted = await postStockChange("in", { product_id: held.product.id, quantity: typed }, attempt.current.key);
    setBusy(false);
    if (posted.ok) {
      onDone(`Added ${held.product.name} (${held.product.sku}). ${posted.replayed ? "That quantity had already been recorded; nothing was counted twice." : `${typed} ${held.product.unit} added to stock.`}`);
      return;
    }
    if (posted.unauthorized) { router.replace("/login"); router.refresh(); return; }
    setError(posted.message);
  }

  // One stable container for both states (the form, then the partial-success notice), so the page and the tests have one thing to point at.
  if (held) {
    return (
      <section aria-label="Add Product to Stock" className={cardClass}>
        <h3 className="text-sm font-semibold text-white">New product</h3>
        <div role="alert" className="space-y-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          <p className="font-semibold">{held.product.name} ({held.product.sku}) was registered, but its quantity was not added to stock.</p>
          <p>{held.error}</p>
          <p className="text-xs">The product exists and will not be created again. Nothing was counted yet. {ONLY_ONCE}</p>
        </div>
        <div>
          <label htmlFor="retry-quantity" className="block text-xs font-medium text-slate-400">Quantity ({held.product.unit})</label>
          <QuantityInput id="retry-quantity" aria-label="Quantity" value={quantity} onChange={(v) => { setQuantity(v); setError(null); }} inputMode="decimal" disabled={busy} className="mt-1.5 w-full max-w-xs" />
          {error && error !== held.error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={() => onDone(later(held.product))} disabled={busy} className={secondaryButton}>Record it later</button>
          <button type="button" onClick={retry} disabled={busy} className={primaryButton}>{busy ? "Recording…" : "Record stock in"}</button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Add Product to Stock">
    <ProductForm
      panel
      withBarcode
      withQuantity
      addLabel="Add product"
      onCancel={onClose}
      onSaved={(product, notes) => {
        onProductAdded?.();
        const stockIn = notes.stockIn;
        if (stockIn && !stockIn.recorded) {
          holding.current = true;
          attempt.current = { quantity: stockIn.quantity, key: stockIn.key };
          setQuantity(stockIn.quantity);
          setHeld({ product, quantity: stockIn.quantity, key: stockIn.key, error: stockIn.error ?? "The quantity could not be recorded." });
        }
      }}
      onDone={(message) => { if (!holding.current) onDone(message); }}
    />
    </section>
  );
}
