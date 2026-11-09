import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { loadCodes } from "@/lib/inventory";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import CodesManager from "./codes-manager";

export const metadata: Metadata = {
  title: "Codes & labels | Impex Organization Portal",
};

// The product comes from the URL, but whose product it is is decided by the Inventory Service from the session:
// another organization's product id answers "not found", exactly like an id that does not exist.
export default async function ProductCodesPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin(); // the products layout already redirects invalid sessions; this keeps the page safe on its own too
  const back = (
    <Link href="/stock" className="text-xs text-indigo-300 hover:text-indigo-200 print:hidden">← Back to stock</Link>
  );
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;

  const data = await loadCodes(getTenantToken() ?? "", params.id);
  if (!data.ok) {
    if (data.reason === "unauthorized") redirect("/login");
    if (data.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {data.reason === "forbidden"
            ? "Your organization is currently inactive or unavailable, so codes cannot be used. Please contact your platform administrator."
            : "Codes are temporarily unavailable. Please refresh in a moment."}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {back}
      <CodesManager product={data.product} identifiers={data.identifiers} label={data.label} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Product not found.</p>
    </div>
  );
}
