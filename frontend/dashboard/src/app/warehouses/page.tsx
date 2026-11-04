import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { WarehouseFilters, listWarehouses } from "@/lib/inventory";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import WarehouseManager from "./warehouse-manager";

export const metadata: Metadata = {
  title: "Warehouses | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the search text, the status and the page number are read from the URL. There is no organization
// parameter: whose warehouses are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): WarehouseFilters {
  const status = first(searchParams.status);
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: status === "archived" || status === "all" ? status : "active",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function WarehousesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});

  const list = await listWarehouses(token, filters);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return <WarehouseManager list={list} filters={filters} />;
}
