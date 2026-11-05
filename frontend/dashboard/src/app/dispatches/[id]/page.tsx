import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDispatch } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DispatchDetailView from "./dispatch-detail";

export const metadata: Metadata = {
  title: "Dispatch | Impex Organization Portal",
};

// Another organization's dispatch answers "not found", exactly like an id that does not exist.
export default async function DispatchPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/dispatches" className="text-xs text-indigo-300 hover:text-indigo-200">← All dispatches</Link>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;
  const result = await getDispatch(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so dispatches cannot be used. Please contact your platform administrator." : "This dispatch is temporarily unavailable. Please refresh in a moment."}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {back}
      <DispatchDetailView dispatch={result.dispatch} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Dispatch not found.</p>
    </div>
  );
}
