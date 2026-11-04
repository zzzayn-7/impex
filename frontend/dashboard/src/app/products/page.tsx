import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ProductFilters, listCategories, listProducts } from "@/lib/inventory";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ProductCatalog from "./product-catalog";

export const metadata: Metadata = {
  title: "Products | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only these three filters and the page number are read from the URL. There is no organization parameter:
// whose catalog is shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): ProductFilters {
  const status = first(searchParams.status);
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    category: (first(searchParams.category) ?? "").trim().slice(0, 100),
    status: status === "archived" || status === "all" ? status : "active",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  // The layout already redirects invalid sessions (before streaming starts); this keeps the page safe on its own too.
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});

  const [list, categories] = await Promise.all([listProducts(token, filters), listCategories(token)]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return <ProductCatalog list={list} categories={categories} filters={filters} />;
}
