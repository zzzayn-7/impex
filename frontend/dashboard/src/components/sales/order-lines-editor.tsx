"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { type OrderRow, type PickerProduct, rowFromProduct } from "@/lib/order-form";
import { api, qty } from "@/lib/sales-browser";
import QuantityInput from "@/components/ui/quantity-input";

// The products of an order: a searchable picker to add products, and one row per product with its quantity, its physical stock, what is
// reserved and what is still available to order. Used by Create Order and by the Edit dialog. Nothing is sent from here: the form decides.

const cell = "px-3 py-2.5 align-top";

export default function OrderLinesEditor({ rows, onChange, errors, disabled = false, showStock = true, showPicker = true, emptyMessage }: {
  rows: OrderRow[];
  onChange: (rows: OrderRow[]) => void;
  errors: Record<string, string>;
  disabled?: boolean;
  showStock?: boolean;
  /** false when the products are chosen somewhere else (Create Order's inventory list): this then only reviews and adjusts the chosen rows. */
  showPicker?: boolean;
  emptyMessage?: string;
}) {
  const setQuantity = (productId: string, quantity: string) => onChange(rows.map((r) => (r.productId === productId ? { ...r, quantity } : r)));
  const remove = (productId: string) => onChange(rows.filter((r) => r.productId !== productId));

  return (
    <div className="space-y-4">
      {showPicker && <ProductPicker taken={new Set(rows.map((r) => r.productId))} disabled={disabled} onPick={(p) => onChange([...rows, rowFromProduct(p)])} />}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ix-mist/15 px-4 py-8 text-center text-sm text-ix-muted">{emptyMessage ?? "No products yet. Search above and add the products the client needs."}</p>
      ) : (
        <div className="ix-inset overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Products required</caption>
            <thead className="text-[11px] uppercase tracking-wide text-ix-muted">
              <tr>
                <th scope="col" className={`${cell} font-medium`}>Product</th>
                {showStock && <th scope="col" className={`${cell} text-right font-medium`}>On hand</th>}
                {showStock && <th scope="col" className={`${cell} text-right font-medium`}>Booked</th>}
                {showStock && <th scope="col" className={`${cell} text-right font-medium`}>Available to order</th>}
                <th scope="col" className={`${cell} w-56 font-medium`}>Quantity</th>
                <th scope="col" className={`${cell} w-12`}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ix-mist/10">
              {rows.map((row) => {
                const error = errors[row.productId];
                const inputId = `qty-${row.productId}`;
                return (
                  <tr key={row.productId} data-product={row.productId}>
                    <td className={cell}>
                      <div className="font-medium text-ix-text">{row.name}</div>
                      <div className="font-mono text-xs text-ix-butter">{row.sku}</div>
                    </td>
                    {showStock && <td className={`${cell} text-right font-mono text-xs tabular-nums text-ix-text`}>{qty(row.onHand)} <span className="text-ix-muted">{row.unit}</span></td>}
                    {showStock && <td className={`${cell} text-right font-mono text-xs tabular-nums text-ix-muted`}>{qty(row.reserved)}</td>}
                    {showStock && <td className={`${cell} text-right font-mono text-xs tabular-nums text-ix-text`}>{qty(row.available)} <span className="text-ix-muted">{row.unit}</span></td>}
                    <td className={cell}>
                      <div className="flex items-center gap-2">
                        <QuantityInput
                          id={inputId}
                          aria-label={`Quantity of ${row.name} in ${row.unit}`}
                          value={row.quantity}
                          disabled={disabled}
                          onChange={(v) => setQuantity(row.productId, v)}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `${inputId}-error` : undefined}
                        />
                        <span aria-hidden="true" className="shrink-0 text-xs text-ix-muted">{row.unit}</span>
                      </div>
                      {error && <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
                    </td>
                    <td className={`${cell} text-right`}>
                      <Tooltip label={row.min !== "0" ? "Goods were already dispatched: this line cannot be removed" : `Remove ${row.name}`} side="left">
                        <button
                          type="button"
                          onClick={() => remove(row.productId)}
                          disabled={disabled || row.min !== "0"}
                          aria-label={`Remove ${row.name}`}
                          className="grid h-9 w-9 place-items-center rounded-xl border border-ix-mist/15 text-ix-muted transition-colors hover:border-red-300/40 hover:bg-red-400/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Search the organization's active products and add one. Products already on the order are shown as added and cannot be picked twice. */
export function ProductPicker({ onPick, taken, disabled = false }: { onPick: (product: PickerProduct) => void; taken: Set<string>; disabled?: boolean }) {
  const id = useId();
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<PickerProduct[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      const r = await api(`/api/sales/order-products?q=${encodeURIComponent(term.trim())}`);
      if (!alive) return;
      setLoading(false);
      if (!r.ok) { setError(r.error); setItems([]); return; }
      setError(null);
      setItems(r.data.items as PickerProduct[]);
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [term, open]);

  useEffect(() => {
    const away = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  return (
    <div ref={box} className="relative" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <label htmlFor={id} className="block text-xs font-medium text-ix-muted">Add a product</label>
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        value={term}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        placeholder="Search by product name, SKU or category"
        className="mt-1.5 block w-full text-sm"
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label="Matching products" className="ix-menu absolute left-0 right-0 z-20 mt-2 max-h-72 overflow-y-auto">
          {loading && items === null && <li className="px-3 py-3 text-sm text-ix-muted" role="status">Searching…</li>}
          {error && <li role="alert" className="px-3 py-3 text-sm text-red-300">{error}</li>}
          {!loading && items !== null && items.length === 0 && !error && <li className="px-3 py-3 text-sm text-ix-muted">No active products match.</li>}
          {(items ?? []).map((p) => {
            const added = taken.has(p.product_id);
            const available = p.available_quantity ?? p.total_quantity;
            return (
              <li key={p.product_id} role="option" aria-selected={added}>
                <button
                  type="button"
                  disabled={added}
                  onClick={() => { onPick(p); setOpen(false); setTerm(""); setItems(null); }}
                  className="ix-menu-item justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate font-mono text-[11px] text-ix-muted">{p.sku} · {p.unit}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    {added ? <span className="text-ix-butter">Added</span> : <><span className="block tabular-nums text-ix-text">{qty(available)} available</span><span className="block tabular-nums text-ix-muted">{qty(p.total_quantity)} on hand</span></>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
