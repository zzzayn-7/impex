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
  "/suppliers": "suppliers", "/purchase-orders": "orders", "/invoices/suppliers": "receipts",
  "/clients": "clients", "/sales-orders/new": "orderPlus", "/delivery-lists": "lists", "/invoices/sales": "invoices",
  "/finance": "overview", "/finance/accounts": "accounts", "/finance/expenses": "expenses", "/finance/journal": "journal",
};

// The sidebar's groups, in order. "invoices" is not a module: it collects the pages the modules mark `group: "invoices"` (see lib/modules.ts), so it is
// there exactly when the organization can use Suppliers Invoice (Purchasing) or Sales Invoice (Sales), and lists only the tabs it may use.
const GROUP_ORDER: (ModuleKey | "invoices")[] = ["inventory", "purchasing", "sales", "invoices", "finance"];

export function navGroups(modules: unknown): NavGroup[] {
  const enabled = usableModules(modules);
  const groups: NavGroup[] = [{ id: "main", label: "Main", items: [{ key: "dashboard", label: "Dashboard", href: "/", icon: "dashboard" }] }];
  const item = (page: { label: string; href: string }): NavItem => ({ key: page.href, label: page.label, href: page.href, icon: ICON_BY_HREF[page.href] ?? "dashboard" });
  // the pages of the ENABLED modules that are listed under Invoices (in module order: Purchasing's, then Sales')
  const invoiceItems = (Object.keys(MODULE_PAGES) as ModuleKey[]).filter((key) => enabled.includes(key)).flatMap((key) => MODULE_PAGES[key].filter((p) => p.group === "invoices").map(item));
  for (const key of GROUP_ORDER) {
    if (key === "invoices") {
      if (invoiceItems.length > 0) groups.push({ id: "invoices", label: "Invoices", items: invoiceItems });
      continue;
    }
    if (!enabled.includes(key)) continue;
    groups.push({ id: key, label: MODULE_LABELS[key], items: MODULE_PAGES[key].filter((p) => !p.group).map(item) });
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

export type Section = "inventory" | "purchasing" | "sales" | "invoices" | "finance" | "workspace" | "main";

export const PAGE_META = {
  dashboard: { title: "Dashboard", href: "/", section: "main" },
  products: { title: "Products", href: "/products", section: "inventory" },
  stock: { title: "Stock", href: "/stock", section: "inventory" },
  movements: { title: "Movements", href: "/movements", section: "inventory" },
  suppliers: { title: "Suppliers", href: "/suppliers", section: "purchasing" },
  purchasing: { title: "Purchase Orders", href: "/purchase-orders", section: "purchasing" },
  receipts: { title: "Goods Receipts", href: "/invoices/suppliers", section: "invoices" }, // a receipt's own page (/goods-receipts/...): the Suppliers Invoice tab is its parent
  supplierInvoices: { title: "Invoices", href: "/invoices/suppliers", section: "invoices" },
  clients: { title: "Clients", href: "/clients", section: "sales" },
  newOrder: { title: "Create Order", href: "/sales-orders/new", section: "sales" },
  deliveries: { title: "Delivery Lists", href: "/delivery-lists", section: "sales" },
  invoices: { title: "Invoices", href: "/invoices/sales", section: "invoices" }, // the Sales Invoice tab and the invoice pages (/invoices/<id>, /invoices/new)
  finance: { title: "Finance", href: "/finance", section: "finance" },
  support: { title: "Help & Support", href: "/support", section: "workspace" },
  settings: { title: "Settings", href: "/settings", section: "workspace" },
} as const satisfies Record<string, { title: string; href: string; section: Section }>;

export type PageKey = keyof typeof PAGE_META;

/** The icon of every page: the same drawing its sidebar entry uses. The header shows it, in yellow, in front of the page's name. */
export const PAGE_ICON: Record<PageKey, IconName> = {
  dashboard: "dashboard", products: "products", stock: "stock", movements: "movements", suppliers: "suppliers", purchasing: "orders", receipts: "receipts", supplierInvoices: "receipts",
  clients: "clients", newOrder: "orderPlus", deliveries: "lists", invoices: "invoices", finance: "overview", support: "support", settings: "settings",
};

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
