import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OrderFilters, listPurchaseOrders, listSupplierChoices } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import OrderIndex from "./order-index";

export const metadata: Metadata = {
  title: "Purchase Orders | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the search text, the supplier id, the status and the page number are read from the URL. There is no organization
// parameter: whose orders are shown is decided on the server from the signed-in administrator's session, and a supplier id
// from another organization simply matches nothing.
function parseFilters(searchParams: SearchParams): OrderFilters {
  const status = first(searchParams.status);
  const supplier = (first(searchParams.supplier) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    supplierId: UUID_RE.test(supplier) ? supplier : "",
    status: status === "draft" || status === "ordered" || status === "cancelled" ? status : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, suppliers] = await Promise.all([listPurchaseOrders(token, filters), listSupplierChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <OrderIndex list={list} filters={filters} suppliers={suppliers} />;
}
