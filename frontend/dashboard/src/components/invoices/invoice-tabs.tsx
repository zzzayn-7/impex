import { TabNavigation } from "@/components/ui/page";

// The two tabs at the top left of Sales Invoice and Purchase Invoice: "New invoice" (make one) and "History" (every past one). They are plain links to their own addresses, so one
// tab's filters never leak into the other.
export const SALES_BASE = "/invoices/sales";
export const PURCHASE_BASE = "/invoices/suppliers";

// Sales has a third tab between the two: "Pending payments", the installments whose date has not come yet.
export default function InvoiceTabs({ base, current }: { base: typeof SALES_BASE | typeof PURCHASE_BASE; current: "new" | "pending" | "history" }) {
  const tabs = [{ href: base, label: "New invoice" }, ...(base === SALES_BASE ? [{ href: `${base}/pending`, label: "Pending payments" }] : []), { href: `${base}/history`, label: "History" }];
  return <TabNavigation label={base === SALES_BASE ? "Sales invoice" : "Purchase invoice"} tabs={tabs} current={current === "new" ? base : `${base}/${current}`} />;
}
