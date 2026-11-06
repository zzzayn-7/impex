import ModuleAccessDenied from "@/components/module-access-denied";
import PortalHeader from "@/components/portal-header";
import { NAV_MODULE, canUse } from "@/lib/modules";
import { redirect } from "next/navigation";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

type Current = Parameters<typeof PortalHeader>[0]["current"];

// The protected frame shared by the inventory pages (Products, Warehouses, Stock, Movements, ...). The session is checked in the
// layout, BEFORE the page starts streaming its loading skeleton, so an invalid or missing session is a true HTTP redirect to
// /login, and the header (navigation, sign-out) stays around the page and its loading state.
//
// First-time onboarding is enforced HERE, on the server, for every page that uses this frame: an administrator whose company or
// personal setup is incomplete is redirected to /setup, so typing a page's address cannot skip the wizard. If the Organization
// Service cannot answer, the page is NOT shown as if setup were complete: a recoverable error is, with sign-out still available.
export default async function PortalFrame({ current, children }: { current: Current; children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);
  if (workspace.kind === "setup") redirect("/setup");
  const organization = workspace.kind === "ready" ? workspace.organization : null;
  // Module access: when the organization is known and the page's module is not enabled for it, the page is not rendered at all.
  const module = NAV_MODULE[current];
  const denied = workspace.kind === "ready" && organization !== null && module !== undefined && !canUse(organization.modules, module);
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current={current} organization={organization} />
      <main className="flex-1 p-4 sm:p-8 max-w-7xl mx-auto w-full">
        {workspace.kind === "unavailable" ? (
          <div role="alert" className="mx-auto max-w-xl space-y-3 rounded-xl border border-slate-700 bg-slate-900/50 p-6 text-center">
            <p className="text-sm font-medium text-white">We couldn&apos;t load your workspace just now.</p>
            <p className="text-xs text-slate-400">Nothing was lost. Please refresh in a moment. You can sign out at any time.</p>
          </div>
        ) : denied && module ? (
          <ModuleAccessDenied module={module} />
        ) : (
          children
        )}
      </main>
    </div>
  );
}
