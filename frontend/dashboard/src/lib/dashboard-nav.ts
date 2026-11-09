import { MODULE_LABELS, MODULE_PAGES, usableModules, type ModuleKey } from "@/lib/modules";

// The Organization Dashboard's sidebar. It is built from the same two sources as the rest of the portal: the module registry (lib/modules.ts)
// and the modules the Super Admin enabled for this organization. A module that is not enabled has NO entry here at all (not hidden, absent);
// Dashboard, Help & Support and Settings are permanent. This only decides what to LIST: the services behind every page enforce access again.

export type IconName =
  | "dashboard" | "products" | "stock" | "movements" | "suppliers" | "orders" | "receipts" | "clients" | "lists"
  | "orderPlus" | "invoices" | "overview" | "accounts" | "expenses" | "journal" | "support" | "settings";

export type NavItem = { key: string; label: string; href: string; icon: IconName };
export type NavGroup = { id: string; label: string; items: NavItem[] };

const ICON_BY_HREF: Record<string, IconName> = {
  "/products": "products", "/stock": "stock", "/movements": "movements",
  "/suppliers": "suppliers", "/purchase-orders": "orders", "/goods-receipts": "receipts",
  "/clients": "clients", "/sales-orders/new": "orderPlus", "/delivery-lists": "lists", "/invoices": "invoices",
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

// ---- the pages of the portal, as the shell knows them ----------------------------------------------------------------------------------
// `current` keys are the ones every section layout already passes to PortalFrame (they are also the keys of NAV_MODULE in lib/modules.ts).

export type Section = "inventory" | "purchasing" | "sales" | "finance" | "workspace" | "main";

export const PAGE_META = {
  dashboard: { title: "Dashboard", href: "/", section: "main" },
  products: { title: "Products", href: "/products", section: "inventory" },
  stock: { title: "Stock", href: "/stock", section: "inventory" },
  movements: { title: "Movements", href: "/movements", section: "inventory" },
  suppliers: { title: "Suppliers", href: "/suppliers", section: "purchasing" },
  purchasing: { title: "Purchase Orders", href: "/purchase-orders", section: "purchasing" },
  receipts: { title: "Goods Receipts", href: "/goods-receipts", section: "purchasing" },
  clients: { title: "Clients", href: "/clients", section: "sales" },
  newOrder: { title: "Create Order", href: "/sales-orders/new", section: "sales" },
  deliveries: { title: "Delivery Lists", href: "/delivery-lists", section: "sales" },
  invoices: { title: "Invoices", href: "/invoices", section: "sales" },
  finance: { title: "Finance", href: "/finance", section: "finance" },
  support: { title: "Help & Support", href: "/support", section: "workspace" },
  settings: { title: "Settings", href: "/settings", section: "workspace" },
} as const satisfies Record<string, { title: string; href: string; section: Section }>;

export type PageKey = keyof typeof PAGE_META;

/** The navigation item that is "current" for a path: the item whose route is the longest prefix of it ("/finance/journal/abc" -> Journal Entries,
 *  "/invoices/123/edit" -> Invoices, "/" only on the dashboard itself). */
export function activeHref(pathname: string | null | undefined, groups: NavGroup[], fallback: string): string {
  const path = (pathname ?? "").split("?")[0] || fallback;
  let best: string | null = null;
  for (const item of groups.flatMap((g) => g.items)) {
    const match = item.href === "/" ? path === "/" : path === item.href || path.startsWith(`${item.href}/`);
    if (match && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best ?? fallback;
}
