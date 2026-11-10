"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import QuantityInput from "@/components/ui/quantity-input";
import {
  EMPTY_PRODUCT,
  Product,
  ProductFieldErrors,
  ProductFormValues,
  normalizeProduct,
  productToForm,
  validateProduct,
} from "@/lib/product-validation";
import { isZero } from "@/lib/quantity";
import { normalizeScanned } from "@/lib/scan";
import { postStockChange } from "@/lib/stock-browser";
import { QUANTITY_RE, newIdempotencyKey } from "@/lib/stock-validation";

// ONE product form, used wherever a product is registered or corrected: the Stock page's product dialog and the purchase order's "Add New Product".
// It talks to the portal's own /api/products routes (the Inventory Service stays the only place products are stored); it can never name an organization.
//
//   * Adding sends the whole product; editing sends only what changed.
//   * Registering a product does NOT put anything in stock: stock changes only through stock movements and confirmed goods receipts.
//   * The unit of a product that already has stock movements is locked (the Inventory Service refuses to change it too).
//   * `withOpeningQuantity` adds an optional "Existing Stock / Opening Quantity" section when adding (the Stock page's "Add Stock"). A quantity above zero is
//     recorded AFTER the product exists, through the existing Opening Balance endpoint with its own Idempotency-Key; zero or empty records nothing (no
//     artificial movement). Registering the product and recording the quantity are two separate operations: if the second fails the product still exists,
//     and the caller gets the outcome (with the key) so it can offer a safe retry instead of creating the product again.
//   * `withBarcode` adds an optional "Barcode (if the goods carry one)" box when adding: it is registered as the product's manufacturer barcode right after the
//     product is created (a barcode that already identifies another product is reported and the product is kept).

/** What happened to the optional opening quantity (only present when one above zero was entered). */
export type OpeningOutcome = { quantity: string; key: string; recorded: boolean; replayed: boolean; status?: number; error?: string };

type Props = {
  product?: Product; // present = editing, absent = adding
  onDone: (message: string) => void;
  onCancel: () => void;
  /** Called with the saved product (before `onDone`), so a caller can carry on with it, for example by adding it to a purchase order. */
  onSaved?: (product: Product, notes: { barcodeProblem?: string; opening?: OpeningOutcome }) => void;
  /** Starting values for a NEW product (the order's currency, a SKU that was searched for, ...). */
  defaults?: Partial<ProductFormValues>;
  /** Offer the optional barcode box (adding only). */
  withBarcode?: boolean;
  /** Offer the optional "Existing Stock / Opening Quantity" section (adding only). */
  withOpeningQuantity?: boolean;
  /** Inside a dialog: no card of its own and no heading (the dialog has them). */
  embedded?: boolean;
  /** Text of the submit button when adding. */
  addLabel?: string;
};

const COMMON_UNITS = ["pcs", "kg", "g", "l", "m", "box", "pallet"];
const bad = "!border-red-400/60 focus:!border-red-400 focus:!ring-red-400/20";

export default function ProductForm({ product, onDone, onCancel, onSaved, defaults, withBarcode = false, withOpeningQuantity = false, embedded = false, addLabel = "Add product" }: Props) {
  const router = useRouter();
  const editing = Boolean(product);
  const initial = product ? productToForm(product) : { ...EMPTY_PRODUCT, ...(defaults ?? {}) };
  const [values, setValues] = useState<ProductFormValues>(initial);
  const [barcode, setBarcode] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | undefined>();
  const [opening, setOpening] = useState("");
  const [openingError, setOpeningError] = useState<string | undefined>();
  const [errors, setErrors] = useState<ProductFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update(field: keyof ProductFormValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);

    const normalized = normalizeProduct(values);
    const found = validateProduct(normalized);
    setErrors(found);
    let code: string | null = null;
    if (!editing && withBarcode && barcode.trim()) {
      const checked = normalizeScanned(barcode);
      if (!checked.ok) { setBarcodeError(checked.message); return; }
      code = checked.code;
    }
    setBarcodeError(undefined);
    // The opening quantity: empty or zero means "none" (no movement is recorded); anything else must be a valid positive quantity. Whether it may have a
    // fraction depends on the unit, which only the Inventory Service judges, so that rule comes back from the service when the quantity is recorded.
    let openingQuantity: string | null = null;
    if (!editing && withOpeningQuantity) {
      const typed = opening.trim();
      if (typed) {
        // the FORMAT first (isZero would read "abc" as zero and silently drop what was typed); then zero means "none"
        if (!QUANTITY_RE.test(typed)) { setOpeningError("Use a positive number with at most 4 decimals, e.g. 35 or 2.5."); return; }
        if (!isZero(typed)) openingQuantity = typed;
      }
    }
    setOpeningError(undefined);
    if (Object.keys(found).length > 0) return;

    // Editing sends only what changed. Adding sends the whole product. Neither can name an organization.
    let body: unknown;
    if (editing) {
      const original = normalizeProduct(initial);
      const changed: Partial<ProductFormValues> = {};
      for (const key of Object.keys(normalized) as (keyof ProductFormValues)[]) {
        if (normalized[key] !== original[key]) changed[key] = normalized[key];
      }
      if (Object.keys(changed).length === 0) return onDone("No changes to save.");
      body = changed;
    } else {
      // a new product is sent without a selling price (retired: each client's price is agreed on their sales order)
      const { sellingPrice: _retired, ...rest } = normalized;
      body = rest;
    }

    setLoading(true);
    try {
      const res = await fetch(editing ? `/api/products/${product!.id}` : "/api/products", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setFormError(data?.error ?? "Could not save the product. Please try again.");
        if (data?.fieldErrors) setErrors(data.fieldErrors);
        return;
      }
      const saved: Product = data.product;
      let barcodeProblem: string | undefined;
      if (code) {
        // The product exists now. A barcode that cannot be registered (it already identifies another product) does not undo that.
        try {
          const registered = await fetch(`/api/products/${saved.id}/identifiers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "manufacturer", value: code }),
          });
          if (!registered.ok) barcodeProblem = (await registered.json().catch(() => null))?.error ?? "The barcode could not be registered.";
        } catch {
          barcodeProblem = "The barcode could not be registered. Open the product to add it.";
        }
      }
      // The opening quantity, through the existing Opening Balance endpoint. The product exists now: whatever happens here never undoes or repeats it.
      let outcome: OpeningOutcome | undefined;
      if (openingQuantity) {
        const key = newIdempotencyKey();
        const posted = await postStockChange("opening", { product_id: saved.id, quantity: openingQuantity }, key);
        if (!posted.ok && posted.unauthorized) { router.replace("/login"); router.refresh(); return; }
        outcome = posted.ok
          ? { quantity: openingQuantity, key, recorded: true, replayed: posted.replayed }
          : { quantity: openingQuantity, key, recorded: false, replayed: false, status: posted.status, error: posted.message };
      }
      onSaved?.(saved, { barcodeProblem, opening: outcome });
      const base = editing ? `Saved changes to ${saved.name}.` : `Added ${saved.name} (${saved.sku}).`;
      const stock = outcome ? (outcome.recorded ? ` ${outcome.quantity} ${saved.unit} recorded as the opening balance.` : ` The opening quantity was not recorded: ${outcome.error}`) : "";
      onDone(`${base}${barcodeProblem ? ` The barcode was not registered: ${barcodeProblem}` : ""}${stock}`);
    } catch {
      setFormError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  function field(id: keyof ProductFormValues, label: string, props: React.InputHTMLAttributes<HTMLInputElement> & { hint?: string; optional?: boolean }) {
    const { hint, optional, ...inputProps } = props;
    const error = errors[id];
    return (
      <div>
        <label htmlFor={`product-${id}`} className="block text-xs font-medium text-ix-muted">
          {label}
          {optional && <span className="ml-1 text-ix-muted/70">(optional)</span>}
        </label>
        <input
          id={`product-${id}`}
          value={values[id]}
          onChange={(e) => update(id, e.target.value)}
          disabled={loading}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `product-${id}-error` : hint ? `product-${id}-hint` : undefined}
          className={`${fieldClass} ${error ? bad : ""}`}
          {...inputProps}
        />
        {error ? (
          <p id={`product-${id}-error`} className="mt-1.5 text-xs text-red-300">{error}</p>
        ) : (
          hint && <p id={`product-${id}-hint`} className="mt-1.5 text-xs text-ix-muted/80">{hint}</p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className={embedded ? "space-y-5" : "ix-panel space-y-5 p-6"}
      aria-label={editing ? "Edit product" : "Add product"}
    >
      {!embedded && (
        <div>
          <h2 className="text-base font-semibold text-ix-text">{editing ? `Edit ${product!.name}` : "Add Product"}</h2>
          <p className="text-xs text-ix-muted">
            {editing ? "Change any field and save. The product always stays in your organization." : "The product is added to your organization's catalog."}
          </p>
        </div>
      )}

      {formError && (
        <div role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{formError}</div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {field("sku", "SKU or product code", { type: "text", placeholder: "WID-001", autoComplete: "off", maxLength: 64, hint: "Unique in your catalog. Stored in capitals." })}
        <div className="md:col-span-2">
          {field("name", "Product name", { type: "text", placeholder: "Stainless steel bolt M10", autoComplete: "off", maxLength: 255 })}
        </div>
        <div className="md:col-span-3">
          <label htmlFor="product-description" className="block text-xs font-medium text-ix-muted">
            Description <span className="ml-1 text-ix-muted/70">(optional)</span>
          </label>
          <textarea
            id="product-description"
            rows={2}
            value={values.description}
            onChange={(e) => update("description", e.target.value)}
            disabled={loading}
            maxLength={2000}
            aria-invalid={errors.description ? true : undefined}
            className={`${fieldClass} ${errors.description ? bad : ""}`}
          />
          {errors.description && <p className="mt-1.5 text-xs text-red-300">{errors.description}</p>}
        </div>
        {field("unit", "Unit of measurement", {
          type: "text", list: "unit-options", placeholder: "pcs", autoComplete: "off", maxLength: 20,
          // Once a product has stock movements its unit is part of what every recorded quantity means: it cannot change.
          ...(product?.unit_locked ? { disabled: true, hint: "Locked: this product already has stock movements, so its unit can no longer change." } : {}),
        })}
        {field("hsCode", "HS code", { type: "text", placeholder: "7318.15", autoComplete: "off", maxLength: 16, optional: true, hint: "Customs tariff code, e.g. 8517.12.00." })}
        {withBarcode && !editing && (
          <div>
            <label htmlFor="product-barcode" className="block text-xs font-medium text-ix-muted">
              Barcode <span className="ml-1 text-ix-muted/70">(if the goods carry one)</span>
            </label>
            <input
              id="product-barcode"
              value={barcode}
              onChange={(e) => { setBarcode(e.target.value); setBarcodeError(undefined); }}
              disabled={loading}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
              placeholder="Type, or scan into this box"
              aria-invalid={barcodeError ? true : undefined}
              aria-describedby="product-barcode-hint"
              className={`${fieldClass} font-mono ${barcodeError ? bad : ""}`}
            />
            <p id="product-barcode-hint" className={`mt-1.5 text-xs ${barcodeError ? "text-red-300" : "text-ix-muted/80"}`}>{barcodeError ?? "The manufacturer's barcode, so scanning it finds this product."}</p>
          </div>
        )}
        {field("costPrice", "Cost price", { type: "text", inputMode: "decimal", placeholder: "12.50", autoComplete: "off", hint: "What it normally costs you. Up to 4 decimals. The price you charge is agreed with each client when you create their order." })}
        {field("currencyCode", "Currency", { type: "text", placeholder: "USD", maxLength: 3, autoComplete: "off", hint: "3-letter code, e.g. USD, EUR.", style: { textTransform: "uppercase" } })}
      </div>
      {withOpeningQuantity && !editing && (
        <section aria-labelledby="opening-quantity-heading" className="space-y-2 rounded-2xl border border-ix-mist/15 bg-ix-mist/5 p-4">
          <h3 id="opening-quantity-heading" className="text-sm font-semibold text-ix-text">Existing Stock / Opening Quantity</h3>
          <p id="opening-quantity-help" className="text-xs text-ix-muted">
            Enter a quantity only if your organization already owns these goods. For new purchases, quantities are added when Goods Receipts are confirmed.
          </p>
          <label htmlFor="product-opening-quantity" className="block text-xs font-medium text-ix-muted">
            Opening quantity <span className="ml-1 text-ix-muted/70">(optional{values.unit.trim() ? `, counted in ${values.unit.trim()}` : ""})</span>
          </label>
          <QuantityInput
            id="product-opening-quantity"
            aria-label="Opening quantity"
            aria-describedby="opening-quantity-help"
            aria-invalid={openingError ? true : undefined}
            value={opening}
            onChange={(v) => { setOpening(v); setOpeningError(undefined); }}
            inputMode="decimal"
            disabled={loading}
            className="w-full max-w-xs"
          />
          {openingError ? (
            <p role="alert" className="text-xs text-red-300">{openingError}</p>
          ) : (
            <p className="text-xs text-ix-muted/80">Leave it at 0 and no stock movement is recorded: the product is simply ready for purchasing and sales.</p>
          )}
        </section>
      )}
      <datalist id="unit-options">{COMMON_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      {!editing && (
        <p className="text-xs text-ix-muted">
          {withOpeningQuantity
            ? "Registering a product adds no stock by itself: stock comes from the opening quantity above (goods you already own) or from confirmed goods receipts."
            : "Registering a product does not add any stock: stock only increases when you confirm a goods receipt (or record stock in Stock)."}
        </p>
      )}

      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} disabled={loading} className={buttonClass.secondary}>Cancel</button>
        <button type="submit" disabled={loading} className={buttonClass.primary}>
          {loading && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-ix-on-accent/25 border-t-ix-on-accent motion-reduce:animate-none" />}
          {loading ? "Saving…" : editing ? "Save changes" : addLabel}
        </button>
      </div>
    </form>
  );
}
