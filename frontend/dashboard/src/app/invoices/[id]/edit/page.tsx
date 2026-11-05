import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getInvoice, listBillableLines } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import InvoiceForm from "../../invoice-form";

export const metadata: Metadata = {
  title: "Edit Draft Invoice | Impex Organization Portal",
};

// Only a DRAFT can be edited; an issued, paid or void invoice is frozen and is shown on its own page instead.
export default async function EditInvoicePage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <Link href={UUID_RE.test(params.id) ? `/invoices/${params.id}` : "/invoices"} className="text-xs text-indigo-300 hover:text-indigo-200">← Back to the invoice</Link>;
  const message = (text: string) => (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
  if (!UUID_RE.test(params.id)) return message("Invoice not found.");
  const token = getTenantToken() ?? "";
  const result = await getInvoice(token, params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return message(result.reason === "not-found" ? "Invoice not found." : "This invoice is temporarily unavailable. Please refresh in a moment.");
  }
  const invoice = result.invoice;
  if (!invoice.editable) return message(`${invoice.number ?? "This invoice"} is no longer a draft, so it cannot be edited. Issued invoices are frozen; to correct one, void it (after reversing any payments) and issue a new one.`);
  const billable = await listBillableLines(token, invoice.client.id);
  return (
    <div className="space-y-5">
      {back}
      <div>
        <h2 className="text-xl font-semibold text-white">Edit draft invoice</h2>
        <p className="text-xs text-slate-400">For {invoice.client.name}. Saving a draft does not change your stock.</p>
      </div>
      <InvoiceForm
        key={invoice.id + invoice.updated_at} clients={[]} clientId={invoice.client.id} billable={billable.ok ? billable.lines : []} invoice={invoice}
        problem={billable.ok ? undefined : "The dispatched goods could not be loaded right now. Please refresh in a moment."}
      />
    </div>
  );
}
