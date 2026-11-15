import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ReceiptFilters, listGoodsReceipts, listSupplierChoices } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import PurchaseHistory from "./purchase-history";

export const metadata: Metadata = {
  title: "Purchase Invoice History | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only the supplier, one date and the page number are read from the URL (alone or together). There is no organization parameter: whose receipts are shown is decided on the
// server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): ReceiptFilters {
  const supplier = (first(searchParams.supplier) ?? "").trim();
  const date = (first(searchParams.date) ?? "").trim();
  const day = DATE_RE.test(date) ? date : "";
  return {
    q: "",
    status: "",
    supplierId: UUID_RE.test(supplier) ? supplier : "",
    dateFrom: day,
    dateTo: day,
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function PurchaseInvoiceHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, suppliers] = await Promise.all([listGoodsReceipts(token, filters), listSupplierChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <PurchaseHistory list={list} filters={filters} suppliers={suppliers} />;
}
