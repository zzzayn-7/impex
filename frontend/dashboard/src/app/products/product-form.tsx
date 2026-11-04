"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import {
  EMPTY_PRODUCT,
  Product,
  ProductFieldErrors,
  ProductFormValues,
  normalizeProduct,
  productToForm,
  validateProduct,
} from "@/lib/product-validation";

type Props = {
  product?: Product; // present = editing, absent = adding
  categories: string[];
  onDone: (message: string) => void;
  onCancel: () => void;
};

const inputClass =
  "mt-1.5 block w-full rounded-lg border bg-slate-950 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:ring-1 disabled:opacity-60";
const COMMON_UNITS = ["pcs", "kg", "g", "l", "m", "box", "pallet"];

export default function ProductForm({ product, categories, onDone, onCancel }: Props) {
  const router = useRouter();
  const editing = Boolean(product);
  const initial = product ? productToForm(product) : EMPTY_PRODUCT;
  const [values, setValues] = useState<ProductFormValues>(initial);
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
      onDone(editing ? `Saved changes to ${data.product.name}.` : `Added ${data.product.name} (${data.product.sku}).`);
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
        <label htmlFor={`product-${id}`} className="block text-xs font-medium text-slate-400">
          {label}
          {optional && <span className="ml-1 text-slate-500">(optional)</span>}
        </label>
        <input
          id={`product-${id}`}
          value={values[id]}
          onChange={(e) => update(id, e.target.value)}
          disabled={loading}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `product-${id}-error` : hint ? `product-${id}-hint` : undefined}
          className={`${inputClass} ${error ? "border-red-500/60 focus:border-red-500 focus:ring-red-500" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"}`}
          {...inputProps}
        />
        {error ? (
          <p id={`product-${id}-error`} className="mt-1.5 text-xs text-red-400">{error}</p>
        ) : (
          hint && <p id={`product-${id}-hint`} className="mt-1.5 text-xs text-slate-500">{hint}</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/40 p-6" aria-label={editing ? "Edit product" : "Add product"}>
      <div>
        <h2 className="text-base font-semibold text-white">{editing ? `Edit ${product!.name}` : "Add Product"}</h2>
        <p className="text-xs text-slate-400">
          {editing ? "Change any field and save. The product always stays in your organization." : "The product is added to your organization's catalog."}
        </p>
      </div>

      {formError && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">{formError}</div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {field("sku", "SKU", { type: "text", placeholder: "WID-001", autoComplete: "off", maxLength: 64, hint: "Unique in your catalog. Stored in capitals." })}
        <div className="md:col-span-2">
          {field("name", "Product name", { type: "text", placeholder: "Stainless steel bolt M10", autoComplete: "off", maxLength: 255 })}
        </div>
        <div className="md:col-span-3">
          <label htmlFor="product-description" className="block text-xs font-medium text-slate-400">
            Description <span className="ml-1 text-slate-500">(optional)</span>
          </label>
          <textarea
            id="product-description"
            rows={2}
            value={values.description}
            onChange={(e) => update("description", e.target.value)}
            disabled={loading}
            maxLength={2000}
            aria-invalid={errors.description ? true : undefined}
            className={`${inputClass} ${errors.description ? "border-red-500/60" : "border-slate-800 focus:border-indigo-500 focus:ring-indigo-500"}`}
          />
          {errors.description && <p className="mt-1.5 text-xs text-red-400">{errors.description}</p>}
        </div>
        {field("category", "Category", { type: "text", list: "category-options", placeholder: "Hardware", autoComplete: "off", maxLength: 100 })}
        {field("unit", "Unit of measurement", {
          type: "text", list: "unit-options", placeholder: "pcs", autoComplete: "off", maxLength: 20,
          // Once a product has stock movements its unit is part of what every recorded quantity means: it cannot change.
          ...(product?.unit_locked ? { disabled: true, hint: "Locked: this product already has stock movements, so its unit can no longer change." } : {}),
        })}
        {field("hsCode", "HS code", { type: "text", placeholder: "7318.15", autoComplete: "off", maxLength: 16, optional: true, hint: "Customs tariff code, e.g. 8517.12.00." })}
        {field("costPrice", "Cost price", { type: "text", inputMode: "decimal", placeholder: "12.50", autoComplete: "off", hint: "Up to 4 decimals." })}
        {field("sellingPrice", "Selling price", { type: "text", inputMode: "decimal", placeholder: "19.99", autoComplete: "off", hint: "Up to 4 decimals." })}
        {field("currencyCode", "Currency", { type: "text", placeholder: "USD", maxLength: 3, autoComplete: "off", hint: "3-letter code, e.g. USD, EUR.", style: { textTransform: "uppercase" } })}
      </div>
      <datalist id="category-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="unit-options">{COMMON_UNITS.map((u) => <option key={u} value={u} />)}</datalist>

      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-slate-800 disabled:opacity-60">
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
          {loading ? "Saving…" : editing ? "Save changes" : "Add product"}
        </button>
      </div>
    </form>
  );
}
