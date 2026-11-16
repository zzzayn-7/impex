import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getOrderExpenses } from "@/lib/finance";
import { loadProductCosts } from "@/lib/inventory";
import { goodsCostOf } from "@/lib/pnl";
import { getOrder } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import PnlForm from "./pnl-form";

export const metadata: Metadata = {
  title: "PNL Calculator | Impex Organization Portal",
};

// Finance > PNL Calculator > one order: its selling price (the order's own total), then the expenses to enter, then the result. Whose order it is comes from the session: another
// organization's order answers "not found", exactly like an id that does not exist.
export default async function PnlOrderPage({ params }: { params: { orderId: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/pnl-calculator" className="text-xs text-indigo-300 hover:text-indigo-200">← Orders</Link>;
  if (!UUID_RE.test(params.orderId)) return <Message back={back} text="Order not found." />;
  const token = getTenantToken() ?? "";
  const result = await getOrder(token, params.orderId);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return <Message back={back} text={result.reason === "not-found" ? "Order not found." : result.reason === "forbidden" ? "Orders are not available. This calculator reads your orders from the Sales module, which must be enabled for your organization." : "Orders are temporarily unavailable. Please refresh in a moment."} />;
  }
  const order = result.order;
  if (order.prices_recorded === false || !order.total_amount || !order.currency_code) return <Message back={back} text={`${order.number} has no prices, so its profit cannot be worked out.`} />;
  const [saved, costs] = await Promise.all([getOrderExpenses(token, order.id), loadProductCosts(token, order.lines.map((l) => l.product_id))]);
  const suggested = goodsCostOf(order.lines, costs, order.currency_code);
  return <div className="space-y-4">{back}<PnlForm order={order} saved={saved} suggested={suggested} /></div>;
}

function Message({ back, text }: { back: React.ReactNode; text: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
}
