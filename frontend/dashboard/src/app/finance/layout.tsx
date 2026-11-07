import PortalFrame from "@/components/portal-frame";
import FinanceTabs from "./finance-tabs";

// The session and module checks run here, in the layout, before the page starts streaming (see PortalFrame). When Finance is not enabled for the
// organization the page is not rendered at all, and the tabs with it.
export default async function Layout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "finance", children: (<><FinanceTabs />{children}</>) });
}
