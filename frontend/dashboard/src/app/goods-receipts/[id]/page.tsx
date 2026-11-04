import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getGoodsReceipt } from "@/lib/purchasing";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import ReceiptDetailView from "./receipt-detail";

export const metadata: Metadata = {
  title: "Goods Receipt | Impex Organization Portal",
};

// Another organization's receipt answers "not found", exactly like an id that does not exist.
export default async function GoodsReceiptPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin();
  const back = <Link href="/goods-receipts" className="text-xs text-indigo-300 hover:text-indigo-200">← All goods receipts</Link>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;
  const result = await getGoodsReceipt(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {result.reason === "forbidden" ? "Your organization is currently inactive or unavailable, so goods receipts cannot be used. Please contact your platform administrator." : "This goods receipt is temporarily unavailable. Please refresh in a moment."}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {back}
      <ReceiptDetailView receipt={result.receipt} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Goods receipt not found.</p>
    </div>
  );
}
