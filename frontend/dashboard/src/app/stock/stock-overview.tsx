"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import ProductModal, { NewProductModal } from "@/components/product/product-modal";
import type { PagedResult, StockFilters } from "@/lib/inventory";
import { formatMoney, type Product } from "@/lib/product-validation";
import { ACTION_LABELS, StockAction, StockProduct, formatQuantity } from "@/lib/stock-validation";
import StockForm from "./stock-form";

// The Stock page is the organization's product inventory: every product it buys and holds, with what is on hand, what sales orders have reserved, what is
// still available, its unit and prices and its status. Product INFORMATION (view, edit, barcodes, archive) opens in a dialog from "Details"; stock QUANTITIES
// are changed only by Add stock / Remove stock / Opening balance (their own forms). A new product is registered with "New product" here or while buying
// (a purchase order's "Add New Product"); registering a product never adds stock.

type Props = {
  list: PagedResult<StockProduct>;
  filters: StockFilters;
  products: Product[]; // active products, for the form
};

type Panel = { action: StockAction; productId?: string } | null;

/** A price with its currency, or a dash when the service did not send one. */
const money = (amount?: string | null, currency?: string | null) => (amount && currency ? formatMoney(amount, currency) : "—");

export default function StockOverview({ list, filters, products }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [detailsId, setDetailsId] = useState<string | null>(null); // the product whose dialog is open
  const [registering, setRegistering] = useState(false); // the "New product" dialog

  function navigate(next: Partial<StockFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.inStockOnly) params.set("inStock", "1");
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/stock?${query}` : "/stock"));
  }

  function done(text: string) {
    setPanel(null);
    setMessage(text);
    startTransition(() => router.refresh()); // re-read the balances from the database
  }

  const filtered = Boolean(filters.q || filters.inStockOnly || filters.status !== "active");
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const open = (action: StockAction, productId?: string) => { setMessage(null); setPanel({ action, productId }); };
  const noSetup = products.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Stock</h2>
          <p className="text-xs text-slate-400">What you hold. Quantities come from the stock ledger and cannot go below zero.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => { setMessage(null); setRegistering(true); }}
            aria-haspopup="dialog"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            New product
          </button>
          {(["in", "out", "opening"] as StockAction[]).map((action) => (
            <button
              key={action}
              type="button"
              disabled={noSetup}
              onClick={() => open(action)}
              className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-40 ${
                action === "in" ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500" : "border border-slate-700 text-slate-200 hover:bg-slate-800"
              }`}
            >
              {ACTION_LABELS[action].title}
            </button>
          ))}
        </div>
      </div>

      {noSetup && (
        <p role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          No products yet. Use New product, or register one while creating a purchase order, then you can record stock here.
        </p>
      )}

      {message && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {registering && (
        <NewProductModal
          onClose={() => setRegistering(false)}
          onSaved={(_product, text) => { setRegistering(false); done(text); }}
        />
      )}

      {detailsId && (
        <ProductModal
          productId={detailsId}
          onClose={() => setDetailsId(null)}
          onChanged={(text) => { setMessage(text); startTransition(() => router.refresh()); }}
        />
      )}

      {panel && (
        <StockForm
          key={`${panel.action}-${panel.productId ?? ""}`}
          initialAction={panel.action}
          initialProductId={panel.productId}
          products={products}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} className="flex min-w-[16rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU or name"
                maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <button type="submit" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="flex items-center gap-2 pb-2 text-xs font-medium text-slate-400">
            <input type="checkbox" checked={filters.inStockOnly} onChange={(e) => navigate({ inStockOnly: e.target.checked })} className="h-4 w-4 rounded border-slate-700 bg-slate-950" />
            In stock only
          </label>
          <label className="text-xs font-medium text-slate-400">
            Products
            <select
              value={filters.status}
              onChange={(e) => navigate({ status: e.target.value as StockFilters["status"] })}
              className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          {filtered && (
            <button type="button" onClick={() => { setSearch(""); navigate({ q: "", inStockOnly: false, status: "active" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">
              Clear filters
            </button>
          )}
        </div>

        <div aria-busy={isPending} className={`transition-opacity ${isPending ? "opacity-50" : "opacity-100"}`}>
          {isPending && <p role="status" className="mb-2 text-xs text-slate-400">Updating…</p>}

          {!list.ok ? (
            <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${list.reason === "forbidden" ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-950/50 text-slate-300"}`}>
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so stock cannot be used. Please contact your platform administrator."
                : "Stock is temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No products match these filters." : "No products yet. Use New product, or register one while creating a purchase order."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold">Unit</th>
                    <th className="px-4 py-3 font-semibold text-right">On hand</th>
                    <th className="px-4 py-3 font-semibold text-right">Reserved</th>
                    <th className="px-4 py-3 font-semibold text-right">Available</th>
                    <th className="px-4 py-3 font-semibold text-right">Cost</th>
                    <th className="px-4 py-3 font-semibold text-right">Price</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((item) => (
                    <tr key={item.product_id} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{item.name}</div>
                        <div className="font-mono text-xs text-indigo-300">{item.sku}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">{item.unit}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                        <span className="text-sm font-semibold text-white" data-testid={`onhand-${item.sku}`}>{formatQuantity(item.total_quantity)}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-slate-300" data-testid={`reserved-${item.sku}`}>{formatQuantity(item.reserved_quantity ?? "0")}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                        <span className="text-sm font-semibold text-white" data-testid={`available-${item.sku}`}>{formatQuantity(item.available_quantity ?? item.total_quantity)}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-slate-300">{money(item.cost_price, item.currency_code)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{money(item.selling_price, item.currency_code)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${item.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>
                          {item.is_active ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {item.is_active && !noSetup && (["in", "out"] as StockAction[]).map((action) => (
                            <button key={action} type="button" onClick={() => open(action, item.product_id)} aria-label={`${ACTION_LABELS[action].title}: ${item.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">
                              {action === "in" ? "Add" : "Remove"}
                            </button>
                          ))}
                          <button type="button" onClick={() => { setMessage(null); setDetailsId(item.product_id); }} aria-haspopup="dialog" aria-label={`Details: ${item.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">
                            Details
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {list.ok && total > 0 && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Showing {first}–{last} of {total}</span>
            <div className="flex gap-2">
              <button type="button" disabled={filters.page <= 1 || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Previous</button>
              <button type="button" disabled={last >= total || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
