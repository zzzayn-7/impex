import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { StockFilters, listStock } from "@/lib/inventory";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import FullStockList from "./full-stock-list";

export const metadata: Metadata = {
  title: "Stock, full view | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// The whole Stock list from top to bottom. The same filters as the Stock page (search text and Active / Archived / All) come from the address; the list scrolls with
// the page and loads more rows as the reader reaches the end. Whose stock is shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): StockFilters {
  const status = first(searchParams.status);
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    inStockOnly: false,
    status: status === "archived" || status === "all" ? status : "active",
    page: 1,
  };
}

export default async function StockFullPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const list = await listStock(token, filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  const back = (() => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.status !== "active") params.set("status", filters.status);
    const query = params.toString();
    return query ? `/stock?${query}` : "/stock";
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Stock, full view</h2>
          <p className="text-xs text-slate-400">The whole list, top to bottom. Keep scrolling and more products load.</p>
        </div>
        <Link href={back} className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800">Back to Stock</Link>
      </div>
      <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-5">
        {!list.ok ? (
          <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
            {list.reason === "forbidden"
              ? "Your organization is currently inactive or unavailable, so stock cannot be used. Please contact your platform administrator."
              : "Stock is temporarily unavailable. Please refresh in a moment."}
          </div>
        ) : (
          <FullStockList initial={list.items} total={list.total} filters={{ q: filters.q, status: filters.status }} />
        )}
      </section>
    </div>
  );
}
