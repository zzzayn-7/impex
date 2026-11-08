import LogoutButton from "@/components/logout-button";
import { navGroups, PAGE_META, type PageKey } from "@/lib/dashboard-nav";
import { monogram } from "@/lib/setup-validation";
import type { TenantAdmin } from "@/lib/tenant-auth";
import { Tooltip } from "@/components/ui/tooltip";
import { MenuButton, NavProvider, Sidebar } from "./sidebar";

// The Organization Portal's shell: the atmospheric background, the icon-rail sidebar and a slim glass header. EVERY authenticated page of the
// portal is rendered inside it (through PortalFrame), so there is exactly one navigation and one header. The content column keeps a constant left
// padding for the 76px rail, so the sidebar expanding (an overlay) never moves anything. The accent is the same on every page (pale butter yellow).

export type HeaderOrganization = { name: string; has_logo?: boolean; logo_version?: string | null; modules?: string[] };

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OA";

const WIDTH = { wide: "max-w-[1400px]", default: "max-w-7xl", narrow: "max-w-5xl" } as const;

export default function PortalShell({
  admin, organization, children, current = "dashboard", width = "default",
}: {
  admin: TenantAdmin;
  organization: HeaderOrganization | null;
  children: React.ReactNode;
  current?: PageKey;
  width?: keyof typeof WIDTH;
}) {
  const groups = navGroups(organization?.modules);
  const page = PAGE_META[current];
  return (
    <div className="ix-dash">
      <NavProvider>
        <Sidebar groups={groups} currentHref={page.href} />
        <div className="min-w-0 lg:pl-[104px] print:pl-0">
          <header className="print:hidden px-4 pt-4 sm:px-6 lg:px-8">
            <div className={`ix-glass mx-auto flex h-16 ${WIDTH[width]} items-center gap-3 rounded-2xl px-3 sm:px-4`}>
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
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ix-butter text-sm font-bold text-ix-deep">
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
                  <li><h1 className="font-semibold text-ix-text">{page.title}</h1></li>
                </ol>
              </nav>

              <div className="ml-auto flex items-center gap-3">
                <div className="text-right max-sm:sr-only">
                  <p className="max-w-[12rem] truncate text-sm font-medium leading-tight text-ix-text">{admin.full_name}</p>
                  <p className="max-w-[12rem] truncate text-[11px] text-ix-muted">{admin.email}</p>
                </div>
                <Tooltip label={`${admin.full_name} (${admin.email})`} side="bottom">
                  <div aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-ix-butter/30 bg-ix-slate/60 text-xs font-semibold text-ix-butter">
                    {initialsOf(admin.full_name)}
                  </div>
                </Tooltip>
                <LogoutButton variant="glass" />
              </div>
            </div>
          </header>
          <main className={`mx-auto w-full ${WIDTH[width]} px-4 pb-12 pt-5 sm:px-6 lg:px-8 print:max-w-none print:p-0`}>{children}</main>
        </div>
      </NavProvider>
    </div>
  );
}
