import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getPurchaseOrder, listSupplierChoices } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import OrderDetail from "./order-detail";

export const metadata: Metadata = {
  title: "Purchase Order | Impex Organization Portal",
};

// The order comes from the URL, but whose order it is is decided by the Purchasing Service from the session: another
// organization's order answers "not found", exactly like an id that does not exist.
export default async function PurchaseOrderPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const back = <Link href="/purchase-orders" className="text-xs text-indigo-300 hover:text-indigo-200">← All purchase orders</Link>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;

  const token = getTenantToken() ?? "";
  const result = await getPurchaseOrder(token, params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {result.reason === "forbidden"
            ? "Your organization is currently inactive or unavailable, so purchase orders cannot be used. Please contact your platform administrator."
            : "This purchase order is temporarily unavailable. Please refresh in a moment."}
        </div>
      </div>
    );
  }
  // Pickers are only needed while the order can still be edited.
  const editable = result.order.status === "draft";
  const suppliers = editable ? await listSupplierChoices(token, "active") : [];
  return (
    <div className="space-y-5">
      {back}
      <OrderDetail order={result.order} suppliers={suppliers} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Purchase order not found.</p>
    </div>
  );
}
