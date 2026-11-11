import LogoutButton from "@/components/logout-button";
import { navGroups, PAGE_ICON, PAGE_META, type PageKey } from "@/lib/dashboard-nav";
import type { TenantAdmin } from "@/lib/tenant-auth";
import ProfileMenu from "@/components/profile-menu";
import AddWidgetsButton from "@/components/dashboard-layout/add-widgets-panel";
import { DashboardLayoutProvider } from "@/components/dashboard-layout/layout-provider";
import ThemeButton from "@/components/theme/theme-button";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { THEME_COOKIE } from "@/lib/session";
import { availableOrgWidgets } from "@/lib/dashboard-widgets";
import { themeFrom } from "@/lib/theme";
import Icon from "./icons";
import { MenuButton, NavProvider, Sidebar } from "./sidebar";

// The Organization Portal's shell: the atmospheric background, the icon-rail sidebar and a slim glass header. EVERY authenticated page of the
// portal is rendered inside it (through PortalFrame), so there is exactly one navigation and one header. The content column keeps a constant left
// padding for the 76px rail, so the sidebar expanding (an overlay) never moves anything. The accent is the same on every page (pale butter yellow).

export type HeaderOrganization = { name: string; has_logo?: boolean; logo_version?: string | null; modules?: string[]; is_locked?: boolean };

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OA";

// ONE content width for every page, and the header bar is exactly as wide as the content below it: the portal looks the same everywhere.
const WIDTH = "max-w-7xl";

export default function PortalShell({
  admin, organization, children, current = "dashboard",
}: {
  admin: TenantAdmin;
  organization: HeaderOrganization | null;
  children: React.ReactNode;
  current?: PageKey;
}) {
  const groups = navGroups(organization?.modules, organization?.is_locked === true);
  const page = PAGE_META[current];
  // The home page (and only the home page) can be customised: the provider holds which cards are shown and in what order, for the header's Add Widgets
  // button and the cards alike. Which cards this administrator may use is decided here, on the server, from the organization's enabled modules.
  const home = current === "dashboard" && organization?.is_locked !== true; // a locked organization has no widgets to arrange
  const widgets = home ? availableOrgWidgets(organization?.modules, organization !== null) : [];
  return (
    <div className="ix-dash">
      <ThemeProvider saved={themeFrom(admin.theme_background, admin.theme_accent)} cookieName={THEME_COOKIE} userId={admin.id}>
      <NavProvider groups={groups}>
      <Customizable on={home} widgets={widgets} saved={admin.dashboard_layout} storageKey={`organization:${admin.id}`}>
        <Sidebar groups={groups} currentHref={page.href} organization={organization} />
        <div className="min-w-0 lg:pl-[104px] print:pl-0">
          <header className={`relative z-30 mx-auto w-full ${WIDTH} print:hidden px-4 pt-4 sm:px-6 lg:px-8`}>
            <div className="ix-glass flex h-16 w-full items-center gap-3 rounded-2xl px-3 sm:px-4">
              <MenuButton />
              {/* The page: its icon (yellow) first, then its name, simply big and bold. Who is signed in (and where) is in the card that opens from the avatar. */}
              <div className="flex min-w-0 items-center gap-3">
                <Icon name={PAGE_ICON[current]} className="h-6 w-6 shrink-0 text-ix-accent-text sm:h-7 sm:w-7" />
                <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-ix-text sm:text-2xl">{page.title}</h1>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                {home && <AddWidgetsButton />}
                <ThemeButton />
                <ProfileMenu name={admin.full_name} email={admin.email} userId={admin.id} role="Organization Admin" initials={initialsOf(admin.full_name)} organization={organization?.name} avatarUrl={admin.has_avatar ? `/api/profile/avatar?v=${encodeURIComponent(admin.avatar_version ?? "")}` : null} avatarEditable />
                <LogoutButton variant="icon" />
              </div>
            </div>
          </header>
          <main className={`ix-page mx-auto w-full ${WIDTH} px-4 pb-12 pt-5 sm:px-6 lg:px-8 print:max-w-none print:p-0`}>{children}</main>
        </div>
      </Customizable>
      </NavProvider>
      </ThemeProvider>
    </div>
  );
}

function Customizable({ on, widgets, saved, storageKey, children }: { on: boolean; widgets: ReturnType<typeof availableOrgWidgets>; saved: unknown; storageKey: string; children: React.ReactNode }) {
  return on ? <DashboardLayoutProvider widgets={widgets} saved={saved} storageKey={storageKey} endpoint="/api/dashboard-layout">{children}</DashboardLayoutProvider> : <>{children}</>;
}
