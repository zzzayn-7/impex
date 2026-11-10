import Link from "next/link";
import { redirect } from "next/navigation";

import { ClockProvider } from "@/components/clock";
import ModuleAccessDenied from "@/components/module-access-denied";
import PortalShell from "@/components/dashboard/frame";
import { GlassPanel } from "@/components/ui/glass";
import type { PageKey } from "@/lib/dashboard-nav";
import { normalizePreferences } from "@/lib/format";
import { NAV_MODULE, canUse } from "@/lib/modules";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

// The ONE protected frame of the Organization Portal. Every authenticated page (dashboard, Inventory, Purchasing, Sales, Finance, Settings, Help &
// Support) is rendered inside it, so there is a single sidebar and a single header. The session is checked in the layout, BEFORE the page starts
// streaming its loading skeleton, so an invalid or missing session is a true HTTP redirect to /login, and the shell (navigation, sign-out) stays
// around the page and its loading state.
//
// First-time onboarding is enforced HERE, on the server, for every page that uses this frame: an administrator whose company or personal setup is
// incomplete is redirected to /setup, so typing a page's address cannot skip the wizard. Help & Support is the one exception (`allowIncompleteSetup`):
// a newly invited administrator with an onboarding problem must be able to ask for help WITHOUT finishing setup first (authentication is unchanged
// and the Support Service re-checks the caller on every request). If the Organization Service cannot answer, the page is NOT shown as if setup were
// complete: a recoverable error is, with sign-out still available. Module access: when the organization is known and the page's module is not
// enabled for it, the page is not rendered at all.
export default async function PortalFrame({
  current, children, allowIncompleteSetup = false, pageHandlesOutage = false, width,
}: {
  current: PageKey;
  children: React.ReactNode;
  allowIncompleteSetup?: boolean;
  /** The page explains an unreachable Organization Service itself (the dashboard and Help & Support do): it is still shown, never replaced. */
  pageHandlesOutage?: boolean;
  width?: "wide" | "default" | "narrow";
}) {
  const admin = await requireTenantAdmin();
  const workspace = await loadWorkspace(admin);
  if (workspace.kind === "setup" && !allowIncompleteSetup) redirect("/setup");
  const organization = workspace.kind === "unavailable" ? null : workspace.organization;
  const module = NAV_MODULE[current];
  const denied = workspace.kind === "ready" && organization !== null && module !== undefined && !canUse(organization.modules, module);
  return (
    <ClockProvider timeZone={normalizePreferences(organization).timezone}>
    <PortalShell admin={admin} organization={organization} current={current} width={width}>
      {workspace.kind === "unavailable" && !pageHandlesOutage ? (
        <GlassPanel role="alert" className="mx-auto max-w-xl space-y-3 p-6 text-center">
          <p className="text-sm font-medium text-white">We couldn&apos;t load your workspace just now.</p>
          <p className="text-xs text-slate-400">Nothing was lost. Please refresh in a moment. You can sign out at any time.</p>
        </GlassPanel>
      ) : denied && module ? (
        <ModuleAccessDenied module={module} />
      ) : (
        <>
          {workspace.kind === "setup" && (
            <p role="note" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200/25 bg-amber-100/10 px-4 py-3 text-sm text-amber-100">
              <span>Your organization setup is not finished yet. You can contact the Impex team from here at any time.</span>
              <Link href="/setup" className="font-medium text-amber-50 underline hover:text-white">Back to setup</Link>
            </p>
          )}
          {children}
        </>
      )}
    </PortalShell>
    </ClockProvider>
  );
}
