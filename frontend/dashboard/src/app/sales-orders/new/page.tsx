import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page";
import { listClientChoices } from "@/lib/sales";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import CreateOrderForm from "./create-order-form";

export const metadata: Metadata = {
  title: "Create Order | Impex Organization Portal",
};
export const dynamic = "force-dynamic";

// Whose clients and products are offered is decided on the server from the signed-in administrator's session; nothing here names an organization.
export default async function CreateOrderPage() {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const clients = await listClientChoices(getTenantToken() ?? "", "active");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Create Order" subtitle="Choose the client, then add the products they need from your inventory. The stock is reserved when you save, and a delivery list is generated for you." />
      <CreateOrderForm clients={clients} />
    </div>
  );
}
