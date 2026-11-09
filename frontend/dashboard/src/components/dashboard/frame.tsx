import LogoutButton from "@/components/logout-button";
import { navGroups, PAGE_ICON, PAGE_META, type PageKey } from "@/lib/dashboard-nav";
import type { TenantAdmin } from "@/lib/tenant-auth";
import ProfileMenu from "@/components/profile-menu";
import ThemeButton from "@/components/theme/theme-button";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { THEME_COOKIE } from "@/lib/session";
import { themeFrom } from "@/lib/theme";
import { monogram } from "@/lib/setup-validation";
import Icon from "./icons";
import { MenuButton, NavProvider, Sidebar } from "./sidebar";

// The Organization Portal's shell: the atmospheric background, the icon-rail sidebar and a slim glass header. EVERY authenticated page of the
// portal is rendered inside it (through PortalFrame), so there is exactly one navigation and one header. The content column keeps a constant left
// padding for the 76px rail, so the sidebar expanding (an overlay) never moves anything. The accent is the same on every page (pale butter yellow).

export type HeaderOrganization = { name: string; has_logo?: boolean; logo_version?: string | null; modules?: string[] };

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OA";

// The company's own logo (served by this portal's authenticated route, never a storage path; `v` changes with the logo) or its monogram.
function mark(organization: HeaderOrganization) {
  return organization.has_logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/organization/logo?v=${encodeURIComponent(organization.logo_version ?? "")}`} alt={`${organization.name} logo`} className="h-6 w-6 shrink-0 rounded-md bg-ix-text/95 object-contain p-px" />
  ) : (
    <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-ix-butter text-[10px] font-bold text-ix-on-accent">{monogram(organization.name)}</span>
  );
}

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
      <ThemeProvider saved={themeFrom(admin.theme_background, admin.theme_accent)} cookieName={THEME_COOKIE} userId={admin.id}>
      <NavProvider>
        <Sidebar groups={groups} currentHref={page.href} />
        <div className="min-w-0 lg:pl-[104px] print:pl-0">
          <header className="relative z-30 print:hidden px-4 pt-4 sm:px-6 lg:px-8">
            <div className={`ix-glass mx-auto flex h-16 ${WIDTH[width]} items-center gap-3 rounded-2xl px-3 sm:px-4`}>
              <MenuButton />
              {/* The page: its icon (yellow) first, then its name, simply big and bold. Who is signed in (and where) is in the card that opens from the avatar. */}
              <div className="flex min-w-0 items-center gap-3">
                <Icon name={PAGE_ICON[current]} className="h-6 w-6 shrink-0 text-ix-accent-text sm:h-7 sm:w-7" />
                <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-ix-text sm:text-2xl">{page.title}</h1>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <ThemeButton />
                <ProfileMenu name={admin.full_name} email={admin.email} userId={admin.id} role="Organization Admin" initials={initialsOf(admin.full_name)} organization={organization?.name} organizationMark={organization ? mark(organization) : null} />
                <LogoutButton variant="icon" />
              </div>
            </div>
          </header>
          <main className={`mx-auto w-full ${WIDTH[width]} px-4 pb-12 pt-5 sm:px-6 lg:px-8 print:max-w-none print:p-0`}>{children}</main>
        </div>
      </NavProvider>
      </ThemeProvider>
    </div>
  );
}
