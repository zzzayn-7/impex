import PortalFrame from "@/components/portal-frame";

// Suppliers Invoice (the Goods Receipts of the Purchasing Service) needs the Purchasing module: PortalFrame checks the session, first-time setup and the module
// here, before the page streams. The Sales Invoice pages have their own layout (in the (sales) group), which checks Sales.
export default async function Layout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "supplierInvoices", children });
}
