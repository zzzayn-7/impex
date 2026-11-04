import type { Metadata } from "next";

import { listWarehouseChoices } from "@/lib/inventory";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ScanProduct from "./scan-product";

export const metadata: Metadata = {
  title: "Scan Product | Impex Organization Portal",
};

// Which products can be found is decided by the Inventory Service from the signed-in
// administrator's session; the only data loaded here is the organization's own active warehouses (for the stock forms).
type SearchParams = Record<string, string | string[] | undefined>;

export default async function ScanPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const warehouses = await listWarehouseChoices(getTenantToken() ?? "", "active");
  // ?list=<id> (from a delivery list's "Scan products for this list") pre-selects that draft. It is only a suggestion:
  // the Sales Service decides whether the list exists, is a draft, and is the caller's.
  const raw = (searchParams ?? {}).list;
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  return <ScanProduct warehouses={warehouses} initialListId={wanted && UUID_RE.test(wanted) ? wanted : null} />;
}
