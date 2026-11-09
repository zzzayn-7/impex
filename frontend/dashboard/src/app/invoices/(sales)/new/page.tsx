import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { loadPreferences } from "@/lib/preferences";
import { listBillableLines, listClientChoices } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import InvoiceForm from "../invoice-form";

export const metadata: Metadata = {
  title: "New Invoice | Impex Organization Portal",
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Which client comes from the URL; whose they are is decided by the Sales Service from the session. Another organization's client
// answers "not found", exactly like an id that does not exist.
export default async function NewInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const requested = (first(searchParams?.client) ?? "").trim();
  const [clients, preferences] = await Promise.all([listClientChoices(token, "all"), loadPreferences(token)]);
  const back = <Link href="/invoices/sales" className="text-xs text-indigo-300 hover:text-indigo-200">← All sales invoices</Link>;
  const heading = (
    <div>
      <h2 className="text-xl font-semibold text-white">New invoice</h2>
      <p className="text-xs text-slate-400">Bill a client for goods from their confirmed dispatches. Saving a draft does not change your stock.</p>
    </div>
  );

  if (!requested || !UUID_RE.test(requested)) {
    return (
      <div className="space-y-5">
        {back}
        {heading}
        <InvoiceForm clients={clients} clientId="" billable={[]} invoice={null} defaultCurrency={preferences.default_currency} />
      </div>
    );
  }

  const found = await listBillableLines(token, requested);
  if (!found.ok) {
    if (found.reason === "unauthorized") redirect("/login");
    const message = found.reason === "not-found" ? "Client not found."
      : found.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so invoices cannot be created. Please contact your platform administrator."
      : "Invoicing is temporarily unavailable. Please refresh in a moment.";
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{message}</p>
      </div>
    );
  }
  const client = clients.find((c) => c.id === requested);
  return (
    <div className="space-y-5">
      {back}
      {heading}
      {client && !client.is_active && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">This client is inactive. Reactivate them in Clients before creating an invoice.</p>}
      <InvoiceForm key={requested} clients={clients} clientId={requested} billable={found.lines} invoice={null} defaultCurrency={preferences.default_currency} />
    </div>
  );
}
