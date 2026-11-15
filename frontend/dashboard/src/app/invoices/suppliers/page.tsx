import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ReceivableFilters, listReceivableOrders, listSupplierChoices } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import NewPurchaseInvoice from "./new-purchase-invoice";

export const metadata: Metadata = {
  title: "Purchase Invoice | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the supplier, the search text and the page number are read from the URL. There is no organization parameter: whose orders are shown is decided on the server from the
// signed-in administrator's session.
function parseFilters(searchParams: SearchParams): ReceivableFilters {
  const supplier = (first(searchParams.supplier) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    supplierId: UUID_RE.test(supplier) ? supplier : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

// Purchase Invoice > New invoice: the purchase orders still waiting for goods, newest first, for one supplier or for all of them. Choosing one opens the form that records the goods.
export default async function PurchaseInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, suppliers] = await Promise.all([listReceivableOrders(token, filters), listSupplierChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <NewPurchaseInvoice list={list} filters={filters} suppliers={suppliers} />;
}
