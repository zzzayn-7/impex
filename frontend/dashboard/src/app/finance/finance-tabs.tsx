"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { MODULE_PAGES } from "@/lib/modules";

// The Finance module's own navigation: Financial Overview, Accounts, Expenses, Journal Entries (the pages of MODULE_PAGES.finance).
export default function FinanceTabs() {
  const pathname = usePathname() ?? "/finance";
  const active = (href: string) => (href === "/finance" ? pathname === "/finance" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <nav aria-label="Finance" className="print:hidden mb-6 flex flex-wrap gap-1 border-b border-slate-800 pb-3">
      {MODULE_PAGES.finance.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          aria-current={active(page.href) ? "page" : undefined}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${active(page.href) ? "bg-indigo-600/15 text-indigo-300" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
