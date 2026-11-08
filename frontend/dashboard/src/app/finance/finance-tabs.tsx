"use client";

import { usePathname } from "next/navigation";

import { TabNavigation } from "@/components/ui/page";
import { MODULE_PAGES } from "@/lib/modules";

// The Finance module's own navigation: Financial Overview, Accounts, Expenses, Journal Entries (the pages of MODULE_PAGES.finance). The current tab is
// the one whose route is the longest prefix of the address, so a nested page (a journal entry, a new expense) keeps its tab.
export default function FinanceTabs() {
  const pathname = usePathname() ?? "/finance";
  const matches = MODULE_PAGES.finance.filter((page) => (page.href === "/finance" ? pathname === "/finance" : pathname === page.href || pathname.startsWith(`${page.href}/`)));
  const current = matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? "";
  return <TabNavigation label="Finance" tabs={MODULE_PAGES.finance.map((p) => ({ href: p.href, label: p.label }))} current={current} />;
}
