import LogoutButton from "@/components/logout-button";
import { navGroups } from "@/lib/dashboard-nav";
import { monogram } from "@/lib/setup-validation";
import type { HeaderOrganization } from "@/components/portal-header";
import type { TenantAdmin } from "@/lib/tenant-auth";
import { MenuButton, NavProvider, Sidebar } from "./sidebar";

// The Organization Dashboard's chrome: the atmospheric background, the icon-rail sidebar and a slim glass header. It is used by the dashboard
// page ONLY (its own route group); every other page keeps the portal's existing header. The page content sits in a column with constant left
// padding for the 76px rail, so the sidebar expanding (an overlay) never moves it.

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OA";

export default function DashboardFrame({
  admin, organization, children, title = "Dashboard", currentHref = "/",
}: {
  admin: TenantAdmin;
  organization: HeaderOrganization | null;
  children: React.ReactNode;
  title?: string;
  currentHref?: string;
}) {
  const groups = navGroups(organization?.modules);
  return (
    <div className="ix-dash">
      <NavProvider>
        <Sidebar groups={groups} currentHref={currentHref} />
        <div className="min-w-0 lg:pl-[104px]">
          <header className="print:hidden px-4 pt-4 sm:px-6 lg:px-8">
            <div className="ix-glass mx-auto flex h-16 max-w-[1400px] items-center gap-3 rounded-2xl px-3 sm:px-4">
              <MenuButton />
              <div className="flex min-w-0 items-center gap-3">
                {organization && organization.has_logo ? (
                  // The company logo, served by this portal's own authenticated route (never a storage path). `v` changes with the logo.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/organization/logo?v=${encodeURIComponent(organization.logo_version ?? "")}`}
                    alt={`${organization.name} logo`}
                    className="h-10 w-10 shrink-0 rounded-xl bg-ix-text/95 object-contain p-0.5"
                  />
                ) : (
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-ix-teal to-ix-sea text-sm font-bold text-ix-deep">
                    {organization ? monogram(organization.name) : "IX"}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold leading-tight text-ix-text">{organization ? organization.name : "IMPEX Organization Portal"}</p>
                  <p className="truncate text-[11px] text-ix-muted">{organization ? "Admin Portal" : "Organization workspace"}</p>
                </div>
              </div>

              <div aria-hidden="true" className="mx-1 hidden h-8 w-px bg-ix-mist/15 md:block" />
              <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
                <ol className="flex items-center gap-2 text-sm">
                  <li className="text-ix-muted">Organization</li>
                  <li aria-hidden="true" className="text-ix-muted/60">/</li>
                  <li><h1 className="font-semibold text-ix-text">{title}</h1></li>
                </ol>
              </nav>

              <div className="ml-auto flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="max-w-[12rem] truncate text-sm font-medium leading-tight text-ix-text">{admin.full_name}</p>
                  <p className="max-w-[12rem] truncate text-[11px] text-ix-muted">{admin.email}</p>
                </div>
                <div title={`${admin.full_name} (${admin.email})`} className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-ix-mist/20 bg-ix-slate/60 text-xs font-semibold text-ix-text">
                  {initialsOf(admin.full_name)}
                </div>
                <LogoutButton variant="glass" />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1400px] px-4 pb-12 pt-5 sm:px-6 lg:px-8">{children}</main>
        </div>
      </NavProvider>
    </div>
  );
}
