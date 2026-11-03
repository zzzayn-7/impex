import LogoutButton from "@/components/logout-button";
import { requireTenantAdmin } from "@/lib/tenant-session";

// Placeholder organization dashboard. No business data yet.
export default async function OrganizationDashboard() {
  // Redirects to /login unless the session belongs to an active organization administrator.
  // The name and organization id shown below come from the Auth Service, never from the browser.
  const admin = await requireTenantAdmin();
  const initials =
    admin.full_name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "OA";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-lg shadow-md shadow-indigo-600/30">
            IX
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">IMPEX Organization Portal</h1>
            <p className="text-xs text-slate-400">Organization workspace</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <LogoutButton />
          <div
            title={`${admin.full_name} (${admin.email})`}
            className="h-8 w-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-slate-200"
          >
            {initials}
          </div>
        </div>
      </header>

      <main className="flex-1 p-8 max-w-4xl mx-auto w-full space-y-6">
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 space-y-5">
          <div>
            <h2 className="text-xl font-semibold text-white">Welcome, {admin.full_name}</h2>
            <p className="mt-1 text-sm text-slate-400">You are signed in as an organization administrator.</p>
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

        <section className="rounded-xl border border-dashed border-slate-800 p-6 text-center">
          <p className="text-sm text-slate-400">Your organization workspace is being set up.</p>
          <p className="mt-1 text-xs text-slate-500">Inventory, orders and invoicing will appear here as they become available.</p>
        </section>
      </main>
    </div>
  );
}
