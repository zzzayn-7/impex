"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { ProductFilters, ProductListResult } from "@/lib/inventory";
import { Product, formatMoney } from "@/lib/product-validation";
import ProductForm from "./product-form";

type Props = {
  list: ProductListResult;
  categories: string[];
  filters: ProductFilters;
};

type Panel = { mode: "add" } | { mode: "edit"; product: Product } | null;

export default function ProductCatalog({ list, categories, filters }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState(filters.q);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Filters live in the URL (shareable, back-button friendly). Only q, category, status and page exist.
  function navigate(next: Partial<ProductFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.category) params.set("category", merged.category);
    if (merged.status !== "active") params.set("status", merged.status);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/products?${query}` : "/products"));
  }

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    navigate({ q: search.trim() });
  }

  function done(text: string) {
    setPanel(null);
    setMessage({ ok: true, text });
    startTransition(() => router.refresh()); // re-read the table from the database
  }

  async function change(product: Product, action: "archive" | "restore") {
    setBusyId(product.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/products/${product.id}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error ?? "That did not work. Please try again." });
        return;
      }
      setConfirmingId(null);
      done(action === "archive" ? `${product.name} was archived. Show "Archived" products to restore it.` : `${product.name} was restored.`);
    } catch {
      setMessage({ ok: false, text: "Unable to reach the server. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  const filtered = Boolean(filters.q || filters.category || filters.status !== "active");
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.products.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.products.length : 0;
  const hasPrev = filters.page > 1;
  const hasNext = list.ok && last < total;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Products</h2>
          <p className="text-xs text-slate-400">Your organization&apos;s product catalog. Only your own products are shown.</p>
        </div>
        <button
          type="button"
          onClick={() => { setMessage(null); setPanel(panel?.mode === "add" ? null : { mode: "add" }); }}
          aria-expanded={panel?.mode === "add"}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
        >
          {panel?.mode === "add" ? "Close" : "Add Product"}
        </button>
      </div>

      {message && (
        <div
          role={message.ok ? "status" : "alert"}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${
            message.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-red-500/20 bg-red-500/10 text-red-400"
          }`}
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}

      {panel && (
        <ProductForm
          key={panel.mode === "edit" ? panel.product.id : "add"}
          product={panel.mode === "edit" ? panel.product : undefined}
          categories={categories}
          onDone={done}
          onCancel={() => setPanel(null)}
        />
      )}

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <form onSubmit={onSearch} className="flex min-w-[16rem] flex-1 items-end gap-2" role="search">
            <label className="flex-1 text-xs font-medium text-slate-400">
              Search
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU, name, description, category, HS code"
                maxLength={100}
                className="mt-1.5 block w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            <button type="submit" className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800">Search</button>
          </form>
          <label className="text-xs font-medium text-slate-400">
            Category
            <select
              value={filters.category}
              onChange={(e) => navigate({ category: e.target.value })}
              className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
            >
              <option value="">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              {filters.category && !categories.includes(filters.category) && <option value={filters.category}>{filters.category}</option>}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Status
            <select
              value={filters.status}
              onChange={(e) => navigate({ status: e.target.value as ProductFilters["status"] })}
              className="mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          {filtered && (
            <button type="button" onClick={() => { setSearch(""); navigate({ q: "", category: "", status: "active" }); }} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">
              Clear filters
            </button>
          )}
        </div>

        <div aria-busy={isPending} className={`transition-opacity ${isPending ? "opacity-50" : "opacity-100"}`}>
          {isPending && <p role="status" className="mb-2 text-xs text-slate-400">Updating…</p>}

          {!list.ok ? (
            <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${list.reason === "forbidden" ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-950/50 text-slate-300"}`}>
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so the catalog cannot be used. Please contact your platform administrator."
                : "The product catalog is temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.products.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No products match these filters." : "No products yet. Use Add Product to create your first one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold">Category</th>
                    <th className="px-4 py-3 font-semibold">Unit</th>
                    <th className="px-4 py-3 font-semibold">HS code</th>
                    <th className="px-4 py-3 font-semibold text-right">Cost</th>
                    <th className="px-4 py-3 font-semibold text-right">Price</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.products.map((product) => (
                    <tr key={product.id} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{product.name}</div>
                        <div className="font-mono text-xs text-indigo-300">{product.sku}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">{product.category}</td>
                      <td className="px-4 py-3 text-xs">{product.unit}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{product.hs_code ?? <span className="text-slate-600">—</span>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatMoney(product.cost_price, product.currency_code)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-white">{formatMoney(product.selling_price, product.currency_code)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          product.is_active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400" : "border-slate-600/40 bg-slate-700/30 text-slate-400"
                        }`}>
                          {product.is_active ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {confirmingId === product.id ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-300">Archive?</span>
                            <button type="button" disabled={busyId === product.id} onClick={() => change(product, "archive")} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-60">
                              {busyId === product.id ? "Archiving…" : "Yes"}
                            </button>
                            <button type="button" onClick={() => setConfirmingId(null)} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">No</button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            <Link href={`/products/${product.id}/codes`} aria-label={`QR code and barcode for ${product.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">
                              Codes
                            </Link>
                            <button type="button" onClick={() => { setMessage(null); setPanel({ mode: "edit", product }); }} aria-label={`Edit ${product.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800">
                              Edit
                            </button>
                            {product.is_active ? (
                              <button type="button" onClick={() => setConfirmingId(product.id)} aria-label={`Archive ${product.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-slate-800">
                                Archive
                              </button>
                            ) : (
                              <button type="button" disabled={busyId === product.id} onClick={() => change(product, "restore")} aria-label={`Restore ${product.name}`} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-slate-800 disabled:opacity-60">
                                {busyId === product.id ? "Restoring…" : "Restore"}
                              </button>
                            )}
                          </div>
                        )}
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
            <span>
              Showing {first}–{last} of {total}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={!hasPrev || isPending} onClick={() => navigate({ page: filters.page - 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">
                Previous
              </button>
              <button type="button" disabled={!hasNext || isPending} onClick={() => navigate({ page: filters.page + 1 })} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800 disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
