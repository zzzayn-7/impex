import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { listWarehouseChoices } from "@/lib/inventory";
import { getGoodsReceipt, getPurchaseOrder } from "@/lib/purchasing";
import { ORDER_STATUS_LABELS } from "@/lib/purchasing-browser";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ReceiveForm from "./receive-form";

export const metadata: Metadata = {
  title: "Receive Goods | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Which order, and which draft to resume, come from the URL; whose they are is decided by the Purchasing Service from the
// session. Another organization's order or receipt answers "not found", exactly like an id that does not exist.
export default async function ReceiveGoodsPage({ params, searchParams }: { params: { id: string }; searchParams: SearchParams }) {
  await requireTenantAdmin();
  const back = <Link href={UUID_RE.test(params.id) ? `/purchase-orders/${params.id}` : "/purchase-orders"} className="text-xs text-indigo-300 hover:text-indigo-200">← Back to the purchase order</Link>;
  if (!UUID_RE.test(params.id)) return <Message back={back} text="Purchase order not found." />;

  const token = getTenantToken() ?? "";
  const result = await getPurchaseOrder(token, params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Message back={back} text="Purchase order not found." />;
    return <Message back={back} text={result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so goods cannot be received. Please contact your platform administrator." : "This purchase order is temporarily unavailable. Please refresh in a moment."} />;
  }
  const order = result.order;

  let draft = null;
  const resume = (first(searchParams?.receipt) ?? "").trim();
  if (UUID_RE.test(resume)) {
    const found = await getGoodsReceipt(token, resume);
    if (found.ok && found.receipt.purchase_order.id === order.id && found.receipt.status === "draft") draft = found.receipt;
  }

  const receivable = Boolean(order.can_receive);
  if (!receivable) {
    return (
      <div className="space-y-4">
        {back}
        <h2 className="font-mono text-xl font-semibold text-white">{order.number}</h2>
        <p role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {order.status === "draft" && `${order.number} is still a draft. Place the order before receiving goods against it.`}
          {order.status === "cancelled" && `${order.number} is cancelled. Goods cannot be received against it.`}
          {order.status === "received" && `${order.number} is already fully received. There is nothing left to receive.`}
          {!["draft", "cancelled", "received"].includes(order.status) && `${order.number} is ${ORDER_STATUS_LABELS[order.status]}; there is nothing left to receive right now (goods being posted are reserved until they are confirmed).`}
        </p>
      </div>
    );
  }
  const warehouses = await listWarehouseChoices(token, "active");
  return (
    <div className="space-y-5">
      {back}
      <div>
        <h2 className="text-xl font-semibold text-white">Receive goods · <span className="font-mono">{order.number}</span></h2>
        <p className="text-xs text-slate-400">From {order.supplier.name}. Enter what arrived, review it, then confirm to add the accepted quantities to stock.</p>
      </div>
      {warehouses.length === 0 && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">You have no active warehouse. Create one in Warehouses before receiving goods.</p>}
      <ReceiveForm key={draft?.id ?? "new"} order={order} warehouses={warehouses} draft={draft} />
    </div>
  );
}

function Message({ back, text }: { back: React.ReactNode; text: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
}
