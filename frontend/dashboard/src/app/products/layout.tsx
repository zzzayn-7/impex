import PortalHeader from "@/components/portal-header";
import { requireTenantAdmin } from "@/lib/tenant-session";

// The session check lives in the layout, which runs BEFORE the page starts streaming (the loading skeleton).
// That makes an invalid or missing session a true HTTP redirect to /login instead of a client-side one, and
// keeps the header (with navigation and sign-out) around the page and its loading state.
export default async function ProductsLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireTenantAdmin();
  return (
    <div className="flex min-h-screen flex-col">
      <PortalHeader admin={admin} current="products" />
      <main className="flex-1 p-8 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}
