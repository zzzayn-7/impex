import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getOrder, listOrderInvoiceRefs } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import CreateInvoice from "./create-invoice";

export const metadata: Metadata = {
  title: "New Sales Invoice | Impex Organization Portal",
};

// Sales Invoice > New invoice > one order: its details, read-only, before the invoice is made. Nothing is saved by opening this page. Installments (top right) or Print / Download
// (bottom right) make the invoice. An order that already has its invoice goes straight to it. Whose order it is comes from the session.
export default async function CreateInvoicePage({ params }: { params: { orderId: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/invoices/sales" className="text-xs text-indigo-300 hover:text-indigo-200">← New invoice</Link>;
  if (!UUID_RE.test(params.orderId)) return <Message back={back} text="Order not found." />;
  const token = getTenantToken() ?? "";
  const result = await getOrder(token, params.orderId);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return <Message back={back} text={result.reason === "not-found" ? "Order not found." : result.reason === "forbidden" ? "Your organization is currently inactive or unavailable. Please contact your platform administrator." : "Orders are temporarily unavailable. Please refresh in a moment."} />;
  }
  const existing = (await listOrderInvoiceRefs(token, [result.order.id]))[0];
  if (existing) redirect(`/invoices/sales/${existing.invoice_id}`);
  const order = result.order;
  if (order.status !== "active") return <Message back={back} text={`${order.number} is not waiting to be dispatched, so it cannot be invoiced.`} />;
  if (order.prices_recorded === false) return <Message back={back} text={`${order.number} has no prices, so it cannot be invoiced.`} />;
  return <div className="space-y-4">{back}<CreateInvoice order={order} /></div>;
}

function Message({ back, text }: { back: React.ReactNode; text: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
}
