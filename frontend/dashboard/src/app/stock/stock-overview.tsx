"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import AddStockModal from "@/components/product/add-stock-modal";
import { useConfirm } from "@/components/ui/confirm";
import { Tooltip } from "@/components/ui/tooltip";
import ProductModal from "@/components/product/product-modal";
import type { PagedResult, StockFilters } from "@/lib/inventory";
import { formatMoney, lineTotal, type Product } from "@/lib/product-validation";
import { StockAction, StockProduct, formatQuantity } from "@/lib/stock-validation";
import StockForm from "./stock-form";

// The Stock page is the organization's product inventory: every product it buys and holds, with what is on hand, what sales orders have reserved, what is
// still available, its unit and prices and its status. Product INFORMATION (view, edit, barcodes, archive) opens in a dialog from "Details".
//
// The three buttons at the top are about the WHOLE inventory:
//   Add Stock         REGISTER A NEW PRODUCT (the dialog "Add Product to Stock"), optionally with the quantity the organization already owns;
//   Opening Balance   the starting quantity of an already registered product that has no stock history yet.
// A row's Actions are exactly two icons: Edit (opens the product dialog on its edit form) and Delete (always asks first). Delete takes the product out of the
// Stock list and out of everything new (orders, purchases) but ERASES NOTHING: it is the product's archive, so its movements, orders, receipts and invoices
// keep their history and it can be restored (Products: Archived -> Edit). Goods bought from now on are not added here at all: they arrive through Purchase
// Order -> confirmed Goods Receipt. A product can also be registered while buying (a purchase order's "Add New Product"). Registering a product never adds
// stock by itself. There is no selling price here: a product has no universal one (each client's price is agreed on their sales order). The Total column is what
// the pieces on hand are worth at what they cost you (on hand x cost, in the product's currency).

type Props = {
  list: PagedResult<StockProduct>;
  filters: StockFilters;
  products: Product[]; // active products, for the form
  totals?: { currency: string; amount: string }[]; // what ALL the products of this filter are worth at cost (never added across currencies)
};

/** Opened from a button above the table (Remove Stock / Opening Balance: pick the product). */
type Panel = { action: StockAction; productId?: string; scope: "top" } | null;

// There is no "Remove Stock" button: a product's delete icon does that (it takes the product out of Stock).
const TOP_ACTIONS: { action: StockAction; label: string }[] = [{ action: "opening", label: "Opening Balance" }];

/** A price with its currency, or a dash when the service did not send one. */
const money = (amount?: string | null, currency?: string | null) => (amount && currency ? formatMoney(amount, currency) : "—");

export default function StockOverview({ list, filters, products, totals = [] }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [editingId, setEditingId] = useState<string | null>(null); // the product whose edit dialog is open
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [adding, setAdding] = useState(false); // the "Add Product to Stock" dialog

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
  const open = (action: StockAction, productId?: string) => { setMessage(null); setProblem(null); setPanel({ action, productId, scope: "top" }); };

  // DELETE: always asks first, then archives the product (see the note at the top). Nothing is erased.
  async function remove(item: StockProduct) {
    const ok = await confirm({
      title: `Delete ${item.name}?`,
      message: "It is taken out of your Stock list and can no longer be ordered, bought or counted. Nothing is erased: its stock movements, orders, receipts and invoices keep their history, and you can bring it back under Products: Archived.",
      confirmLabel: "Delete product",
    });
    if (!ok) return;
    setBusyId(item.product_id);
    setMessage(null);
    setProblem(null);
    try {
      const res = await fetch(`/api/products/${item.product_id}/archive`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.status === 401) return router.replace("/login");
      if (!res.ok) return setProblem(body?.error ?? "The product could not be deleted. Please try again.");
      setMessage(`${item.name} was deleted. It can be restored from Products: Archived.`);
      startTransition(() => router.refresh());
    } catch {
      setProblem("Unable to reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  }
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
            onClick={() => { setMessage(null); setAdding(true); }}
            aria-haspopup="dialog"
            className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            Add Stock
          </button>
          {TOP_ACTIONS.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              disabled={noSetup}
              onClick={() => open(action)}
              className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {noSetup && (
        <p role="status" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          No products yet. Use Add Stock to register your first product (with the quantity you already own, if any), or register one while creating a purchase order.
        </p>
      )}

      {message && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {problem && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{problem}</p>}

      {adding && (
        <AddStockModal
          onClose={() => setAdding(false)}
          onDone={(text) => { setAdding(false); done(text); }}
          onProductAdded={() => startTransition(() => router.refresh())}
        />
      )}

      {editingId && (
        <ProductModal
          productId={editingId}
          startEditing
          onClose={() => setEditingId(null)}
          onChanged={(text) => { setMessage(text); startTransition(() => router.refresh()); }}
        />
      )}

      {panel && (
        <StockForm
          key={`${panel.scope}-${panel.action}-${panel.productId ?? ""}`}
          initialAction={panel.action}
          initialProductId={panel.productId}
          actions={["opening"]}
          products={products}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}

      <section aria-label="Total cost of stock" data-testid="stock-total-cost" className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl border border-slate-800 bg-slate-900/30 px-5 py-4">
        <span className="text-xs font-medium uppercase text-slate-400">Total cost</span>
        {totals.length === 0 ? (
          <span className="font-mono text-lg font-semibold text-white" data-testid="stock-total-cost-value">0.00</span>
        ) : (
          totals.map((t) => <span key={t.currency} className="font-mono text-lg font-semibold text-white" data-testid={`stock-total-cost-${t.currency}`}>{formatMoney(t.amount, t.currency)}</span>)
        )}
        <span className="text-xs text-slate-400">pieces on hand x cost, for all {total} {total === 1 ? "product" : "products"}</span>
      </section>

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
              {filtered ? "No products match these filters." : "No products yet. Use Add Stock to register your first product, or register one while creating a purchase order."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold">Unit</th>
                    <th className="px-4 py-3 font-semibold text-right">Reserved</th>
                    <th className="px-4 py-3 font-semibold text-right">Available</th>
                    <th className="px-4 py-3 font-semibold text-right">Cost</th>
                    <th className="px-4 py-3 font-semibold text-right">Total</th>
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
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-slate-300" data-testid={`reserved-${item.sku}`}>{formatQuantity(item.reserved_quantity ?? "0")}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                        <span className="text-sm font-semibold text-white" data-testid={`available-${item.sku}`}>{formatQuantity(item.available_quantity ?? item.total_quantity)}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-slate-300">{money(item.cost_price, item.currency_code)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">
                        <span className="text-sm font-semibold text-white" data-testid={`total-${item.sku}`}>{money(item.cost_price ? lineTotal(item.total_quantity, item.cost_price) : null, item.currency_code)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${item.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"}`}>
                          {item.is_active ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-0.5">
                          <Tooltip label="Edit">
                            <button type="button" onClick={() => { setMessage(null); setProblem(null); setEditingId(item.product_id); }} aria-haspopup="dialog" aria-label={`Edit ${item.name}`} className="p-1.5 text-slate-400 transition-colors hover:text-white focus-visible:text-white focus-visible:outline-none">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" /></svg>
                            </button>
                          </Tooltip>
                          <Tooltip label={item.is_active ? "Delete" : "Already deleted"}>
                            <button type="button" onClick={() => remove(item)} disabled={!item.is_active || busyId === item.product_id} aria-label={`Delete ${item.name}`} className="p-1.5 text-red-400 transition-colors hover:text-red-300 focus-visible:text-red-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-red-400">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                            </button>
                          </Tooltip>
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
      {confirmDialog}
    </div>
  );
}
