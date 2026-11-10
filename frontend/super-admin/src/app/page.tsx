import DashboardLayoutEditor from "@/components/dashboard-layout/layout-editor";
import PortalShell from "@/components/portal-shell";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { getUnreadCount } from "@/lib/support";

export default async function SuperAdminDashboard() {
  // Redirects to /login unless the session belongs to an active super-admin
  const user = await requireSuperAdmin();
  const supportUnread = (await getUnreadCount(getSessionToken() ?? "")) ?? 0;

  const services = [
    { name: "Auth Service", status: "Operational", port: 8000, route: "/api/v1/auth" },
    { name: "Organization Service", status: "Operational", port: 8001, route: "/api/v1/organizations" },
    { name: "Inventory Service", status: "Planned", port: 8002, route: "/api/v1/inventory" },
    { name: "Sales Service", status: "Planned", port: 8003, route: "/api/v1/sales" },
    { name: "Finance Service", status: "Operational", port: 8006, route: "/api/v1/finance" },
  ];

  const stats = [
    { label: "Active Tenants", value: "24", change: "+3 this week" },
    { label: "System Uptime", value: "99.98%", change: "Last 30 days" },
    { label: "API Gateway Requests", value: "1.42M", change: "+12.4% vs last mo" },
    { label: "Pending Approvals", value: "5", change: "Requires review" },
  ];

  // One widget per card (the registry is lib/dashboard-widgets.ts); the layout editor shows, hides and orders them for the signed-in Super Admin.
  // The figures are the same static demo values as ever: nothing here is measured, and nothing new is claimed.
  const KPI_IDS = ["admin.kpi.active-tenants", "admin.kpi.system-uptime", "admin.kpi.api-gateway-requests", "admin.kpi.pending-approvals"];
  const nodes: Record<string, React.ReactNode> = {};
  stats.forEach((stat, idx) => {
    nodes[KPI_IDS[idx]] = (
      <div data-accent={idx === 0 ? "yellow" : "neutral"} className="ix-glass ix-glass-sm ix-glass-lift ix-kpi relative p-5" aria-label={stat.label}>
        <p className="text-xs font-medium text-ix-muted">{stat.label}</p>
        <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight text-ix-text">{stat.value}</p>
        <p className="mt-2 text-xs text-ix-accent-text">{stat.change}</p>
      </div>
    );
  });

  // Microservices Cluster Grid
  nodes["admin.panel.microservice-registry"] = (
    <section className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 space-y-4" aria-label="Microservice Registry">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Microservice Registry</h2>
          <p className="text-xs text-slate-400">Overview of configured backend microservices and health endpoints</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-300">
          <thead className="bg-slate-900/80 text-xs uppercase text-slate-400 border-b border-slate-800">
            <tr>
              <th className="px-4 py-3 font-semibold">Service Name</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Default Port</th>
              <th className="px-4 py-3 font-semibold">Route Prefix</th>
              <th className="px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {services.map((svc, idx) => (
              <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                <td className="px-4 py-3 font-medium text-white">{svc.name}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      svc.status === "Operational"
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                    }`}
                  >
                    {svc.status}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">:{svc.port}</td>
                <td className="px-4 py-3 font-mono text-xs text-indigo-300">{svc.route}</td>
                <td className="px-4 py-3">
                  {svc.status === "Operational" ? (
                    <a
                      href={`${svc.route}/health`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      Ping Health
                    </a>
                  ) : (
                    <span className="text-xs text-slate-500">Scheduled</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  // Quick Links & Info
  nodes["admin.panel.docker-compose"] = (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <h3 className="text-sm font-semibold text-white">Docker Compose Stack</h3>
      <p className="text-xs text-slate-400 leading-relaxed">
        Run <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300">docker compose up --build</code> from the root folder to start NGINX Reverse Gateway, Auth Service, Organization Service, and the Super Admin frontend concurrently.
      </p>
    </div>
  );
  nodes["admin.panel.api-documentation"] = (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <h3 className="text-sm font-semibold text-white">API Documentation</h3>
      <p className="text-xs text-slate-400 leading-relaxed">
        FastAPI Swagger interactive docs are accessible via:
        <br />
        • Auth Service: <code className="bg-slate-800 px-1 py-0.5 rounded text-indigo-300">http://localhost:8000/docs</code>
        <br />
        • Organization Service: <code className="bg-slate-800 px-1 py-0.5 rounded text-indigo-300">http://localhost:8001/docs</code>
      </p>
    </div>
  );

  return (
    <PortalShell user={user} current="dashboard" supportUnread={supportUnread}>
      <DashboardLayoutEditor nodes={nodes} />
    </PortalShell>
  );
}
