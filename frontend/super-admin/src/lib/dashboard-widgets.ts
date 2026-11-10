import type { WidgetMeta } from "@/lib/dashboard-layout";

// The Super Admin Portal's home-page WIDGET REGISTRY: every card its dashboard can show, with a stable identifier, a name, what it is for and how much of
// the grid it takes. The identifiers are what is saved for a Super Admin (never the card itself); they have their own "admin." namespace, so this
// portal can never hold the Organization Portal's widgets or the other way round. The Auth Service keeps the same list (ADMIN_WIDGET_IDS in
// services/auth-service/app/dashboard_layout.py); the tests compare the two.
//
// The ORDER here is the default order. Every Super Admin may use every widget: there is no per-module access on this dashboard.

export const ADMIN_WIDGETS: readonly WidgetMeta[] = [
  { id: "admin.kpi.active-tenants", name: "Active Tenants", description: "How many organizations are active on the platform.", size: "small", icon: "users" },
  { id: "admin.kpi.system-uptime", name: "System Uptime", description: "Platform availability over the last 30 days.", size: "small", icon: "gauge" },
  { id: "admin.kpi.api-gateway-requests", name: "API Gateway Requests", description: "Requests handled by the gateway compared with last month.", size: "small", icon: "activity" },
  { id: "admin.kpi.pending-approvals", name: "Pending Approvals", description: "Requests waiting for a Super Admin to review.", size: "small", icon: "clock" },
  { id: "admin.panel.microservice-registry", name: "Microservice Registry", description: "The configured backend microservices, their ports, routes and health links.", size: "full", icon: "server" },
  { id: "admin.panel.docker-compose", name: "Docker Compose Stack", description: "How to start the whole platform from the root folder.", size: "half", icon: "terminal" },
  { id: "admin.panel.api-documentation", name: "API Documentation", description: "Where the services' interactive API documentation lives.", size: "half", icon: "book" },
];

export const ADMIN_WIDGET_IDS: readonly string[] = ADMIN_WIDGETS.map((w) => w.id);
