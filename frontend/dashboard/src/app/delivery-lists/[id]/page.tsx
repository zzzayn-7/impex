import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDeliveryList } from "@/lib/sales";
import { UUID_RE } from "@/lib/stock-validation";
import { getTenantToken, requireTenantAdmin } from "@/lib/tenant-session";
import DeliveryListDetail from "./delivery-list-detail";

export const metadata: Metadata = {
  title: "Delivery List | Impex Organization Portal",
};

// The list comes from the URL, but whose list it is is decided by the Sales Service from the session: another
// organization's list answers "not found", exactly like an id that does not exist.
export default async function DeliveryListPage({ params }: { params: { id: string } }) {
  await requireTenantAdmin(); // the layout already redirects invalid sessions; this keeps the page safe on its own too
  const back = <Link href="/delivery-lists" className="text-xs text-indigo-300 hover:text-indigo-200">← All delivery lists</Link>;
  if (!UUID_RE.test(params.id)) return <Missing back={back} />;

  const result = await getDeliveryList(getTenantToken() ?? "", params.id);
  if (!result.ok) {
    if (result.reason === "unauthorized") redirect("/login");
    if (result.reason === "not-found") return <Missing back={back} />;
    return (
      <div className="space-y-4">
        {back}
        <div role="alert" className="rounded-lg border border-slate-700 bg-slate-950/50 px-4 py-3 text-sm text-slate-300">
          {result.reason === "forbidden"
            ? "Your organization is currently inactive or unavailable, so delivery lists cannot be used. Please contact your platform administrator."
            : "This delivery list is temporarily unavailable. Please refresh in a moment."}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {back}
      <DeliveryListDetail list={result.list} />
    </div>
  );
}

function Missing({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {back}
      <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">Delivery list not found.</p>
    </div>
  );
}
