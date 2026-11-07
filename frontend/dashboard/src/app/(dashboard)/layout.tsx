import { redirect } from "next/navigation";

import DashboardFrame from "@/components/dashboard/frame";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

// The Organization Dashboard's frame. The session and first-time-setup checks run HERE, in the layout, before the page streams its loading
// skeleton, so a missing session is a true redirect to /login and an unfinished setup a true redirect to /setup (typing the address cannot skip
// the wizard). If the Organization Service cannot answer, setup is never assumed complete: the frame is shown with a recoverable message.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);
  if (workspace.kind === "setup") redirect("/setup");
  const organization = workspace.kind === "ready" ? workspace.organization : null;
  return <DashboardFrame admin={admin} organization={organization}>{children}</DashboardFrame>;
}
