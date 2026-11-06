import Link from "next/link";

import LogoutButton from "@/components/logout-button";
import { NAV_MODULE, canUse } from "@/lib/modules";
import { monogram } from "@/lib/setup-validation";
import type { TenantAdmin } from "@/lib/tenant-auth";

const NAV_LINKS = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "products", href: "/products", label: "Products" },
  { key: "warehouses", href: "/warehouses", label: "Warehouses" },
  { key: "stock", href: "/stock", label: "Stock" },
  { key: "scan", href: "/scan", label: "Scan Product" },
  { key: "movements", href: "/movements", label: "Movements" },
  { key: "deliveries", href: "/delivery-lists", label: "Delivery Lists" },
  { key: "dispatches", href: "/dispatches", label: "Dispatches" },
  { key: "invoices", href: "/invoices", label: "Invoices" },
  { key: "clients", href: "/clients", label: "Clients" },
  { key: "suppliers", href: "/suppliers", label: "Suppliers" },
  { key: "purchasing", href: "/purchase-orders", label: "Purchase Orders" },
  { key: "receipts", href: "/goods-receipts", label: "Goods Receipts" },
  { key: "support", href: "/support", label: "Help & Support" },
] as const;

export type HeaderOrganization = { name: string; has_logo?: boolean; logo_version?: string | null; modules?: string[] };

export default function PortalHeader({
  admin,
  current,
  organization,
}: {
  admin: TenantAdmin;
  current: (typeof NAV_LINKS)[number]["key"];
  // The configured company identity (first-time setup). Absent: the platform's own "IX" mark and the generic subtitle, as before.
  organization?: HeaderOrganization | null;
}) {
  const initials =
    admin.full_name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "OA";

  return (
    <header className="print:hidden border-b border-slate-800 bg-slate-900/60 backdrop-blur px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-y-3">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-3">
          {organization && organization.has_logo ? (
            // The company logo, served by this portal's own authenticated route (never a storage path). `v` changes with the logo.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/organization/logo?v=${encodeURIComponent(organization.logo_version ?? "")}`}
              alt={`${organization.name} logo`}
              className="h-9 w-9 rounded-lg bg-white object-contain p-0.5 shadow-md shadow-black/20"
            />
          ) : (
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-lg shadow-md shadow-indigo-600/30">
              {organization ? monogram(organization.name) : "IX"}
            </div>
          )}
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">{organization ? organization.name : "IMPEX Organization Portal"}</h1>
            <p className="text-xs text-slate-400">{organization ? "Admin Portal" : "Organization workspace"}</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          {NAV_LINKS.filter((link) => {
            // Dashboard and Help & Support are always there. A business page is listed only when its module is enabled; when the
            // organization (so its modules) is unknown, no business page is listed.
            const module = NAV_MODULE[link.key];
            return !module || canUse(organization?.modules, module);
          }).map((link) => (
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
        <span className="hidden max-w-[12rem] truncate text-sm text-slate-300 sm:block">{admin.full_name}</span>
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
