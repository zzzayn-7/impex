import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { fetchTenantOrganization } from "@/lib/organization";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

// Organization dashboard: the administrator's own organization. No business data yet.
// This page takes no parameters on purpose: which organization to show is decided on the server from the
// signed-in administrator, never from the URL or the browser.
export default async function OrganizationDashboard() {
  // Redirects to /login unless the session belongs to an active organization administrator.
  // The name and organization id come from the Auth Service, never from the browser.
  const admin = await requireTenantAdmin();
  // The organization's details come from the Organization Service, called with the same session token.
  const result = await fetchTenantOrganization(getTenantToken() ?? "");
  if (!result.ok && result.reason === "unauthorized") redirect("/login");
  const organization = result.ok ? result.organization : null;

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current="dashboard" />

      <main className="flex-1 p-8 max-w-4xl mx-auto w-full space-y-6">
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-5">
          <div>
            <h2 className="text-xl font-semibold text-white">Welcome, {admin.full_name}</h2>
            <p className="mt-1 text-sm text-slate-400">
              You are signed in as an administrator of{" "}
              <span className="font-medium text-slate-200">{organization ? organization.name : "your organization"}</span>.
            </p>
          </div>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
              <dt className="text-xs font-medium text-slate-400">Administrator</dt>
              <dd className="mt-1 text-sm font-medium text-white">{admin.full_name}</dd>
              <dd className="text-xs text-slate-400">{admin.email}</dd>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
              <dt className="text-xs font-medium text-slate-400">Organization ID</dt>
              <dd className="mt-1 break-all font-mono text-xs text-indigo-300">{admin.organization_id}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-5" aria-labelledby="organization-heading">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Your organization</p>
              <h2 id="organization-heading" className="mt-1 text-xl font-semibold text-white">
                {organization ? organization.name : "Organization details"}
              </h2>
            </div>
            {organization && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                  organization.is_active
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                }`}
              >
                {organization.is_active ? "Active" : "Inactive"}
              </span>
            )}
          </div>

          {organization ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <dt className="text-xs font-medium text-slate-400">Identifier (slug)</dt>
                <dd className="mt-1 font-mono text-sm text-indigo-300">{organization.slug}</dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <dt className="text-xs font-medium text-slate-400">Country</dt>
                <dd className="mt-1 text-sm text-white">{organization.country_code}</dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <dt className="text-xs font-medium text-slate-400">Tax identifier</dt>
                <dd className="mt-1 text-sm text-white">
                  {organization.tax_identifier ?? <span className="text-slate-500">Not provided</span>}
                </dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                <dt className="text-xs font-medium text-slate-400">Contact email</dt>
                <dd className="mt-1 text-sm text-white">{organization.contact_email}</dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 sm:col-span-2">
                <dt className="text-xs font-medium text-slate-400">Registered</dt>
                <dd className="mt-1 text-sm text-white">{formatDate(organization.created_at)}</dd>
              </div>
            </dl>
          ) : result.ok === false && result.reason === "forbidden" ? (
            <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              Your organization is currently inactive or unavailable. Please contact your platform administrator.
            </div>
          ) : (
            <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
              Organization details are temporarily unavailable. Please refresh in a moment.
            </div>
          )}
        </section>

        <section className="rounded-xl border border-dashed border-slate-800 p-6 text-center">
          <p className="text-sm text-slate-400">Your organization workspace is being set up.</p>
          <p className="mt-1 text-xs text-slate-500">Inventory, orders and invoicing will appear here as they become available.</p>
        </section>
      </main>
    </div>
  );
}
