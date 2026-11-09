"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClass, fieldClass } from "@/components/ui/controls";
import {
  EMPTY_PRODUCT,
  Product,
  ProductFieldErrors,
  ProductFormValues,
  normalizeProduct,
  productToForm,
  validateProduct,
} from "@/lib/product-validation";
import { normalizeScanned } from "@/lib/scan";

// ONE product form, used wherever a product is registered or corrected: the Stock page's product dialog and the purchase order's "Add New Product".
// It talks to the portal's own /api/products routes (the Inventory Service stays the only place products are stored); it can never name an organization.
//
//   * Adding sends the whole product; editing sends only what changed.
//   * Registering a product does NOT put anything in stock: stock changes only through stock movements and confirmed goods receipts.
//   * The unit of a product that already has stock movements is locked (the Inventory Service refuses to change it too).
//   * `withBarcode` adds an optional "Barcode (if the goods carry one)" box when adding: it is registered as the product's manufacturer barcode right after the
//     product is created (a barcode that already identifies another product is reported and the product is kept).

type Props = {
  product?: Product; // present = editing, absent = adding
  onDone: (message: string) => void;
  onCancel: () => void;
  /** Called with the saved product (before `onDone`), so a caller can carry on with it, for example by adding it to a purchase order. */
  onSaved?: (product: Product, notes: { barcodeProblem?: string }) => void;
  /** Starting values for a NEW product (the order's currency, a SKU that was searched for, ...). */
  defaults?: Partial<ProductFormValues>;
  /** Offer the optional barcode box (adding only). */
  withBarcode?: boolean;
  /** Inside a dialog: no card of its own and no heading (the dialog has them). */
  embedded?: boolean;
  /** Text of the submit button when adding. */
  addLabel?: string;
};

const COMMON_UNITS = ["pcs", "kg", "g", "l", "m", "box", "pallet"];
const bad = "!border-red-400/60 focus:!border-red-400 focus:!ring-red-400/20";

export default function ProductForm({ product, onDone, onCancel, onSaved, defaults, withBarcode = false, embedded = false, addLabel = "Add product" }: Props) {
  const router = useRouter();
  const editing = Boolean(product);
  const initial = product ? productToForm(product) : { ...EMPTY_PRODUCT, ...(defaults ?? {}) };
  const [values, setValues] = useState<ProductFormValues>(initial);
  const [barcode, setBarcode] = useState("");
  const [barcodeError, setBarcodeError] = useState<string | undefined>();
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
      body = normalized;
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
      onSaved?.(saved, { barcodeProblem });
      const base = editing ? `Saved changes to ${saved.name}.` : `Added ${saved.name} (${saved.sku}).`;
      onDone(barcodeProblem ? `${base} The barcode was not registered: ${barcodeProblem}` : base);
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
        {field("costPrice", "Cost price", { type: "text", inputMode: "decimal", placeholder: "12.50", autoComplete: "off", hint: "What it normally costs you. Up to 4 decimals." })}
        {field("sellingPrice", "Selling price", { type: "text", inputMode: "decimal", placeholder: "19.99", autoComplete: "off", hint: "What you sell it for. Up to 4 decimals." })}
        {field("currencyCode", "Currency", { type: "text", placeholder: "USD", maxLength: 3, autoComplete: "off", hint: "3-letter code, e.g. USD, EUR.", style: { textTransform: "uppercase" } })}
      </div>
      <datalist id="unit-options">{COMMON_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      {!editing && <p className="text-xs text-ix-muted">Registering a product does not add any stock: stock only increases when you confirm a goods receipt (or record stock in Stock).</p>}

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
