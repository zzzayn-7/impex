import type { Metadata } from "next";

import { listWarehouseChoices } from "@/lib/inventory";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ScanProduct from "./scan-product";

export const metadata: Metadata = {
  title: "Scan Product | Impex Organization Portal",
};

// The page takes no parameters. Which products can be found is decided by the Inventory Service from the signed-in
// administrator's session; the only data loaded here is the organization's own active warehouses (for the stock forms).
export default async function ScanPage() {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const warehouses = await listWarehouseChoices(getTenantToken() ?? "", "active");
  return <ScanProduct warehouses={warehouses} />;
}
