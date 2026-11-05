import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getClientAccount } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ClientAccountView from "./client-account";

export const metadata: Metadata = {
  title: "Client | Impex Organization Portal",
};

// Another organization's client answers "not found", exactly like an id that does not exist.
export default async function ClientPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/clients" className="text-xs text-indigo-300 hover:text-indigo-200">← All clients</Link>;
  const message = (text: string) => (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>
    </div>
  );
  if (!UUID_RE.test(params.id)) return message("Client not found.");
  const result = await getClientAccount(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return message("Client not found.");
    return message(result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so client accounts cannot be shown. Please contact your platform administrator." : "This client's account is temporarily unavailable. Please refresh in a moment.");
  }
  return (
    <div className="space-y-5">
      {back}
      <ClientAccountView account={result.account} />
    </div>
  );
}
