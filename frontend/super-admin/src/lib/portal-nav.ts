// The Super Admin Portal's navigation: platform-level destinations only. It is deliberately NOT the organization portal's navigation (no
// inventory, sales or finance pages): a Super Admin manages tenants, administrators, modules and support, nothing inside a tenant.

export type NavKey = "dashboard" | "organizations" | "support";
export type NavIcon = "dashboard" | "organizations" | "support";

export type NavItem = { key: NavKey; href: string; label: string; icon: NavIcon; title: string };
export type NavGroup = { id: string; label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "platform",
    label: "Platform",
    items: [
      { key: "dashboard", href: "/", label: "Dashboard", icon: "dashboard", title: "Dashboard" },
      { key: "organizations", href: "/organizations", label: "Organizations", icon: "organizations", title: "Organizations" },
    ],
  },
  {
    id: "support",
    label: "Support",
    items: [{ key: "support", href: "/support", label: "Support Inbox", icon: "support", title: "Support Inbox" }],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** "99+" above 99, so the badge never grows wider than the rail. */
export const unreadText = (count: number) => (count > 99 ? "99+" : String(count));
