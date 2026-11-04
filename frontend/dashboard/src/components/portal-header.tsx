import Link from "next/link";

import LogoutButton from "@/components/logout-button";
import type { TenantAdmin } from "@/lib/tenant-auth";

const NAV_LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "products", href: "/products", label: "Products" },
  { key: "warehouses", href: "/warehouses", label: "Warehouses" },
  { key: "stock", href: "/stock", label: "Stock" },
  { key: "movements", href: "/movements", label: "Movements" },
] as const;

export default function PortalHeader({
  admin,
  current,
}: {
  admin: TenantAdmin;
  current: (typeof NAV_LINKS)[number]["key"];
}) {
  const initials =
    admin.full_name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "OA";

  return (
    <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-lg shadow-md shadow-indigo-600/30">
            IX
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">IMPEX Organization Portal</h1>
            <p className="text-xs text-slate-400">Organization workspace</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              aria-current={link.key === current ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                link.key === current ? "bg-indigo-600/15 text-indigo-300" : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
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
  );
}
