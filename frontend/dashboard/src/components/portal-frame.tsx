import PortalHeader from "@/components/portal-header";
import { requireTenantAdmin } from "@/lib/tenant-session";

type Current = Parameters<typeof PortalHeader>[0]["current"];

// The protected frame shared by the inventory pages (Products, Warehouses, Stock, Movements). The session check
// runs in the layout, BEFORE the page starts streaming its loading skeleton, so an invalid or missing session is
// a true HTTP redirect to /login, and the header (navigation, sign-out) stays around the page and its loading state.
export default async function PortalFrame({ current, children }: { current: Current; children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current={current} />
      <main className="flex-1 p-4 sm:p-8 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}
