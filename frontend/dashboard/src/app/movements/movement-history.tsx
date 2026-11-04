"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import type { MovementFilters, PagedResult } from "@/lib/inventory";
import type { Product } from "@/lib/product-validation";
import { MOVEMENT_LABELS, MOVEMENT_TYPES, Movement, MovementType, Warehouse, formatQuantity, isDebit } from "@/lib/stock-validation";

type Props = {
  list: PagedResult<Movement>;
  filters: MovementFilters;
  products: Product[];
  warehouses: Warehouse[];
};

const BADGE: Record<MovementType, string> = {
  opening: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  in: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  out: "border-red-500/20 bg-red-500/10 text-red-300",
  transfer_in: "border-indigo-500/20 bg-indigo-500/10 text-indigo-300",
  transfer_out: "border-amber-500/20 bg-amber-500/10 text-amber-300",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
};

export default function MovementHistory({ list, filters, products, warehouses }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function navigate(next: Partial<MovementFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.productId) params.set("product", merged.productId);
    if (merged.warehouseId) params.set("warehouse", merged.warehouseId);
    if (merged.type) params.set("type", merged.type);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/movements?${query}` : "/movements"));
  }

  const filtered = Boolean(filters.productId || filters.warehouseId || filters.type);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const selectClass = "mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Stock Movements</h2>
        <p className="text-xs text-slate-400">
          Every change to your stock, newest first. The history is permanent: movements can never be edited or deleted.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-400">
            Product
            <select value={filters.productId} onChange={(e) => navigate({ productId: e.target.value })} className={`${selectClass} max-w-[18rem]`}>
              <option value="">All products</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku}){p.is_active ? "" : " — archived"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Warehouse
            <select value={filters.warehouseId} onChange={(e) => navigate({ warehouseId: e.target.value })} className={selectClass}>
              <option value="">All warehouses</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}{w.is_active ? "" : " (archived)"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-400">
            Type
            <select value={filters.type} onChange={(e) => navigate({ type: e.target.value as MovementFilters["type"] })} className={selectClass}>
              <option value="">All types</option>
              {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{MOVEMENT_LABELS[t]}</option>)}
            </select>
          </label>
          {filtered && (
            <button type="button" onClick={() => navigate({ productId: "", warehouseId: "", type: "" })} className="rounded-lg px-3 py-2 text-sm text-indigo-300 hover:text-indigo-200">
              Clear filters
            </button>
          )}
        </div>

        <div aria-busy={isPending} className={`transition-opacity ${isPending ? "opacity-50" : "opacity-100"}`}>
          {isPending && <p role="status" className="mb-2 text-xs text-slate-400">Updating…</p>}

          {!list.ok ? (
            <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${list.reason === "forbidden" ? "border-amber-500/20 bg-amber-500/10 text-amber-300" : "border-slate-700 bg-slate-950/50 text-slate-300"}`}>
              {list.reason === "forbidden"
                ? "Your organization is currently inactive or unavailable, so stock history cannot be used. Please contact your platform administrator."
                : "Stock history is temporarily unavailable. Please refresh in a moment."}
            </div>
          ) : list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
              {filtered ? "No movements match these filters." : "No stock movements yet. They appear here as soon as you add, remove or transfer stock."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">When</th>
                    <th className="px-4 py-3 font-semibold">Type</th>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 font-semibold">Warehouse</th>
                    <th className="px-4 py-3 font-semibold text-right">Quantity</th>
                    <th className="px-4 py-3 font-semibold text-right">Balance after</th>
                    <th className="px-4 py-3 font-semibold">Reason</th>
                    <th className="px-4 py-3 font-semibold">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((m) => (
                    <tr key={m.id} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-400">{when(m.created_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[m.movement_type]}`}>{MOVEMENT_LABELS[m.movement_type]}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{m.product_name}</div>
                        <div className="font-mono text-xs text-indigo-300">{m.product_sku}</div>
                      </td>
                      <td className="px-4 py-3 text-xs" title={m.warehouse_name}>{m.warehouse_code}</td>
                      <td className={`px-4 py-3 text-right font-mono text-xs whitespace-nowrap ${isDebit(m.movement_type) ? "text-red-300" : "text-emerald-400"}`}>
                        {isDebit(m.movement_type) ? "−" : "+"}{formatQuantity(m.quantity)} <span className="text-slate-500">{m.product_unit}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap">{formatQuantity(m.balance_after)}</td>
                      <td className="px-4 py-3 text-xs">{m.reason}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">{m.created_by_email}</td>
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
