import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StockFilters, listProductChoices, listStock, listWarehouseChoices } from "@/lib/inventory";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import StockOverview from "./stock-overview";

export const metadata: Metadata = {
  title: "Stock | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these filters and the page number are read from the URL. There is no organization parameter: whose stock
// is shown is decided on the server from the signed-in administrator's session. A warehouse id that is not in
// the URL's owner's organization simply matches nothing (the service scopes every query).
function parseFilters(searchParams: SearchParams): StockFilters {
  const status = first(searchParams.status);
  const warehouseId = (first(searchParams.warehouse) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    category: "",
    warehouseId: UUID.test(warehouseId) ? warehouseId : "",
    inStockOnly: first(searchParams.inStock) === "1",
    status: status === "archived" || status === "all" ? status : "active",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function StockPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});

  const [list, products, warehouses] = await Promise.all([
    listStock(token, filters),
    listProductChoices(token, "active"),
    listWarehouseChoices(token, "all"),
  ]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return <StockOverview list={list} filters={filters} products={products} warehouses={warehouses} />;
}
