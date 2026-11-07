import { MODULE_LABELS, MODULE_PAGES, usableModules, type ModuleKey } from "@/lib/modules";

// The Organization Dashboard's sidebar. It is built from the same two sources as the rest of the portal: the module registry (lib/modules.ts)
// and the modules the Super Admin enabled for this organization. A module that is not enabled has NO entry here at all (not hidden, absent);
// Dashboard, Help & Support and Settings are permanent. This only decides what to LIST: the services behind every page enforce access again.

export type IconName =
  | "dashboard" | "products" | "warehouses" | "stock" | "scan" | "movements" | "suppliers" | "orders" | "receipts" | "clients" | "lists" | "dispatches"
  | "invoices" | "overview" | "accounts" | "expenses" | "journal" | "support" | "settings";

export type NavItem = { key: string; label: string; href: string; icon: IconName };
export type NavGroup = { id: string; label: string; items: NavItem[] };

const ICON_BY_HREF: Record<string, IconName> = {
  "/products": "products", "/warehouses": "warehouses", "/stock": "stock", "/scan": "scan", "/movements": "movements",
  "/suppliers": "suppliers", "/purchase-orders": "orders", "/goods-receipts": "receipts",
  "/clients": "clients", "/delivery-lists": "lists", "/dispatches": "dispatches", "/invoices": "invoices",
  "/finance": "overview", "/finance/accounts": "accounts", "/finance/expenses": "expenses", "/finance/journal": "journal",
};

const GROUP_ORDER: ModuleKey[] = ["inventory", "purchasing", "sales", "finance"];

export function navGroups(modules: unknown): NavGroup[] {
  const enabled = usableModules(modules);
  const groups: NavGroup[] = [{ id: "main", label: "Main", items: [{ key: "dashboard", label: "Dashboard", href: "/", icon: "dashboard" }] }];
  for (const key of GROUP_ORDER) {
    if (!enabled.includes(key)) continue;
    groups.push({
      id: key,
      label: MODULE_LABELS[key],
      items: MODULE_PAGES[key].map((page) => ({ key: page.href, label: page.label, href: page.href, icon: ICON_BY_HREF[page.href] ?? "dashboard" })),
    });
  }
  groups.push({
    id: "workspace",
    label: "Workspace",
    items: [
      { key: "support", label: "Help & Support", href: "/support", icon: "support" },
      { key: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ],
  });
  return groups;
}
