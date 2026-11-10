import type { Metadata } from "next";

import { loadPreferences } from "@/lib/preferences";
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
  const token = getTenantToken() ?? "";
  // The order's currency starts from the organization's default currency (Settings); it is stored on the order, so a later change never touches it.
  const [clients, preferences] = await Promise.all([listClientChoices(token, "active"), loadPreferences(token)]);
  return (
    <div className="mx-auto max-w-6xl">
      <CreateOrderForm clients={clients} defaultCurrency={preferences.default_currency} />
    </div>
  );
}
