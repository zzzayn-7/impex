// Which business modules the organization may use. The Organization Service decides (the Super Admin switches them); this app only
// reads the answer from the organization record fetched with the administrator's own token, and the services behind every route enforce
// it again on their own. Hiding a menu item is a convenience: nothing here is a security boundary.
//
// Fail closed: a missing or malformed list means "no modules", never "all".

export type ModuleKey = "inventory" | "purchasing" | "sales" | "finance";

export const MODULE_KEYS: ModuleKey[] = ["inventory", "purchasing", "sales", "finance"];

export const MODULE_LABELS: Record<ModuleKey, string> = { inventory: "Inventory", purchasing: "Purchasing", sales: "Sales", finance: "Finance" };

export const MODULE_DESCRIPTIONS: Record<ModuleKey, string> = {
  inventory: "Stock and product details, with scanning and a full movement history.",
  purchasing: "Buying from suppliers and receiving the goods into stock (the receipts are listed under Invoices, as Suppliers Invoice).",
  sales: "Selling to clients: orders that reserve stock, delivery lists, dispatches from stock, invoices and payments.",
  finance: "Your capital, owner investment and profit & loss, built from owner contributions, goods receipts, deliveries and expenses; the accounting records behind them stay available.",
};

// The modules a module cannot work without (the Organization Service enforces the same rule when the Super Admin changes them).
export const MODULE_REQUIRES: Record<ModuleKey, ModuleKey[]> = { inventory: [], purchasing: ["inventory"], sales: ["inventory"], finance: [] };

// What each module contains, as pages in this portal. A page with `group: "invoices"` still BELONGS to its module (it is shown or hidden with it, and the
// services behind it enforce the module), but the sidebar lists it under the dedicated Invoices group: Suppliers Invoice (the goods receipts) needs
// Purchasing, Sales Invoice needs Sales, and the Invoices group appears when the organization has at least one of them.
export type ModulePage = { label: string; href: string; group?: "invoices" };
export const MODULE_PAGES: Record<ModuleKey, ModulePage[]> = {
  inventory: [
    { label: "Stock", href: "/stock" },
    { label: "Movements", href: "/movements" },
  ],
  purchasing: [
    { label: "Suppliers", href: "/suppliers" },
    { label: "Purchase Orders", href: "/purchase-orders" },
    { label: "Suppliers Invoice", href: "/invoices/suppliers", group: "invoices" },
  ],
  sales: [
    { label: "Clients", href: "/clients" },
    { label: "Create Order", href: "/sales-orders/new" },
    { label: "Delivery Lists", href: "/delivery-lists" },
    { label: "Sales Invoice", href: "/invoices/sales", group: "invoices" },
  ],
  // ONE destination: capital, investment and profit & loss. The accounting pages (accounts, expenses, journal entries) are still served, with all their records and
  // APIs, but are no longer listed in the sidebar: the Finance page links to them.
  finance: [
    { label: "Finance", href: "/finance" },
  ],
};

// Header navigation keys -> module. A key that is not here (dashboard, support) is always available.
export const NAV_MODULE: Record<string, ModuleKey> = {
  products: "inventory", stock: "inventory", movements: "inventory",
  suppliers: "purchasing", purchasing: "purchasing", receipts: "purchasing", supplierInvoices: "purchasing",
  deliveries: "sales", newOrder: "sales", invoices: "sales", clients: "sales",
  finance: "finance",
};

// The portal's business API routes -> module (the same routes the setup gate covers).
const API_MODULES: [RegExp, ModuleKey][] = [
  [/^\/api\/(products|stock|scan)(\/|$)/, "inventory"],
  [/^\/api\/purchasing(\/|$)/, "purchasing"],
  [/^\/api\/sales(\/|$)/, "sales"],
  [/^\/api\/finance(\/|$)/, "finance"],
];

export function moduleForApi(pathname: string): ModuleKey | null {
  for (const [pattern, key] of API_MODULES) if (pattern.test(pathname)) return key;
  return null;
}

/** The module keys that are really usable: listed, and with every module they require listed too. Anything unexpected is ignored. */
export function usableModules(modules: unknown): ModuleKey[] {
  if (!Array.isArray(modules)) return [];
  const listed = new Set(modules.filter((m): m is string => typeof m === "string"));
  return MODULE_KEYS.filter((key) => listed.has(key) && MODULE_REQUIRES[key].every((dep) => listed.has(dep)));
}

export const canUse = (modules: unknown, key: ModuleKey): boolean => usableModules(modules).includes(key);

/** The text that opens a Help & Support request for a module. Fixed wording from this list only: a link can never carry text of its own. */
export function moduleRequestDraft(key: ModuleKey | null): { subject: string; message: string } {
  if (!key) return { subject: "Request to activate a module", message: "Please enable the following module(s) for our organization: \n\nWhy we need it: " };
  return { subject: `Request to activate the ${MODULE_LABELS[key]} module`, message: `Please enable the ${MODULE_LABELS[key]} module for our organization.\n\nWhy we need it: ` };
}

export const isModuleKey = (value: unknown): value is ModuleKey => typeof value === "string" && (MODULE_KEYS as string[]).includes(value);
