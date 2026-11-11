import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { fetchTenantOrganization } from "@/lib/organization";
import { getHistory, getSettings } from "@/lib/settings";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import SettingsView from "./settings-view";

export const metadata: Metadata = {
  title: "Settings | Impex Organization Portal",
};
export const dynamic = "force-dynamic";

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-2 rounded-2xl border border-ix-mist/15 bg-transparent p-6 text-center">
      <p className="text-sm font-semibold text-ix-text">{title}</p>
      <p className="text-xs text-ix-muted">{text}</p>
    </div>
  );
}

// Everything on this page is read from the services with the signed-in administrator's own session: the company from the Organization
// Service, the modules from the same record, the administrator's own account from the Auth Service. Nothing is hardcoded or kept in the
// browser. The page takes no parameters on purpose: whose settings these are is decided on the server from the session.
export default async function SettingsPage() {
  const admin = await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const [result, organization] = await Promise.all([getSettings(token), fetchTenantOrganization(token)]);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "setup-required") redirect("/setup"); // Settings open once first-time setup is complete
    return result.reason === "forbidden"
      ? <Problem title="Settings are not available" text="Your organization is currently inactive or unavailable. Please contact your platform administrator." />
      : <Problem title="Settings are temporarily unavailable" text="Nothing was lost. Please refresh in a moment." />;
  }
  const history = await getHistory(token);
  return (
    <SettingsView
      initial={result.settings}
      history={history}
      admin={{ id: admin.id, full_name: admin.full_name, email: admin.email, role: admin.role, organization_id: admin.organization_id ?? "" }}
      now={new Date().toISOString()}
    />
  );
}
