import { redirect } from "next/navigation";

import Link from "next/link";

import PortalHeader from "@/components/portal-header";
import { MODULE_DESCRIPTIONS, MODULE_LABELS, MODULE_PAGES, usableModules } from "@/lib/modules";
import { setupNeed } from "@/lib/onboarding";
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
  // First-time onboarding: until the company and the administrator's own profile are set up (the services' records, checked on
  // every request) the dashboard is not shown. If the Organization Service cannot answer, the panel below says so (recoverable);
  // setup is never assumed complete.
  if (result.ok && setupNeed(admin, result.organization).required) redirect("/setup");
  const organization = result.ok ? result.organization : null;
  // Only the modules the Super Admin enabled for this organization are listed (an unknown list means none).
  const enabledModules = usableModules(organization?.modules);

  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current="dashboard" organization={organization} />

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

        {organization && (
          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-6" aria-labelledby="modules-heading">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Your modules</p>
              <h2 id="modules-heading" className="mt-1 text-xl font-semibold text-white">Where would you like to work?</h2>
            </div>
            {enabledModules.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-sm text-slate-400">
                No business modules are enabled for your organization yet.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {enabledModules.map((key) => (
                  <div key={key} data-module={key} className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
                    <h3 className="text-sm font-semibold text-white">{MODULE_LABELS[key]}</h3>
                    <p className="mt-1 text-xs text-slate-400">{MODULE_DESCRIPTIONS[key]}</p>
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {MODULE_PAGES[key].map((page) => (
                        <li key={page.href}>
                          <Link href={page.href} className="inline-flex rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:bg-slate-800 hover:text-indigo-200">{page.label}</Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-slate-500">
              Need another module? <Link href="/support/new?module=other" className="text-indigo-300 hover:text-indigo-200">Ask the Impex team</Link>. Only the Impex team can enable it.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
