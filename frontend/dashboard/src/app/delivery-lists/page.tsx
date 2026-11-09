import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listClientChoices, listOrders, listUnlinkedLists } from "@/lib/sales";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DeliveryBoard from "./delivery-board";

export const metadata: Metadata = {
  title: "Delivery Lists | Impex Organization Portal",
};
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Only the view (active / history) and a "just created" order number are read from the URL. There is no organization parameter: whose orders
// are shown is decided on the server from the signed-in administrator's session. The 24-hour Delivered History window is applied by the Sales
// Service on its own clock, so every administrator and every reload sees the same list.
export default async function DeliveryListsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const token = getTenantToken() ?? "";
  const view = first(searchParams?.view) === "history" ? "history" : "active";
  const created = (first(searchParams?.created) ?? "").trim();
  const [orders, others, clients] = await Promise.all([
    listOrders(token, view === "history" ? "delivered" : "active"),
    view === "active" ? listUnlinkedLists(token) : Promise.resolve(null),
    view === "active" ? listClientChoices(token, "active") : Promise.resolve([]),
  ]);
  if (!orders.ok && orders.reason === "unauthorized") redirect("/login");
  return <DeliveryBoard view={view} orders={orders} others={others} clients={clients} created={/^SO-\d{6}$/.test(created) ? created : null} />;
}
