import PortalFrame from "@/components/portal-frame";

// The session check runs here, in the layout, before the page starts streaming (see PortalFrame): an invalid session is a real redirect to
// /login, and an administrator whose first-time setup is unfinished goes to /setup. Settings belong to a configured organization.
// No module is needed: Settings stay open when Inventory, Purchasing and Sales are all disabled.
export default async function Layout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "settings", children });
}
