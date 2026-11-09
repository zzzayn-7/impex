import LogoutButton from "@/components/logout-button";
import type { AuthUser } from "@/lib/auth";
import { NAV_ITEMS, type NavKey } from "@/lib/portal-nav";
import Icon from "./icons";
import { MenuButton, NavProvider, Sidebar } from "./portal-sidebar";
import ProfileMenu from "./profile-menu";
import ThemeButton from "./theme/theme-button";
import { ThemeProvider } from "./theme/theme-provider";
import { THEME_COOKIE } from "@/lib/session";
import { themeFrom } from "@/lib/theme";

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "SA";

// The Super Admin Portal's shell: the same atmosphere, glass, accent and rail as the Organization Portal, with the Super Admin's own navigation.
// EVERY authenticated page is rendered inside it, so there is exactly one navigation and one header. The content column keeps a constant left
// padding for the 76px rail, so the rail expanding (an overlay) never moves anything. This is not the organization portal's shell: it takes no
// tenant session and shows no tenant navigation.

const WIDTH = { wide: "max-w-[1400px]", default: "max-w-7xl", narrow: "max-w-5xl" } as const;

export default function PortalShell({
  user, current, supportUnread = 0, children, width = "wide",
}: {
  user: AuthUser;
  current: NavKey;
  supportUnread?: number; // tickets with customer messages nobody has opened yet
  children: React.ReactNode;
  width?: keyof typeof WIDTH;
}) {
  const page = NAV_ITEMS.find((item) => item.key === current) ?? NAV_ITEMS[0];
  return (
    <div className="ix-dash">
      <ThemeProvider saved={themeFrom(user.theme_background, user.theme_accent)} cookieName={THEME_COOKIE} userId={user.id}>
      <NavProvider>
        <Sidebar current={current} supportUnread={supportUnread} />
        <div className="min-w-0 lg:pl-[104px] print:pl-0">
          <header className="relative z-30 px-4 pt-4 sm:px-6 lg:px-8 print:hidden">
            <div className={`ix-glass mx-auto flex h-16 ${WIDTH[width]} items-center gap-3 rounded-2xl px-3 sm:px-4`}>
              <MenuButton />
              {/* The page: its icon (yellow) first, then its name, simply big and bold. Who is signed in is in the card that opens from the avatar. */}
              <div className="flex min-w-0 items-center gap-3">
                <Icon name={page.icon} className="h-6 w-6 shrink-0 text-ix-accent-text sm:h-7 sm:w-7" />
                <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-ix-text sm:text-2xl">{page.title}</h1>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <span className="mr-1.5 hidden items-center gap-1.5 rounded-full border border-ix-accent-text/25 bg-ix-butter/10 px-3 py-1 text-xs font-medium text-ix-accent-text lg:inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-ix-butter motion-safe:animate-pulse" />
                  Gateway Online
                </span>
                <ThemeButton />
                <ProfileMenu name={user.full_name} email={user.email} userId={user.id} role="Super Admin" initials={initialsOf(user.full_name)} appearance />
                <LogoutButton variant="icon" />
              </div>
            </div>
          </header>
          <main className={`mx-auto w-full ${WIDTH[width]} space-y-8 px-4 pb-12 pt-6 sm:px-6 lg:px-8 print:max-w-none print:p-0`}>{children}</main>
        </div>
      </NavProvider>
      </ThemeProvider>
    </div>
  );
}
