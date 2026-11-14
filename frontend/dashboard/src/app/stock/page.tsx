import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StockFilters, listProductChoices, listStock } from "@/lib/inventory";
import { stockTotals } from "@/lib/stock-totals";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import StockOverview from "./stock-overview";

export const metadata: Metadata = {
  title: "Stock | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only these filters are read from the URL. There is no organization parameter: whose stock
// is shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): StockFilters {
  const status = first(searchParams.status);
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    inStockOnly: false, // (the "in stock only" filter is gone from the page)
    status: status === "archived" || status === "all" ? status : "active",
    page: 1, // the list scrolls: the first rows come with the page, the rest as the reader reaches the end
  };
}

export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});

  const [list, products, totals] = await Promise.all([
    listStock(token, filters),
    listProductChoices(token, "active"),
    stockTotals(token, filters),
  ]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return <StockOverview list={list} filters={filters} products={products} totals={totals} />;
}
