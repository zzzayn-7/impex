"use client";

import type { ReactNode } from "react";

import { useNavGroups } from "@/components/dashboard/sidebar";
import { TabNavigation } from "@/components/ui/page";
import { SALES_INVOICES_HREF, SUPPLIER_INVOICES_HREF } from "@/lib/invoices-nav";

// The top of both Invoices tabs: the module's title and one line of explanation, the tabs, and the tab's own action (for example New Invoice). The tabs are
// the Invoices group of the sidebar itself, so a tab is offered exactly when its menu entry is: Suppliers Invoice needs Purchasing, Sales Invoice needs Sales
// (the services behind every page enforce the same). Each tab is a plain link to its own address, so one tab's search and filters never leak into the other.

const ALL = [{ href: SUPPLIER_INVOICES_HREF, label: "Suppliers Invoice" }, { href: SALES_INVOICES_HREF, label: "Sales Invoice" }];

export default function InvoicesHeader({ current, actions, children }: { current: "suppliers" | "sales"; actions?: ReactNode; children?: ReactNode }) {
  const groups = useNavGroups();
  // inside the portal shell: the tabs the organization may use; shown on its own (no shell): both
  const tabs = groups ? (groups.find((g) => g.id === "invoices")?.items ?? []).map((i) => ({ href: i.href, label: i.label })) : ALL;
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Invoices</h2>
          <p className="text-xs text-slate-400">Manage supplier receipts and customer invoices in one place.</p>
        </div>
        {actions}
      </div>
      <TabNavigation label="Invoices" tabs={tabs} current={current === "suppliers" ? SUPPLIER_INVOICES_HREF : SALES_INVOICES_HREF} />
      {children}
    </header>
  );
}
