import Link from "next/link";

import LogoutButton from "@/components/logout-button";
import type { AuthUser } from "@/lib/auth";

const NAV_LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "organizations", href: "/organizations", label: "Organizations" },
  { key: "support", href: "/support", label: "Support Inbox" },
] as const;

export default function PortalHeader({
  user,
  current,
  supportUnread = 0,
}: {
  user: AuthUser;
  current: (typeof NAV_LINKS)[number]["key"];
  supportUnread?: number; // tickets with customer messages nobody has opened yet
}) {
  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-lg shadow-md shadow-indigo-600/30">
            IX
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">IMPEX Super Admin</h1>
            <p className="text-xs text-slate-400">Microservices Architecture Platform</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              aria-current={link.key === current ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                link.key === current
                  ? "bg-indigo-600/15 text-indigo-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {link.label}
              {link.key === "support" && supportUnread > 0 && (
                <span aria-label={`${supportUnread} unread`} className="ml-2 rounded-full bg-sky-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                  {supportUnread > 99 ? "99+" : supportUnread}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400 border border-emerald-500/20">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Gateway Online
        </span>
        <LogoutButton />
        <div
          title={`${user.full_name} (${user.email})`}
          className="h-8 w-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-slate-200"
        >
          SA
        </div>
      </div>
    </header>
  );
}
