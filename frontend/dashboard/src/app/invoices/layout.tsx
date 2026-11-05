import PortalFrame from "@/components/portal-frame";

// The session check runs here, in the layout, before the page starts streaming (see PortalFrame).
export default async function Layout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "invoices", children });
}
