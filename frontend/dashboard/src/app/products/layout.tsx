import PortalFrame from "@/components/portal-frame";

// The session, first-time-setup and module checks run here, in the layout, before the page starts streaming (see PortalFrame). Products belong to
// Inventory: when it is not enabled the page is not rendered at all.
export default async function ProductsLayout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "products", children });
}
