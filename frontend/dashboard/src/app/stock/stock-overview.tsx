"use client";

import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import AddStockPanel from "@/components/product/add-stock-panel";
import { ScanProductButton } from "@/components/scan/scan-product-modal";
import { Tooltip } from "@/components/ui/tooltip";
import type { PagedResult, StockFilters } from "@/lib/inventory";
import { formatMoney, type Product } from "@/lib/product-validation";
import { StockAction, StockProduct } from "@/lib/stock-validation";
import StockForm from "./stock-form";
import StockList from "./stock-list";

// The Stock page is the organization's product inventory: every product it buys and holds, with what is on hand, what sales orders have reserved, what is
// still available, its unit and prices and its status. The list scrolls (it loads more as you reach the end; there are no pages) and "Full view" opens the whole
// list on a page of its own.
//
// The two buttons at the top are about the WHOLE inventory:
//   Add Stock         REGISTER A NEW PRODUCT (a form on this page, drawn like the Add Client form), optionally with the quantity the organization already owns;
//   Opening Balance   the starting quantity of an already registered product that has no stock history yet.
// Above the list: search (SKU or name), a scanner icon (scan a barcode / QR code to search for that product) and the Active / Archived / All filter.
// A row's Actions (see stock-list.tsx) are Edit, Archive (or Restore) and Delete. Archive keeps everything and can be undone; Delete removes the product for good.
// Goods bought from now on are not added here at all: they arrive through Purchase Order -> confirmed Goods Receipt. A product can also be registered while buying
// (a purchase order's "Add New Product"). Registering a product never adds stock by itself. There is no selling price here: a product has no universal one (each
// client's price is agreed on their sales order). The Total column is what the pieces on hand are worth at what they cost you (on hand x cost, in the product's currency).

type Props = {
  list: PagedResult<StockProduct>;
  filters: StockFilters;
  products: Product[]; // active products, for the form
  totals?: { currency: string; amount: string }[]; // what ALL the products of this filter are worth at cost (never added across currencies)
};

/** Opened from a button above the table (Opening Balance: pick the product). */
type Panel = { action: StockAction; productId?: string; scope: "top" } | null;

// There is no "Remove Stock" button: a product is archived or deleted from its row.
const TOP_ACTIONS: { action: StockAction; label: string }[] = [{ action: "opening", label: "Opening Balance" }];

export default function StockOverview({ list, filters, products, totals = [] }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [adding, setAdding] = useState(false); // the "New product" form

  function navigate(next: Partial<StockFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.status !== "active") params.set("status", merged.status);
    const query = params.toString();
    startTransition(() => router.push(query ? `/stock?${query}` : "/stock"));
  }

  function done(text: string) {
    setPanel(null);
    setMessage(text);
    startTransition(() => router.refresh()); // re-read the balances from the database
  }

  const filtered = Boolean(filters.q || filters.status !== "active");
  const open = (action: StockAction, productId?: string) => { setMessage(null); setAdding(false); setPanel({ action, productId, scope: "top" }); };
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]); // re-read the total cost and the first rows
  const fullViewHref = (() => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.status !== "active") params.set("status", filters.status);
    const query = params.toString();
    return query ? `/stock/full?${query}` : "/stock/full";
  })();

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
            onClick={() => { setMessage(null); setPanel(null); setAdding((v) => !v); }}
            aria-expanded={adding}
            className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            {adding ? "Close" : "Add Stock"}
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

      {adding && (
        <AddStockPanel
          onClose={() => setAdding(false)}
          onDone={(text) => { setAdding(false); done(text); }}
          onProductAdded={refresh}
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

      <section aria-label="Total cost of stock" data-testid="stock-total-cost" className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 text-sm">
        <span className="text-slate-400">Total cost</span>
        {totals.length === 0 ? (
          <span className="font-mono text-slate-200" data-testid="stock-total-cost-value">0.00</span>
        ) : (
          totals.map((tot) => <span key={tot.currency} className="font-mono text-slate-200" data-testid={`stock-total-cost-${tot.currency}`}>{formatMoney(tot.amount, tot.currency)}</span>)
        )}
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
          <Tooltip label="Scan a barcode or QR code to search">
            <ScanProductButton
              iconOnly
              label="Scan to search"
              activeOnly={false}
              onFound={(result) => {
                setSearch(result.product.sku);
                navigate({ q: result.product.sku, status: result.product.is_active ? filters.status : "all" }); // an archived product is shown too
              }}
              className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-200 transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </Tooltip>
          <select
            aria-label="Show products"
            value={filters.status}
            onChange={(e) => navigate({ status: e.target.value as StockFilters["status"] })}
            className="block w-36 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </div>

        <div aria-busy={isPending} className={`transition-opacity ${isPending ? "opacity-50" : "opacity-100"}`}>
          {isPending && <p role="status" className="mb-2 text-xs text-slate-400">Updating…</p>}

          {!list.ok ? (
            <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${list.reason === "forbidden" ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-950/50 text-slate-300"}`}>
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so stock cannot be used. Please contact your platform administrator."
                : "Stock is temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : (
            <StockList key={`${filters.q}|${filters.status}`} initial={list.items} total={list.total} filters={{ q: filters.q, status: filters.status }} filtered={filtered} onChanged={refresh} />
          )}
        </div>

        {list.ok && list.total > 0 && (
          <div className="flex justify-end">
            <Link href={fullViewHref} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800">Full view</Link>
          </div>
        )}
      </section>
    </div>
  );
}
