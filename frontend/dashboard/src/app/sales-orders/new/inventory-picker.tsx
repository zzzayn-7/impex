"use client";

import { KeyboardEvent, useEffect, useId, useState } from "react";

import { buttonClass } from "@/components/ui/controls";
import { type OrderRow, type PickerProduct, rowFromProduct } from "@/lib/order-form";
import { api, qty } from "@/lib/sales-browser";
import { ScanProductButton } from "@/components/scan/scan-product-modal";
import QuantityInput from "@/components/ui/quantity-input";

// The inventory list of Create Order: the organization's active products in the same layout as the Products tab (product + SKU, category, unit),
// with the stock figures that matter when booking (on hand / booked / available). Search it, or scan a product to find it. Each row has Add and
// Drop; the quantity can be typed on the row (or later in "View List"). Nothing is sent from here: the order form saves.

const PAGE_SIZE = 20;
const cell = "px-4 py-3 align-middle";

type Page = { items: PickerProduct[]; total: number; offset: number };

export default function InventoryPicker({ rows, onChange, errors, disabled = false, locked = false }: {
  rows: OrderRow[];
  onChange: (rows: OrderRow[]) => void;
  errors: Record<string, string>;
  disabled?: boolean;
  /** No client is selected yet: the inventory can be searched and scanned, but no product can be added or given a quantity. */
  locked?: boolean;
}) {
  const searchId = useId();
  const [term, setTerm] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // quantities typed for products that are not on the order (yet)
  const [scanned, setScanned] = useState<PickerProduct | null>(null); // the product a scan found: shown instead of the list until cleared

  useEffect(() => {
    if (scanned) return;
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      const r = await api(`/api/sales/order-products?q=${encodeURIComponent(term.trim())}&offset=${offset}`);
      if (!alive) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.error);
        setPage({ items: [], total: 0, offset });
        return;
      }
      setError(null);
      setPage({ items: r.data.items as PickerProduct[], total: Number(r.data.total) || 0, offset });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [term, offset, scanned]);

  const byId = new Map(rows.map((r) => [r.productId, r]));
  const items = scanned ? [scanned] : page?.items ?? [];
  const total = scanned ? 1 : page?.total ?? 0;

  const add = (p: PickerProduct) => {
    if (byId.has(p.product_id)) return;
    onChange([...rows, { ...rowFromProduct(p), quantity: drafts[p.product_id] ?? "" }]);
    setDrafts(({ [p.product_id]: _used, ...rest }) => rest);
  };
  const drop = (productId: string) => onChange(rows.filter((r) => r.productId !== productId));
  const setQuantity = (p: PickerProduct, value: string) => {
    if (byId.has(p.product_id)) onChange(rows.map((r) => (r.productId === p.product_id ? { ...r, quantity: value } : r)));
    else setDrafts((d) => ({ ...d, [p.product_id]: value }));
  };

  // Enter in the search box or a quantity box must never save the whole order by accident.
  const keepEnterFromSubmitting = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  const first = items.length > 0 ? (scanned ? 1 : (page?.offset ?? 0) + 1) : 0;
  const last = scanned ? items.length : (page?.offset ?? 0) + items.length;

  return (
    <div className="space-y-4" onKeyDown={keepEnterFromSubmitting}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ScanProductButton
          disabled={disabled}
          onFound={({ stock, product }) => { setTerm(""); setOffset(0); setScanned({ ...stock, category: stock.category ?? product.category }); }}
        />
        <div className="min-w-0 flex-1">
          <input
            id={searchId}
            type="search"
            aria-label="Search products"
            value={term}
            disabled={disabled}
            onChange={(e) => { setTerm(e.target.value); setOffset(0); setScanned(null); }}
            maxLength={100}
            autoComplete="off"
            placeholder="Search product"
            className="block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>

      {scanned && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-ix-butter/25 bg-ix-butter/10 px-4 py-2.5 text-sm">
          <span className="text-ix-text">Scanned: <strong className="font-semibold">{scanned.name}</strong> <span className="font-mono text-xs text-ix-butter">{scanned.sku}</span></span>
          <button type="button" onClick={() => setScanned(null)} className="text-xs font-medium text-ix-muted underline-offset-2 hover:text-ix-text hover:underline">Show all products</button>
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-2xl border border-red-300/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</p>
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-8 text-center text-sm text-ix-muted" role={loading ? "status" : undefined}>
          {loading ? "Loading inventory…" : term.trim() ? "No active products match your search." : "No products yet. Add products in Products first."}
        </p>
      ) : (
        <div className={`ix-inset overflow-x-auto transition-opacity ${loading && !scanned ? "opacity-60" : ""}`} aria-busy={loading && !scanned}>
          <table className="w-full min-w-[62rem] text-left text-sm">
            <caption className="sr-only">Inventory</caption>
            <thead className="text-[11px] uppercase tracking-wide text-ix-muted">
              <tr>
                <th scope="col" className={`${cell} font-medium`}>Product</th>
                <th scope="col" className={`${cell} font-medium`}>Category</th>
                <th scope="col" className={`${cell} font-medium`}>Unit</th>
                <th scope="col" className={`${cell} text-right font-medium`}>On hand</th>
                <th scope="col" className={`${cell} text-right font-medium`}>Booked</th>
                <th scope="col" className={`${cell} text-right font-medium`}>Available</th>
                <th scope="col" className={`${cell} w-52 font-medium`}>Quantity</th>
                <th scope="col" className={`${cell} font-medium`}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ix-mist/10">
              {items.map((p) => {
                const row = byId.get(p.product_id);
                const added = Boolean(row);
                const available = p.available_quantity ?? p.total_quantity;
                const none = !(Number(available) > 0); // a display decision only; the services judge every quantity again
                const problem = row ? errors[p.product_id] : undefined;
                const inputId = `inv-qty-${p.product_id}`;
                return (
                  <tr key={p.product_id} data-product={p.product_id} className={added ? "bg-ix-butter/[0.06]" : undefined}>
                    <td className={cell}>
                      <div className="font-medium text-ix-text">{p.name}</div>
                      <div className="font-mono text-xs text-ix-butter">{p.sku}</div>
                    </td>
                    <td className={`${cell} text-xs`}>{p.category || <span className="text-ix-muted">—</span>}</td>
                    <td className={`${cell} text-xs`}>{p.unit}</td>
                    <td className={`${cell} text-right font-mono text-xs tabular-nums text-ix-text`}>{qty(p.total_quantity)}</td>
                    <td className={`${cell} text-right font-mono text-xs tabular-nums text-ix-muted`}>{qty(p.reserved_quantity ?? "0")}</td>
                    <td className={`${cell} text-right font-mono text-xs tabular-nums ${none ? "text-red-300" : "text-ix-text"}`}>{qty(available)}</td>
                    <td className={cell}>
                      <QuantityInput
                        id={inputId}
                        aria-label={`Order quantity of ${p.name} in ${p.unit}`}
                        value={row ? row.quantity : drafts[p.product_id] ?? ""}
                        disabled={disabled || locked || (none && !added)}
                        onChange={(v) => setQuantity(p, v)}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={problem ? `${inputId}-error` : undefined}
                      />
                      {problem && <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs text-red-300">{problem}</p>}
                    </td>
                    <td className={cell}>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => add(p)}
                          disabled={disabled || locked || added || none}
                          aria-label={`Add ${p.name}`}
                          title={locked && !added ? "Select a client first" : none && !added ? "Nothing is available to order" : undefined}
                          className="rounded-lg border border-ix-butter/40 bg-ix-butter/10 px-3 py-1.5 text-xs font-semibold text-ix-butter transition-colors hover:bg-ix-butter/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {added ? "Added" : "Add"}
                        </button>
                        <button
                          type="button"
                          onClick={() => drop(p.product_id)}
                          disabled={disabled || !added}
                          aria-label={`Drop ${p.name}`}
                          className="rounded-lg border border-ix-mist/20 px-3 py-1.5 text-xs font-medium text-ix-text transition-colors hover:border-red-300/40 hover:bg-red-400/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Drop
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!error && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ix-muted">
          <span>Showing {first}–{last} of {total}</span>
          {!scanned && (
            <div className="flex gap-2">
              <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={buttonClass.secondary}>Previous</button>
              <button type="button" disabled={last >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)} className={buttonClass.secondary}>Next</button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
