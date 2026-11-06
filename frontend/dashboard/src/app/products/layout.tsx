import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { loadWorkspace, requireTenantAdmin } from "@/lib/tenant-session";

// The session check lives in the layout, which runs BEFORE the page starts streaming (the loading skeleton).
// That makes an invalid or missing session a true HTTP redirect to /login instead of a client-side one, and
// keeps the header (with navigation and sign-out) around the page and its loading state.
export default async function ProductsLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  // First-time onboarding is enforced on the server for every page (same rule as PortalFrame): an incomplete setup goes to /setup;
  // if the Organization Service cannot answer, a recoverable error is shown instead of the page.
  const workspace = await loadWorkspace(admin);
  if (workspace.kind === "setup") redirect("/setup");
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current="products" organization={workspace.kind === "ready" ? workspace.organization : null} />
      <main className="flex-1 p-8 max-w-7xl mx-auto w-full">
        {workspace.kind === "unavailable" ? (
          <div role="alert" className="mx-auto max-w-xl space-y-3 rounded-xl border border-slate-700 bg-slate-900/50 p-6 text-center">
            <p className="text-sm font-medium text-white">We couldn&apos;t load your workspace just now.</p>
            <p className="text-xs text-slate-400">Nothing was lost. Please refresh in a moment. You can sign out at any time.</p>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
