"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useStamp } from "@/components/clock";
import { useConfirm } from "@/components/ui/confirm";
import { Tooltip } from "@/components/ui/tooltip";
import { subtractMoney, sumMoney } from "@/lib/sales-browser";
import type { MovementFilters, PagedResult } from "@/lib/inventory";
import type { Product } from "@/lib/product-validation";
import { MOVEMENT_TYPES, Movement, MovementType, formatQuantity, isDebit } from "@/lib/stock-validation";

type Props = {
  list: PagedResult<Movement>;
  filters: MovementFilters;
  products: Product[];
};

const BADGE: Record<MovementType, string> = {
  opening: "border-sky-500/20 bg-sky-500/10 text-sky-300",
  in: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  out: "border-red-500/20 bg-red-500/10 text-red-300",
};

// What a movement is called on this page: In or Out (an opening balance puts stock IN).
const ACTIVITY: Record<MovementType, string> = { opening: "In", in: "In", out: "Out" };

/** The stock the product had just BEFORE this movement: after minus what came in, or after plus what went out (exact decimals). */
const before = (m: Movement) => (isDebit(m.movement_type) ? sumMoney([m.balance_after, m.quantity]) : subtractMoney(m.balance_after, m.quantity));

export default function MovementHistory({ list, filters, products }: Props) {
  const router = useRouter();
  const stamp = useStamp();
  const [isPending, startTransition] = useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const [problem, setProblem] = useState<string | null>(null);

  // The bin icon takes a movement off this page. The stock ledger itself is permanent and is not changed (balances stay exactly as they are).
  async function remove(m: Movement) {
    const ok = await confirm({
      title: "Remove this movement from the list?",
      message: `${ACTIVITY[m.movement_type]} ${formatQuantity(m.quantity)} ${m.product_unit} of ${m.product_name}. It disappears from this page only: the stock ledger keeps it and your quantities do not change.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setProblem(null);
    const res = await fetch(`/api/stock/movements/${m.id}/hide`, { method: "POST" });
    const body = await res.json().catch(() => null);
    if (res.status === 401) return router.replace("/login");
    if (!res.ok) return setProblem(body?.error ?? "The movement could not be removed. Please try again.");
    startTransition(() => router.refresh());
  }

  function navigate(next: Partial<MovementFilters>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.productId) params.set("product", merged.productId);
    if (merged.type) params.set("type", merged.type);
    if (merged.page > 1) params.set("page", String(merged.page));
    const query = params.toString();
    startTransition(() => router.push(query ? `/movements?${query}` : "/movements"));
  }

  const filtered = Boolean(filters.productId || filters.type);
  const total = list.ok ? list.total : 0;
  const first = list.ok && list.items.length > 0 ? list.offset + 1 : 0;
  const last = list.ok ? list.offset + list.items.length : 0;
  const selectClass = "mt-1.5 block rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Stock Movements</h2>
        <p className="text-xs text-slate-400">
          Every change to your stock, newest first.
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
            Activity
            <select value={filters.type} onChange={(e) => navigate({ type: e.target.value as MovementFilters["type"] })} className={selectClass}>
              <option value="">All activity</option>
              {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY[t]}{t === "opening" ? " (opening balance)" : ""}</option>)}
            </select>
          </label>
        </div>

        {problem && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{problem}</p>}

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
              {filtered ? "No movements match these filters." : "No stock movements yet. They appear here as soon as you add or remove stock."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="border-b border-slate-800 bg-slate-900/80 text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Product</th>
                    <th className="px-4 py-3 text-center font-semibold">Quantity before</th>
                    <th className="px-4 py-3 text-center font-semibold">Quantity after</th>
                    <th className="px-4 py-3 text-center font-semibold">Order</th>
                    <th className="px-4 py-3 text-center font-semibold">Activity</th>
                    <th className="px-4 py-3 text-center font-semibold">Date and time</th>
                    <th className="px-4 py-3 text-center font-semibold">User</th>
                    <th className="px-4 py-3 text-center font-semibold"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {list.items.map((m) => (
                    <tr key={m.id} className="transition-colors hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{m.product_name}</div>
                        <div className="font-mono text-xs text-indigo-300">{m.product_sku}</div>
                      </td>
                      <td className="px-4 py-3 text-center font-mono text-xs whitespace-nowrap" data-testid={`before-${m.id}`}>{formatQuantity(before(m))}</td>
                      <td className="px-4 py-3 text-center font-mono text-xs whitespace-nowrap" data-testid={`after-${m.id}`}>{formatQuantity(m.balance_after)}</td>
                      <td className="px-4 py-3 text-center font-mono text-xs whitespace-nowrap" data-testid={`order-${m.id}`}>
                        {formatQuantity(m.quantity)} <span className="text-slate-500">{m.product_unit}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[m.movement_type]}`}>{ACTIVITY[m.movement_type]}</span>
                      </td>
                      <td className="px-4 py-3 text-center text-xs whitespace-nowrap text-slate-400">{stamp(m.created_at)}</td>
                      <td className="px-4 py-3 text-center text-xs text-slate-400">{m.created_by_email}</td>
                      <td className="px-4 py-3 text-center">
                        <Tooltip label="Remove from list">
                          <button type="button" onClick={() => void remove(m)} aria-label={`Remove the movement of ${m.product_name} from the list`} className="p-1.5 text-red-400 transition-colors hover:text-red-300 focus-visible:text-red-300 focus-visible:outline-none">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                          </button>
                        </Tooltip>
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
