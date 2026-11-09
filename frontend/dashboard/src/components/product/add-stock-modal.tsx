"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import QuantityInput from "@/components/ui/quantity-input";
import type { Product } from "@/lib/product-validation";
import { isZero } from "@/lib/quantity";
import { postStockChange } from "@/lib/stock-browser";
import { QUANTITY_RE, newIdempotencyKey } from "@/lib/stock-validation";
import ProductForm from "./product-form";

// ADD STOCK (the Stock page's top-level button): REGISTER A NEW PRODUCT, and optionally record the quantity the organization already owns.
//
// It is the same product form and the same product API as everywhere else (no second registration system), plus one optional section. Two OPERATIONS, never
// pretended to be one:
//   1. the product is created in the Inventory Service (a duplicate SKU is refused there and nothing else happens);
//   2. if an opening quantity above zero was entered, it is recorded through the existing Opening Balance endpoint, with its own Idempotency-Key.
// A quantity of zero (or none) records nothing: no artificial movement. If step 2 fails the product exists, so this dialog switches to a plain partial-success
// panel that remembers the product (it is never created a second time) and lets the administrator retry the quantity. Retrying with the same quantity reuses
// the same key (the service applies it once, however often it is sent); and even a different key cannot double-count, because the service accepts an opening
// balance only before the product has any other stock movement.
// Goods bought from now on are NOT entered here: they arrive through Purchase Order -> confirmed Goods Receipt.

const ONLY_ONCE = "Pressing the button again can never count the quantity twice.";

type Held = { product: Product; quantity: string; key: string; error: string; blocked: boolean };

export default function AddStockModal({ onClose, onDone, onProductAdded }: {
  onClose: () => void;
  /** The whole operation is finished (the message says what happened): the page closes the dialog and shows it. */
  onDone: (message: string) => void;
  /** The product exists now: the page behind re-reads its table even while this dialog stays open on a partial result. */
  onProductAdded?: () => void;
}) {
  const router = useRouter();
  const [held, setHeld] = useState<Held | null>(null);
  const holding = useRef(false); // set while the opening quantity is unresolved, so the form's own "done" does not close the dialog
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ quantity: string; key: string } | null>(null);

  const later = (product: Product) => `Added ${product.name} (${product.sku}) with no stock yet. Use Opening Balance to record its starting quantity.`;

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
    const posted = await postStockChange("opening", { product_id: held.product.id, quantity: typed }, attempt.current.key);
    setBusy(false);
    if (posted.ok) {
      onDone(`Added ${held.product.name} (${held.product.sku}). ${posted.replayed ? "That quantity had already been recorded; nothing was counted twice." : `${typed} ${held.product.unit} recorded as the opening balance.`}`);
      return;
    }
    if (posted.unauthorized) { router.replace("/login"); router.refresh(); return; }
    const blocked = posted.status === 409 && /stock history/i.test(posted.message);
    setError(posted.message);
    if (blocked) setHeld({ ...held, error: posted.message, blocked: true });
  }

  return (
    <Modal
      title="Add Product to Stock"
      subtitle={held ? "The product is registered; its opening quantity still needs recording." : "Register a new product. Record a quantity only if you already own these goods; purchases are added by confirming goods receipts."}
      onClose={() => (held ? onDone(later(held.product)) : onClose())}
      dismissable={!busy}
      size="lg"
    >
      {held ? (
        <div className="space-y-4">
          <div role="alert" className="space-y-1 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
            <p className="font-semibold">{held.product.name} ({held.product.sku}) was registered, but its opening quantity was not recorded.</p>
            <p>{held.error}</p>
            <p className="text-xs">
              {held.blocked
                ? "This product already has stock history, so its opening quantity may already be recorded. Check the Stock table before doing anything else."
                : `The product exists and will not be created again. Nothing was counted yet. ${ONLY_ONCE}`}
            </p>
          </div>
          {!held.blocked && (
            <div>
              <label htmlFor="retry-opening-quantity" className="block text-xs font-medium text-ix-muted">Opening quantity ({held.product.unit})</label>
              <QuantityInput id="retry-opening-quantity" aria-label="Opening quantity" value={quantity} onChange={(v) => { setQuantity(v); setError(null); }} inputMode="decimal" disabled={busy} className="mt-1.5 w-full max-w-xs" />
              {error && error !== held.error && <p role="alert" className="mt-1.5 text-xs text-red-300">{error}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => onDone(later(held.product))} disabled={busy} className={buttonClass.secondary}>{held.blocked ? "Done" : "Record it later"}</button>
            {!held.blocked && <button type="button" onClick={retry} disabled={busy} className={buttonClass.primary}>{busy ? "Recording…" : "Record opening quantity"}</button>}
          </div>
        </div>
      ) : (
        <ProductForm
          embedded
          withBarcode
          withOpeningQuantity
          addLabel="Add product"
          onCancel={onClose}
          onSaved={(product, notes) => {
            onProductAdded?.();
            const opening = notes.opening;
            if (opening && !opening.recorded) {
              holding.current = true;
              attempt.current = { quantity: opening.quantity, key: opening.key };
              setQuantity(opening.quantity);
              setHeld({ product, quantity: opening.quantity, key: opening.key, error: opening.error ?? "The quantity could not be recorded.", blocked: opening.status === 409 && /stock history/i.test(opening.error ?? "") });
            }
          }}
          onDone={(message) => { if (!holding.current) onDone(message); }}
        />
      )}
    </Modal>
  );
}
