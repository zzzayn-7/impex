import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getOrderInvoice } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import OrderInvoiceView from "./order-invoice-view";

export const metadata: Metadata = {
  title: "Invoice | Impex Organization Portal",
};

// One order invoice, read-only. Whose it is comes from the session: another organization's invoice answers "not found", exactly like an id that does not exist.
export default async function OrderInvoicePage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/invoices/sales/history" className="text-xs text-indigo-300 hover:text-indigo-200">← Invoice history</Link>;
  if (!UUID_RE.test(params.id)) return <Message back={back} text="Invoice not found." />;
  const result = await getOrderInvoice(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return <Message back={back} text={result.reason === "not-found" ? "Invoice not found." : result.reason === "forbidden" ? "Your organization is currently inactive or unavailable. Please contact your platform administrator." : "Invoices are temporarily unavailable. Please refresh in a moment."} />;
  }
  return <div className="space-y-4">{back}<OrderInvoiceView invoice={result.invoice} /></div>;
}

function Message({ back, text }: { back: React.ReactNode; text: string }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
}
