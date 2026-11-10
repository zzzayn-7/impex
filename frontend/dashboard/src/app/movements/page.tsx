import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { MovementFilters, listMovements, listProductChoices } from "@/lib/inventory";
import { MOVEMENT_TYPES, MovementType } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import MovementHistory from "./movement-history";

export const metadata: Metadata = {
  title: "Stock Movements | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the product, type and page are read from the URL (ids must look like ids). There is no
// organization parameter: whose history is shown is decided on the server from the administrator's session.
function parseFilters(searchParams: SearchParams): MovementFilters {
  const product = (first(searchParams.product) ?? "").trim();
  const type = first(searchParams.type) ?? "";
  return {
    productId: UUID.test(product) ? product : "",
    type: (MOVEMENT_TYPES as string[]).includes(type) ? (type as MovementType) : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function MovementsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});

  const [list, products] = await Promise.all([
    listMovements(token, filters),
    listProductChoices(token, "active"),
  ]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");

  return <MovementHistory list={list} filters={filters} products={products} />;
}
