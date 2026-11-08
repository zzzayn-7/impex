import LogoutButton from "@/components/logout-button";
import type { AuthUser } from "@/lib/auth";
import { NAV_ITEMS, type NavKey } from "@/lib/portal-nav";
import { MenuButton, NavProvider, Sidebar } from "./portal-sidebar";
import { Tooltip } from "./ui/tooltip";

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
      <NavProvider>
        <Sidebar current={current} supportUnread={supportUnread} />
        <div className="min-w-0 lg:pl-[104px] print:pl-0">
          <header className="px-4 pt-4 sm:px-6 lg:px-8 print:hidden">
            <div className={`ix-glass mx-auto flex h-16 ${WIDTH[width]} items-center gap-3 rounded-2xl px-3 sm:px-4`}>
              <MenuButton />
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ix-butter text-sm font-bold text-ix-deep">IX</div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold leading-tight text-ix-text">IMPEX Super Admin</p>
                  <p className="truncate text-[11px] text-ix-muted">Platform administration</p>
                </div>
              </div>

              <div aria-hidden="true" className="mx-1 hidden h-8 w-px bg-ix-mist/15 md:block" />
              <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
                <ol className="flex items-center gap-2 text-sm">
                  <li className="text-ix-muted">Super Admin</li>
                  <li aria-hidden="true" className="text-ix-muted/60">/</li>
                  <li className="font-semibold text-ix-text">{page.title}</li>
                </ol>
              </nav>

              <div className="ml-auto flex items-center gap-3">
                <span className="hidden items-center gap-1.5 rounded-full border border-ix-butter/25 bg-ix-butter/10 px-3 py-1 text-xs font-medium text-ix-butter lg:inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-ix-butter motion-safe:animate-pulse" />
                  Gateway Online
                </span>
                <div className="text-right max-sm:sr-only">
                  <p className="max-w-[12rem] truncate text-sm font-medium leading-tight text-ix-text">{user.full_name}</p>
                  <p className="max-w-[12rem] truncate text-[11px] text-ix-muted">{user.email}</p>
                </div>
                <Tooltip label={`${user.full_name} (${user.email})`} side="bottom">
                  <div aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-ix-butter/30 bg-ix-slate/60 text-xs font-semibold text-ix-butter">SA</div>
                </Tooltip>
                <LogoutButton />
              </div>
            </div>
          </header>
          <main className={`mx-auto w-full ${WIDTH[width]} space-y-8 px-4 pb-12 pt-6 sm:px-6 lg:px-8 print:max-w-none print:p-0`}>{children}</main>
        </div>
      </NavProvider>
    </div>
  );
}
