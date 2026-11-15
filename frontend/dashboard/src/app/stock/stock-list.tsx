"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/components/ui/confirm";
import { Tooltip } from "@/components/ui/tooltip";
import ProductModal from "@/components/product/product-modal";
import { formatMoney, lineTotal } from "@/lib/product-validation";
import { StockProduct, formatQuantity } from "@/lib/stock-validation";

// The Stock table as a SCROLLING list: there are no pages and no Previous / Next. The first rows arrive with the page; the next ones are fetched from
// /api/stock/items when the reader scrolls to the end of the list, so the list simply keeps going. It is used twice: in the Stock page (a list with its own
// scroll bar, `full` off) and in the Full view page (the whole list from top to bottom, scrolling with the page, `full` on).
//
// A row's actions are four icons:
//   Edit      opens the product dialog on its edit form;
//   Archive   takes the product off the Stock list and out of everything new (orders, purchases) but ERASES NOTHING: history stays, and it can be restored
//             (Restore takes its place on an archived row);
//   Delete    removes the product FOR GOOD, with its stock and stock history (orders, receipts and invoices keep their own copy of its name and SKU).
//             It always asks first, in plain words, and the Inventory Service refuses while sales orders still hold stock of it.

const PAGE_SIZE = 25;

/** A price with its currency, or a dash when the service did not send one. */
const money = (amount?: string | null, currency?: string | null) => (amount && currency ? formatMoney(amount, currency) : "—");

type Filters = { q: string; status: "active" | "archived" | "all" };
type Items = { items: StockProduct[]; total: number } | null;

const icon = "h-[18px] w-[18px]";
const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export default function StockList({ initial, total: initialTotal, filters, full = false, onChanged, filtered }: {
  initial: StockProduct[];
  total: number;
  filters: Filters;
  /** The Full view page: no height limit of its own. */
  full?: boolean;
  /** Something was archived / restored / deleted / edited: the page re-reads what it shows besides this list (the total cost). */
  onChanged?: () => void;
  filtered: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<StockProduct[]>(initial);
  const [total, setTotal] = useState(initialTotal);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const pages = useRef(Math.max(1, Math.ceil(initial.length / PAGE_SIZE)));
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const hasMore = items.length < total;

  // The page re-reads its first rows after something changed outside this list (a product was added, stock was entered with Stock In). If those rows differ from the
  // top of what is shown, start again from them; if they are the same (our own change, already re-read), the reader keeps the place in the list.
  const shown = useRef(items);
  shown.current = items;
  useEffect(() => {
    const head = shown.current.slice(0, initial.length);
    if (JSON.stringify(head) === JSON.stringify(initial)) { setTotal(initialTotal); return; }
    setItems(initial);
    setTotal(initialTotal);
    pages.current = Math.max(1, Math.ceil(initial.length / PAGE_SIZE));
  }, [initial, initialTotal]);

  const fetchPage = useCallback(async (page: number): Promise<Items> => {
    const params = new URLSearchParams({ page: String(page), status: filters.status });
    if (filters.q) params.set("q", filters.q);
    const res = await fetch(`/api/stock/items?${params}`, { cache: "no-store" });
    if (res.status === 401) { router.replace("/login"); return null; }
    if (!res.ok) throw new Error("load failed");
    const data = await res.json();
    return { items: data.items as StockProduct[], total: Number(data.total) };
  }, [filters.q, filters.status, router]);

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const next = await fetchPage(pages.current + 1);
      if (next) {
        pages.current += 1;
        setItems((current) => {
          const known = new Set(current.map((i) => i.product_id));
          return [...current, ...next.items.filter((i) => !known.has(i.product_id))];
        });
        setTotal(next.total);
      }
    } catch {
      setMoreFailed(true);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage]);

  // After a change, re-read everything that is already on screen (the same pages), so rows move up into the gap instead of leaving it or being skipped.
  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const wanted = pages.current;
      const results = await Promise.all(Array.from({ length: wanted }, (_, index) => fetchPage(index + 1)));
      if (results.every(Boolean)) {
        const rows = results.flatMap((r) => r!.items);
        const seen = new Set<string>();
        setItems(rows.filter((row) => (seen.has(row.product_id) ? false : (seen.add(row.product_id), true))));
        setTotal(results[results.length - 1]!.total);
        pages.current = Math.max(1, wanted);
      }
    } catch {
      setProblem("The list could not be refreshed. Please reload the page.");
    } finally {
      busy.current = false;
    }
    onChanged?.();
  }, [fetchPage, onChanged]);

  // The next rows are fetched as the end of the list comes into view (inside the list's own scroll area, or on the page in the Full view).
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); }, { root: full ? null : scroller.current, rootMargin: "160px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, full, items.length]);

  async function run(item: StockProduct, request: () => Promise<Response>, success: string, failure: string) {
    setBusyId(item.product_id);
    setMessage(null);
    setProblem(null);
    try {
      const res = await request();
      const body = await res.json().catch(() => null);
      if (res.status === 401) return router.replace("/login");
      if (!res.ok) return setProblem(body?.error ?? failure);
      setMessage(success);
      await reload();
    } catch {
      setProblem("Unable to reach the server. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(item: StockProduct) {
    const ok = await confirm({
      title: `Archive ${item.name}?`,
      message: "It is taken off your Stock list and can no longer be ordered, bought or counted. Nothing is erased: its stock movements, orders, receipts and invoices keep their history, and you can bring it back with Restore.",
      confirmLabel: "Archive product",
      danger: false,
    });
    if (ok) await run(item, () => fetch(`/api/products/${item.product_id}/archive`, { method: "POST" }), `${item.name} was archived. Show Archived products to restore it.`, "The product could not be archived. Please try again.");
  }

  async function restore(item: StockProduct) {
    await run(item, () => fetch(`/api/products/${item.product_id}/restore`, { method: "POST" }), `${item.name} was restored.`, "The product could not be restored. Please try again.");
  }

  async function remove(item: StockProduct) {
    const ok = await confirm({
      title: `Delete ${item.name} for good?`,
      message: "This removes the product from your organization completely, together with its stock and its stock history. It cannot be undone. Orders, receipts and invoices that already mention it keep their own copy of its name and SKU. To keep the history and only hide the product, archive it instead.",
      confirmLabel: "Delete permanently",
    });
    if (ok) await run(item, () => fetch(`/api/products/${item.product_id}`, { method: "DELETE" }), `${item.name} was deleted.`, "The product could not be deleted. Please try again.");
  }

  const btn = "p-1.5 text-slate-400 transition-colors hover:text-white focus-visible:text-white focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="space-y-3">
      {message && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">✕</button>
        </div>
      )}
      {problem && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">{problem}</p>}

      {editingId && (
        <ProductModal
          productId={editingId}
          startEditing
          onClose={() => setEditingId(null)}
          onChanged={(text) => { setMessage(text); void reload(); }}
        />
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          {filtered ? "No products match these filters." : "No products yet. Use Add Stock to register your first product, or register one while creating a purchase order."}
        </p>
      ) : (
        <div ref={scroller} data-testid="stock-scroller" className={full ? "overflow-x-auto" : "max-h-[28rem] overflow-auto overscroll-contain"}>
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900 text-xs uppercase text-slate-400">
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
              {items.map((item) => (
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
                        <button type="button" onClick={() => { setMessage(null); setProblem(null); setEditingId(item.product_id); }} aria-haspopup="dialog" aria-label={`Edit ${item.name}`} className={btn}>
                          <svg {...iconProps} className={icon}><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" /></svg>
                        </button>
                      </Tooltip>
                      {item.is_active ? (
                        <Tooltip label="Archive">
                          <button type="button" onClick={() => archive(item)} disabled={busyId === item.product_id} aria-label={`Archive ${item.name}`} className={btn}>
                            <svg {...iconProps} className={icon}><path d="M4 5h16v4H4zM5.5 9v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M10 13h4" /></svg>
                          </button>
                        </Tooltip>
                      ) : (
                        <Tooltip label="Restore">
                          <button type="button" onClick={() => restore(item)} disabled={busyId === item.product_id} aria-label={`Restore ${item.name}`} className={btn}>
                            <svg {...iconProps} className={icon}><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip label="Delete">
                        <button type="button" onClick={() => remove(item)} disabled={busyId === item.product_id} aria-label={`Delete ${item.name}`} className="p-1.5 text-red-400 transition-colors hover:text-red-300 focus-visible:text-red-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-red-400">
                          <svg {...iconProps} className={icon}><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" /></svg>
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div ref={sentinel} className="flex items-center justify-center py-3 text-xs text-slate-500" role="status">
              {moreFailed ? (
                <button type="button" onClick={() => void loadMore()} className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800">Could not load more. Try again</button>
              ) : loadingMore ? "Loading more…" : <span aria-hidden="true">&nbsp;</span>}
            </div>
          )}
        </div>
      )}
      {items.length > 0 && (
        <p className="text-xs text-slate-400" data-testid="stock-count">Showing {items.length} of {total}</p>
      )}
      {confirmDialog}
    </div>
  );
}
