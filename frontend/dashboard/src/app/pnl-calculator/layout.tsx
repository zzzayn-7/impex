import PortalFrame from "@/components/portal-frame";

// The session and module checks run here, in the layout, before the page starts streaming (see PortalFrame). The PNL Calculator is a page of the Finance module.
export default async function Layout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "pnlCalculator", children });
}
