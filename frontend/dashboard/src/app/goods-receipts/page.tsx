import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listWarehouseChoices } from "@/lib/inventory";
import { ReceiptFilters, listGoodsReceipts, listSupplierChoices } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ReceiptIndex from "./receipt-index";

export const metadata: Metadata = {
  title: "Goods Receipts | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Only search text, status, supplier, warehouse, two dates and the page number are read from the URL. There is no organization
// parameter: whose receipts are shown is decided on the server from the signed-in administrator's session.
function parseFilters(searchParams: SearchParams): ReceiptFilters {
  const status = first(searchParams.status);
  const supplier = (first(searchParams.supplier) ?? "").trim();
  const warehouse = (first(searchParams.warehouse) ?? "").trim();
  const from = (first(searchParams.from) ?? "").trim();
  const to = (first(searchParams.to) ?? "").trim();
  return {
    q: (first(searchParams.q) ?? "").trim().slice(0, 100),
    status: status === "draft" || status === "posting" || status === "confirmed" || status === "cancelled" ? status : "",
    supplierId: UUID_RE.test(supplier) ? supplier : "",
    warehouseId: UUID_RE.test(warehouse) ? warehouse : "",
    dateFrom: DATE_RE.test(from) ? from : "",
    dateTo: DATE_RE.test(to) ? to : "",
    page: Math.max(1, Math.min(10000, parseInt(first(searchParams.page) ?? "1", 10) || 1)),
  };
}

export default async function GoodsReceiptsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const filters = parseFilters(searchParams ?? {});
  const [list, suppliers, warehouses] = await Promise.all([listGoodsReceipts(token, filters), listSupplierChoices(token, "all"), listWarehouseChoices(token, "all")]);
  if (!list.ok && list.reason === "unauthorized") redirect("/login");
  return <ReceiptIndex list={list} filters={filters} suppliers={suppliers} warehouses={warehouses} />;
}
