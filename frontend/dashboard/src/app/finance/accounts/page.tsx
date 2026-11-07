import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listAccounts } from "@/lib/finance";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import { Unavailable } from "../ui";
import AccountsManager from "./accounts-manager";

export const metadata: Metadata = {
  title: "Accounts | Impex Organization Portal",
};

export default async function AccountsPage() {
  await requireTenantAdmin();
  const result = await listAccounts(getTenantToken() ?? "");
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    return <Unavailable reason={result.reason} what="the accounts" />;
  }
  return <AccountsManager initial={result.accounts} />;
}
