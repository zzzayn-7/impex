import { redirect } from "next/navigation";

import DashboardView from "@/components/dashboard/view";
import { loadDashboardData } from "@/lib/dashboard-data";
import { normalizePreferences } from "@/lib/format";
import { setupNeed } from "@/lib/onboarding";
import { fetchTenantOrganization } from "@/lib/organization";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";

// Organization dashboard: the administrator's own organization, with real figures from the services it has enabled.
// This page takes no parameters on purpose: which organization to show is decided on the server from the signed-in administrator, never from
// the URL or the browser. Each service is asked with the administrator's own session token and answers only for that organization; a module
// that is not enabled is not asked at all (lib/dashboard-data.ts).
export default async function OrganizationDashboard() {
  // Redirects to /login unless the session belongs to an active organization administrator (the layout checks this first, too).
  const admin = await requireTenantAdmin();
  const token = getTenantToken() ?? "";
  const result = await fetchTenantOrganization(token);
  if (!result.ok && result.reason === "unauthorized") redirect("/login");
  // First-time onboarding is enforced here as well as in the layout: setup is never assumed complete.
  if (result.ok && setupNeed(admin, result.organization).required) redirect("/setup");
  // An organization whose details could not be read has no module list, so no business figures are asked for (an unknown list means none).
  const data = await loadDashboardData(token, result.ok ? result.organization.modules : undefined, normalizePreferences(result.ok ? result.organization : null));
  return <DashboardView admin={admin} organizationResult={result} data={data} />;
}
