import PortalFrame from "@/components/portal-frame";

// The dashboard uses the same frame as every other page (see PortalFrame): the session and first-time-setup checks run HERE, in the layout, before the
// page streams its loading skeleton, so a missing session is a true redirect to /login and an unfinished setup a true redirect to /setup (typing the
// address cannot skip the wizard). If the Organization Service cannot answer, setup is never assumed complete: the page itself says so (and asks for no business data).
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "dashboard", pageHandlesOutage: true, width: "wide", children });
}
