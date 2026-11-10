import type { WidgetMeta } from "@/lib/dashboard-layout";
import { usableModules, type ModuleKey } from "@/lib/modules";

// The Organization Portal's home-page WIDGET REGISTRY: every card the dashboard can show, with a stable identifier, a name, what it is for, how much of
// the grid it takes, and what the person needs to see it. The identifiers are what is saved for a person (never the card itself), so they never change;
// a KPI and the list of the same records are different widgets (ids ending ".kpi." vs ".list."). The Auth Service keeps the same list (ORG_WIDGET_IDS in
// services/auth-service/app/dashboard_layout.py); the tests compare the two.
//
// The ORDER here is the default order: the one every administrator sees until they change it.
//
// Access: a widget that needs a module is listed, shown and savable only when the Super Admin has enabled that module for the organization. That is
// decided on the SERVER from the organization's module list (never from what the browser says), and the services behind every figure enforce it again.

type Needs = "always" | "organization" | ModuleKey | ModuleKey[];
type OrgWidget = WidgetMeta & { needs: Needs };

export const ORG_WIDGETS: readonly OrgWidget[] = [
  { id: "org.overview", name: "Welcome & overview", description: "Who is signed in, your organization's status and where it stands.", size: "full", icon: "home", needs: "always" },
  { id: "org.kpi.active-products", name: "Active products", description: "How many products are in your catalog.", size: "small", icon: "box", needs: "inventory" },
  { id: "org.kpi.open-purchase-orders", name: "Open purchase orders (total)", description: "How many purchase orders are waiting to be received, and what is on order.", size: "small", icon: "cart", needs: "purchasing" },
  { id: "org.kpi.invoiced-this-month", name: "Invoiced this month", description: "The total of the invoices issued this month.", size: "small", icon: "receipt", needs: "sales" },
  { id: "org.kpi.outstanding-receivables", name: "Outstanding receivables", description: "What customers still owe you, and what is overdue.", size: "small", icon: "wallet", needs: "sales" },
  { id: "org.chart.sales-purchasing-trend", name: "Sales & purchasing trend", description: "Invoiced and ordered amounts month by month.", size: "medium", icon: "trend", needs: ["sales", "purchasing"] },
  { id: "org.chart.collections", name: "Collections", description: "Open invoices: paid so far, still due and overdue.", size: "medium", icon: "pie", needs: "sales" },
  { id: "org.chart.inventory-activity", name: "Inventory activity", description: "Stock movements per day.", size: "medium", icon: "activity", needs: "inventory" },
  { id: "org.list.recent-invoices", name: "Recent invoices", description: "The latest invoices and their status.", size: "medium", icon: "list", needs: "sales" },
  { id: "org.list.open-purchase-orders", name: "Open purchase orders", description: "The purchase orders waiting to be received.", size: "medium", icon: "list", needs: "purchasing" },
  { id: "org.list.recent-stock-movements", name: "Recent stock movements", description: "The latest additions and removals of stock.", size: "medium", icon: "list", needs: "inventory" },
  { id: "org.finance.snapshot", name: "Finance snapshot", description: "Posted and draft entries, expenses, revenue and expenses by currency.", size: "medium", icon: "ledger", needs: "finance" },
  { id: "org.panel.modules", name: "Your modules", description: "The modules enabled for your organization and their pages.", size: "medium", icon: "grid", needs: "organization" },
  { id: "org.panel.quick-actions", name: "Quick actions", description: "Shortcuts to the things you do most.", size: "medium", icon: "bolt", needs: "organization" },
  { id: "org.panel.organization", name: "Organization details", description: "Your organization's name, identifier, country and contact.", size: "medium", icon: "building", needs: "organization" },
];

export const ORG_WIDGET_IDS: readonly string[] = ORG_WIDGETS.map((w) => w.id);

function allowed(needs: Needs, enabled: ModuleKey[], hasOrganization: boolean): boolean {
  if (needs === "always") return true;
  if (needs === "organization") return hasOrganization;
  return (Array.isArray(needs) ? needs : [needs]).some((key) => enabled.includes(key));
}

/** The widgets this administrator may use right now, in the default order. `modules` is the organization's list as the Organization Service sent it
 *  (null when the organization could not be read: then only the widgets that need nothing are available). */
export function availableOrgWidgets(modules: unknown, hasOrganization: boolean): WidgetMeta[] {
  const enabled = hasOrganization ? usableModules(modules) : [];
  return ORG_WIDGETS.filter((w) => allowed(w.needs, enabled, hasOrganization)).map(({ needs: _needs, ...meta }) => meta);
}
