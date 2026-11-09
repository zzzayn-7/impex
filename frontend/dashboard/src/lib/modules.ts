// Which business modules the organization may use. The Organization Service decides (the Super Admin switches them); this app only
// reads the answer from the organization record fetched with the administrator's own token, and the services behind every route enforce
// it again on their own. Hiding a menu item is a convenience: nothing here is a security boundary.
//
// Fail closed: a missing or malformed list means "no modules", never "all".

export type ModuleKey = "inventory" | "purchasing" | "sales" | "finance";

export const MODULE_KEYS: ModuleKey[] = ["inventory", "purchasing", "sales", "finance"];

export const MODULE_LABELS: Record<ModuleKey, string> = { inventory: "Inventory", purchasing: "Purchasing", sales: "Sales", finance: "Finance" };

export const MODULE_DESCRIPTIONS: Record<ModuleKey, string> = {
  inventory: "Products and stock, with scanning and a full movement history.",
  purchasing: "Buying from suppliers and receiving the goods into stock.",
  sales: "Selling to clients: orders that reserve stock, delivery lists, dispatches from stock, invoices and payments.",
  finance: "Chart of accounts, double-entry journal and expenses, with entries posted from your issued invoices, payments and goods receipts.",
};

// The modules a module cannot work without (the Organization Service enforces the same rule when the Super Admin changes them).
export const MODULE_REQUIRES: Record<ModuleKey, ModuleKey[]> = { inventory: [], purchasing: ["inventory"], sales: ["inventory"], finance: [] };

// What each module contains, as pages in this portal.
export const MODULE_PAGES: Record<ModuleKey, { label: string; href: string }[]> = {
  inventory: [
    { label: "Products", href: "/products" },
    { label: "Stock", href: "/stock" },
    { label: "Movements", href: "/movements" },
  ],
  purchasing: [
    { label: "Suppliers", href: "/suppliers" },
    { label: "Purchase Orders", href: "/purchase-orders" },
    { label: "Goods Receipts", href: "/goods-receipts" },
  ],
  sales: [
    { label: "Clients", href: "/clients" },
    { label: "Create Order", href: "/sales-orders/new" },
    { label: "Delivery Lists", href: "/delivery-lists" },
    { label: "Invoices", href: "/invoices" },
  ],
  finance: [
    { label: "Financial Overview", href: "/finance" },
    { label: "Accounts", href: "/finance/accounts" },
    { label: "Expenses", href: "/finance/expenses" },
    { label: "Journal Entries", href: "/finance/journal" },
  ],
};

// Header navigation keys -> module. A key that is not here (dashboard, support) is always available.
export const NAV_MODULE: Record<string, ModuleKey> = {
  products: "inventory", stock: "inventory", movements: "inventory",
  suppliers: "purchasing", purchasing: "purchasing", receipts: "purchasing",
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
